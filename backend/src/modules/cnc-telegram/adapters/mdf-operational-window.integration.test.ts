import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PgCncTelegramRepository, loadMdfBathColumnAutomationState } from './pg-cnc-telegram-repository';
import { loadMdfLaminatedBathAutomationRows } from '../../production-actions/adapters/pg-production-action-repository';
import type { TransactionClient } from '../../../database/database.types';

// Opt-in, single connection. All fixtures live ONLY in session-local pg_temp
// tables; public data is never inserted, changed, or deleted by these tests.
const enabled = process.env.MDF_PROJECTION_INTEGRATION === '1';
const tables = [
  'cut_job', 'cut_result', 'cut_result_board_projection', 'cut_result_label_map_projection',
  'cut_result_archive_state', 'cut_result_placement', 'cut_result_sheet_map',
  'orders', 'order_details', 'production_statuses', 'cnc_telegram_packets',
  'cnc_telegram_packet_items', 'cnc_telegram_packet_whole_order_keys',
  'mdf_board_manual_moves', 'bazis_cut_sets', 'bazis_cut_set_details',
  'order_statuses', 'app_settings', 'cut_param_profiles', 'outbox_events',
] as const;

describe.skipIf(!enabled)('MDF month actual PostgreSQL queries (temporary fixtures)', () => {
  const client = new Client({
    host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
    database: process.env.PG_DB, user: process.env.PG_USER, password: process.env.PG_PASSWORD,
    connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=15000 -c lock_timeout=3000 -c max_parallel_workers_per_gather=0',
  });
  const repository = new PgCncTelegramRepository({
    query: async (sql: string, params: unknown[]) => sql.includes('WITH laminated_status_threshold')
      ? client.query(sql, params) : { rows: [] },
  } as never);

  beforeAll(async () => {
    await client.connect();
    await client.query("SET search_path=pg_temp,public; SET TIME ZONE 'Asia/Almaty'");
    for (const table of tables) {
      await client.query(`CREATE TEMP TABLE ${table} AS TABLE public.${table} WITH NO DATA`);
    }
    await client.query(`
      ALTER TABLE pg_temp.cut_result_board_projection ADD PRIMARY KEY(cut_result_id);
      CREATE TRIGGER project_header AFTER INSERT ON pg_temp.cut_result
        FOR EACH ROW EXECUTE FUNCTION public.project_new_cut_result_board_metadata();
      CREATE TRIGGER guard_header BEFORE INSERT OR UPDATE OR DELETE ON pg_temp.cut_result_board_projection
        FOR EACH ROW EXECUTE FUNCTION public.guard_cut_result_board_projection();
    `);
  }, 20_000);
  afterAll(async () => { await client.end(); });
  beforeEach(async () => {
    // Explicit, owned temporary targets only. Closing the connection also cleans up.
    await client.query(`TRUNCATE ${tables.map((table) => `pg_temp.${table}`).join(',')}`);
    await client.query(`
      INSERT INTO pg_temp.production_statuses(production_status_id,production_status_code,production_status_name,sort_order)
        VALUES(1,'packed','Упакован',30),(2,'laminated','Закатан',20),(3,'issued','Выдан',40);
      INSERT INTO pg_temp.orders(order_id,order_name,order_kind,delete_flag)
        VALUES(1,'E2E-Тест 1','production_order',false),(2,'E2E-Тест 2','production_order',false);
      INSERT INTO pg_temp.order_details(detail_id,order_id,detail_number,production_status_id,delete_flag)
        VALUES(1,1,1,1,false),(2,2,2,2,false),(3,1,3,NULL,false),(4,1,4,3,false);
      INSERT INTO pg_temp.cnc_telegram_packets(packet_id,workday,completion_status,thumbs_up,material_name)
        VALUES('00000000-0000-0000-0000-000000000001','2026-09-06','completed',false,'МДФ 10мм');
      INSERT INTO pg_temp.cnc_telegram_packet_items(packet_id,match_order_id,match_detail_id,quantity)
        VALUES('00000000-0000-0000-0000-000000000001',1,1,100);
    `);
  });

  async function seed(id: number, details: Array<number | null>, createdAt = '2026-07-20T12:00:00+05',
    job = id, snapshot: Record<string, unknown> = { isVacuum: true }) {
    await client.query(`INSERT INTO pg_temp.cut_job(cut_job_id,status,current_cut_result_id,name,params)
      SELECT $1,'completed',$2,'E2E-Тест','{"layout_mode":"vacuum_table"}'::jsonb
      WHERE NOT EXISTS(SELECT 1 FROM pg_temp.cut_job WHERE cut_job_id=$1)`, [job, id]);
    await client.query(`INSERT INTO pg_temp.cut_result(cut_result_id,cut_job_id,result_no,revision_no,created_at,snapshot_digest,snapshot_job)
      VALUES($1::bigint,$2,$1::integer,1,$3,$4,$5::jsonb)`, [id, job, createdAt, `test-${id}`, JSON.stringify({
      name: 'E2E-Тест снимок', groups: [{ summary: { engine_used: 'vacuum_table' } }], ...snapshot,
    })]);
    await client.query('UPDATE pg_temp.cut_job SET current_cut_result_id=$2 WHERE cut_job_id=$1', [job, id]);
    await client.query(`INSERT INTO pg_temp.cut_result_label_map_projection(cut_result_id,snapshot_digest)
      VALUES($1,$2)`, [id, `test-${id}`]);
    await client.query(`INSERT INTO pg_temp.cut_result_sheet_map(cut_result_sheet_map_id,cut_result_id,
      cut_job_id,cut_group_id,variant,sheet_index,sheet_ordinal,is_effective,sheet_width_mm,sheet_height_mm)
      VALUES($1,$1,$2,$1,'auto',0,1,true,100,200)`, [id, job]);
    for (const [index, detail] of details.entries()) {
      await client.query(`INSERT INTO pg_temp.cut_result_placement(cut_result_id,cut_result_sheet_map_id,
        order_id,order_detail_id,instance,variant,detail_width_mm,detail_height_mm)
        VALUES($1,$1,$2,$3,$4,'auto',10,20)`, [id, detail === 2 ? 2 : 1, detail, index + 1]);
    }
  }
  async function load(focusBathCardId?: string, month = true) {
    return repository.listToday({ currentUser: {} as never, workdayFrom: '2026-08-07', workdayTo: '2026-09-06',
      ...(month ? { operationalWindow: 'month' as const } : {}), focusBathCardId });
  }
  const ids = (response: Awaited<ReturnType<typeof load>>) => response.columns.flatMap((column) => column.baths.map((bath) => bath.cutResultId));

  async function expectAllReadiness(ready: boolean) {
    const response = await load();
    expect(response.columns.flatMap((column) => column.baths).find((bath) => bath.cutResultId === 1)?.ready).toBe(ready);
    const state = await loadMdfBathColumnAutomationState(client as unknown as TransactionClient, 1);
    expect(state).not.toBeNull();
    expect(state?.column !== 'baths').toBe(ready);
    const laminated = await loadMdfLaminatedBathAutomationRows(client as unknown as TransactionClient, [1]);
    expect(laminated.length > 0).toBe(ready);
  }

  async function addBasis(quantity: number, target = 'completed', material = 'МДФ 18мм') {
    await client.query(`INSERT INTO pg_temp.bazis_cut_sets(bazis_cut_set_id,name,created_at)
      VALUES(1,'E2E-БАЗИС','2026-09-06T12:00:00+05')`);
    await client.query(`INSERT INTO pg_temp.mdf_board_manual_moves(card_kind,card_id,target_column)
      VALUES('bazisCutSet','1',$1)`, [target]);
    await client.query(`INSERT INTO pg_temp.bazis_cut_set_details(bazis_cut_set_detail_id,
      bazis_cut_set_id,source_order_id,source_order_detail_id,quantity,material_name)
      VALUES(1,1,1,1,$1,$2)`, [quantity, material]);
  }

  it('counts a manually cut pending file without changing actual completion', async () => {
    await seed(1, [1, 1], '2026-09-06T12:00:00+05');
    await client.query(`UPDATE pg_temp.order_details SET production_status_id=2 WHERE detail_id=1;
      UPDATE pg_temp.cnc_telegram_packets SET completion_status='pending';
      INSERT INTO pg_temp.mdf_board_manual_moves(card_kind,card_id,target_column)
      VALUES('packet','00000000-0000-0000-0000-000000000001','completed')`);
    await expectAllReadiness(true);
  });

  it('discovers and completes a BASIS-only bath', async () => {
    await seed(1, [1, 1], '2026-09-06T12:00:00+05');
    await client.query('TRUNCATE pg_temp.cnc_telegram_packets, pg_temp.cnc_telegram_packet_items');
    await addBasis(2);
    const response = await load();
    expect(ids(response)).toContain(1);
    expect(response.columns.flatMap((column) => column.baths)[0]?.ready).toBe(true);
    await expectAllReadiness(true);
  });

  it('does not double-count overlapping CNC and BASIS quantities', async () => {
    await seed(1, [1, 1], '2026-09-06T12:00:00+05');
    await client.query('UPDATE pg_temp.cnc_telegram_packet_items SET quantity=1');
    await addBasis(1);
    await expectAllReadiness(false);
  });

  it('respects a manual return to parsed unless the file is automatically terminal', async () => {
    await seed(1, [1, 1], '2026-09-06T12:00:00+05');
    await client.query(`UPDATE pg_temp.order_details SET production_status_id=2 WHERE detail_id=1;
      INSERT INTO pg_temp.mdf_board_manual_moves(card_kind,card_id,target_column)
      VALUES('packet','00000000-0000-0000-0000-000000000001','parsed')`);
    await expectAllReadiness(false);
    await client.query('UPDATE pg_temp.order_details SET production_status_id=1 WHERE detail_id=1');
    await expectAllReadiness(true);
  });

  it.each([
    ['parsed', 2, 'МДФ 10мм', false],
    ['completed', 1, 'МДФ 10мм', false],
    ['completed', 2, 'Фанера 18мм', false],
    ['completed_laminated', 2, 'new-MDF-type', true],
  ] as const)('BASIS %s quantity %i material %s', async (target, quantity, material, ready) => {
    await seed(1, [1, 1], '2026-09-06T12:00:00+05');
    await client.query(`TRUNCATE pg_temp.cnc_telegram_packets, pg_temp.cnc_telegram_packet_items;
      UPDATE pg_temp.order_details SET production_status_id=2 WHERE detail_id=1`);
    await addBasis(quantity, target, material);
    await expectAllReadiness(ready);
  });

  it('classifies the whole BASIS set before filtering to the bath details', async () => {
    await seed(1, [1], '2026-09-06T12:00:00+05');
    await client.query('TRUNCATE pg_temp.cnc_telegram_packets, pg_temp.cnc_telegram_packet_items');
    await addBasis(1, 'parsed');
    await client.query(`INSERT INTO pg_temp.bazis_cut_set_details(bazis_cut_set_id,source_order_id,source_order_detail_id,quantity,material_name)
      VALUES(1,2,2,1,'МДФ 18мм')`);
    await expectAllReadiness(false); // packed bath detail cannot hide the other, unpacked member
    await client.query('UPDATE pg_temp.order_details SET production_status_id=1 WHERE detail_id=2');
    await expectAllReadiness(true); // full terminal set wins over stale manual parsed
    await client.query('UPDATE pg_temp.bazis_cut_set_details SET source_order_detail_id=999 WHERE source_order_id=2');
    await expectAllReadiness(false); // unresolved non-bath member also blocks terminal
  });

  it.each([
    { productionStatusIds: [2], orderStatusIds: [] },
    { cardRules: [{ cardKind: 'bazisCutSet', orderStatusIds: [6] }] },
  ])('counts BASIS terminal placement from stored hidden-status settings: %j', async (setting) => {
    await seed(1, [1], '2026-09-06T12:00:00+05');
    await client.query(`TRUNCATE pg_temp.cnc_telegram_packets, pg_temp.cnc_telegram_packet_items;
      UPDATE pg_temp.order_details SET production_status_id=2 WHERE detail_id=1;
      UPDATE pg_temp.orders SET production_status_id=2,order_status_id=6 WHERE order_id=1`);
    await addBasis(1, 'parsed');
    await client.query(`INSERT INTO pg_temp.app_settings(setting_key,value_json,is_active)
      VALUES('status_automation.mdf_board_hidden_production_statuses',$1,true)`, [JSON.stringify(setting)]);
    await expectAllReadiness(true);
    await client.query('UPDATE pg_temp.orders SET production_status_id=NULL,order_status_id=NULL WHERE order_id=1');
    await expectAllReadiness(false);
  });

  it('requires the whole file to be issued for the pending-file terminal shortcut', async () => {
    await seed(1, [1], '2026-09-06T12:00:00+05');
    await client.query(`UPDATE pg_temp.order_details SET production_status_id=3 WHERE detail_id=1;
      UPDATE pg_temp.cnc_telegram_packets SET completion_status='pending';
      INSERT INTO pg_temp.cnc_telegram_packet_items(packet_id,match_order_id,match_detail_id,quantity)
      VALUES('00000000-0000-0000-0000-000000000001',2,999,1)`);
    await expectAllReadiness(false);
    await client.query(`UPDATE pg_temp.cnc_telegram_packet_items SET match_detail_id=2 WHERE match_order_id=2;
      UPDATE pg_temp.order_details SET production_status_id=3 WHERE detail_id=2`);
    await expectAllReadiness(true);
  });

  it('expands whole-order chat coverage only after actual completion, never from a manual move', async () => {
    await seed(1, [1, 3], '2026-09-06T12:00:00+05');
    await client.query(`UPDATE pg_temp.order_details SET production_status_id=2 WHERE detail_id IN (1,3);
      UPDATE pg_temp.cnc_telegram_packets SET completion_status='pending';
      INSERT INTO pg_temp.mdf_board_manual_moves(card_kind,card_id,target_column)
        VALUES('packet','00000000-0000-0000-0000-000000000001','completed');
      INSERT INTO pg_temp.cnc_telegram_packet_whole_order_keys(packet_id,order_key)
        VALUES('00000000-0000-0000-0000-000000000001','e2e-тест 1')`);
    await expectAllReadiness(false);
    await client.query("UPDATE pg_temp.cnc_telegram_packets SET completion_status='completed'");
    await expectAllReadiness(true);
  });

  it('resolves a unique OCR fallback by active owner even without an order name', async () => {
    await seed(1, [1], '2026-09-06T12:00:00+05');
    await client.query(`UPDATE pg_temp.order_details SET width=100,height=200 WHERE detail_id=1;
      UPDATE pg_temp.cnc_telegram_packet_items SET match_detail_id=NULL,detail_number=1,
        width_mm=202,height_mm=98,source='ocr'`);
    await expectAllReadiness(true);
    await client.query('UPDATE pg_temp.cnc_telegram_packet_items SET width_mm=204');
    const state = await loadMdfBathColumnAutomationState(client as unknown as TransactionClient, 1);
    expect(state?.column).toBe('baths');
    expect(await loadMdfLaminatedBathAutomationRows(client as unknown as TransactionClient, [1])).toEqual([]);
  });

  it.each([
    "rework=true", "mdf_board_card_kind='bath_seed'", "program_name='2701_fanera18.tap'",
    "source_chat_id='erp-manual-svg-upload',source_version=1",
  ])('does not count ineligible files despite manual completion: %s', async (update) => {
    await seed(1, [1], '2026-09-06T12:00:00+05');
    await client.query(`UPDATE pg_temp.cnc_telegram_packets SET ${update};
      INSERT INTO pg_temp.mdf_board_manual_moves(card_kind,card_id,target_column)
      VALUES('packet','00000000-0000-0000-0000-000000000001','completed')`);
    await expectAllReadiness(false);
  });

  it('keeps month boundary and old unfinished; compacts only complete full compositions', async () => {
    await seed(1, [1, 1]);
    await seed(2, [1, 2]); // second order is not in today's packet: still blocks completion
    await seed(3, [1, 3]); // unknown status
    await seed(4, [1, null]); // unmapped placement
    await seed(5, [1], '2026-08-07T00:00:00+05');
    await seed(6, [1], '2026-08-06T23:59:59+05');
    await seed(7, [1, 4]); // issued is later than packed
    const response = await load();
    expect(ids(response).sort()).toEqual([2, 3, 4, 5]);
    expect(response.historicalBathReadiness?.map((bath) => bath.bathCardId).sort())
      .toEqual(['cut-result:1', 'cut-result:6', 'cut-result:7']);
    expect(response.historicalBathReadiness?.find((bath) => bath.bathCardId === 'cut-result:1')?.items[0].quantity).toBe(2);
    expect(ids(await load(undefined, false))).toHaveLength(7);
  });

  it('focus bypasses age only; hidden, archived and non-vacuum cuts remain excluded', async () => {
    await seed(1, [1]); await seed(2, [1]); await seed(3, [1]);
    await seed(4, [1], undefined, 4, { isVacuum: false });
    await client.query(`INSERT INTO pg_temp.cut_result_archive_state(cut_job_id,result_no,archived_at) VALUES(2,2,now());
      INSERT INTO pg_temp.cnc_telegram_packets(svg_cut_result_id,mdf_board_card_kind,mdf_board_hidden_at)
      VALUES(3,'bath_seed',now())`);
    const focused = await load('cut-result:1');
    expect(ids(focused)).toEqual([1]);
    expect(focused.historicalBathReadiness).toEqual([]);
    for (const id of [2, 3, 4]) expect(ids(await load(`cut-result:${id}`))).not.toContain(id);
  });

  it('does not resurrect an older version when the selected current one is trimmed', async () => {
    await seed(1, [1, 2], undefined, 1);
    await seed(2, [1], undefined, 1);
    const response = await load();
    expect(ids(response)).toEqual([]);
    expect(response.historicalBathReadiness?.map((bath) => bath.bathCardId)).toEqual(['cut-result:2']);
  });

  it('preserves selection among matching results when the newest no longer overlaps', async () => {
    await seed(1, [1, 2], undefined, 1); await seed(2, [2], undefined, 1);
    expect(ids(await load())).toEqual([1]);
  });

  it('projects legacy flags transactionally, rejects malformed flags and guards immutable headers', async () => {
    await seed(1, [1], undefined, 1, {});
    await seed(2, [1], undefined, 2, { isVacuum: null });
    await seed(3, [1], undefined, 3, { isVacuum: false });
    await seed(4, [1], undefined, 4, { isVacuum: 'false' });
    expect((await client.query('SELECT is_vacuum FROM pg_temp.cut_result_board_projection ORDER BY cut_result_id')).rows)
      .toEqual([{ is_vacuum: true }, { is_vacuum: true }, { is_vacuum: false }, { is_vacuum: false }]);
    await client.query('SELECT public.project_cut_result_board_metadata(1)');
    expect((await client.query('SELECT count(*)::int AS n FROM pg_temp.cut_result_board_projection')).rows[0].n).toBe(4);
    await expect(seed(5, [1], undefined, 5, { isVacuum: 'invalid' })).rejects.toThrow('invalid explicit');
    expect((await client.query('SELECT 1 FROM pg_temp.cut_result WHERE cut_result_id=5')).rows).toEqual([]);
    await expect(client.query('UPDATE pg_temp.cut_result_board_projection SET is_vacuum=false WHERE cut_result_id=1')).rejects.toThrow('append-only');
    await expect(client.query('DELETE FROM pg_temp.cut_result_board_projection WHERE cut_result_id=1')).rejects.toThrow('append-only');
  });
});
