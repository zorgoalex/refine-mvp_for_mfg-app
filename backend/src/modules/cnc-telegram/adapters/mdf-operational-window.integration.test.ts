import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PgCncTelegramRepository, loadMdfBathColumnAutomationState } from './pg-cnc-telegram-repository';
import { loadMdfLaminatedBathAutomationRows } from '../../production-actions/adapters/pg-production-action-repository';
import type { TransactionClient } from '../../../database/database.types';
import { loadMdfBoardEvents } from '../../status-automation/adapters/pg-mdf-board-event-repository';
import { dispatchMdfBoardEvent, evaluateAllStatusAutomationRulesForOrder, evaluateStatusAutomation } from '../../status-automation/application/status-automation-runtime';
import type { MdfBoardSource } from '../../status-automation/application/mdf-board-event.types';
import type { CurrentUser } from '../../../permissions/current-user';

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
  'materials', 'sheet_material_types',
  'status_automation_rules', 'audit_log', 'audit_log_related_entity', 'bazis_order_links', 'order_import_entity_map',
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
      ALTER TABLE pg_temp.audit_log ALTER COLUMN audit_id SET DEFAULT gen_random_uuid();
      CREATE UNIQUE INDEX test_mdf_outbox_key ON pg_temp.outbox_events(idempotency_key);
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

  const sourcePacket = { kind: 'packet' as const, id: '00000000-0000-0000-0000-000000000001' };
  const eventsFor = (source = sourcePacket as { kind: 'packet' | 'bazisCutSet' | 'bath'; id: string }) =>
    loadMdfBoardEvents(client as unknown as TransactionClient, source);

  it.each([false, true])('scopes the event to the file position, pending=%s, preserving full-quantity evidence', async pending => {
    await client.query(`UPDATE pg_temp.order_details SET quantity=10,production_status_id=NULL WHERE detail_id=1;
      UPDATE pg_temp.cnc_telegram_packet_items SET quantity=4;`);
    await client.query('UPDATE pg_temp.cnc_telegram_packets SET completion_status=$1', [pending ? 'pending' : 'completed']);
    const events = await eventsFor();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ eventType: pending ? 'mdf.order_machine_files_present' : 'mdf.board.completed', orderId: 1,
      scope: { source: sourcePacket, details: [{ detailId: 1, requiredQuantity: 10, eligibleQuantity: 4 }] } });
  });

  it('combines manual CNC and BASIS portions without expanding candidate membership', async () => {
    await client.query(`UPDATE pg_temp.order_details SET quantity=10,production_status_id=NULL WHERE detail_id=1;
      UPDATE pg_temp.cnc_telegram_packet_items SET quantity=4;
      UPDATE pg_temp.cnc_telegram_packets SET completion_status='pending';
      INSERT INTO pg_temp.mdf_board_manual_moves(card_kind,card_id,target_column)
        VALUES('packet','00000000-0000-0000-0000-000000000001','completed');
      INSERT INTO pg_temp.cnc_telegram_packets(packet_id,completion_status,material_name)
        VALUES('00000000-0000-0000-0000-000000000002','completed','МДФ 16');
      INSERT INTO pg_temp.cnc_telegram_packet_items(packet_id,match_order_id,match_detail_id,quantity)
        VALUES('00000000-0000-0000-0000-000000000002',1,1,3),
          ('00000000-0000-0000-0000-000000000002',1,3,20);`);
    await addBasis(3);
    const [event] = await eventsFor();
    expect(event.scope.details).toEqual([{ detailId: 1, requiredQuantity: 10, eligibleQuantity: 10 }]);
    const [basis] = await eventsFor({ kind: 'bazisCutSet', id: '1' });
    expect(basis.eventType).toBe('mdf.board.completed');
    expect(basis.scope.details).toEqual(event.scope.details);
  });

  it.each(['baths', 'baths_ready', 'baths_laminated'] as const)('resolves %s from real bath state and sums partial bath quantities', async column => {
    await client.query(`UPDATE pg_temp.order_details SET production_status_id=NULL,quantity=3 WHERE detail_id=1`);
    await seed(1, [1], '2026-09-06T12:00:00+05');
    await seed(2, [1, 1], '2026-07-06T12:00:00+05');
    await client.query(`INSERT INTO pg_temp.mdf_board_manual_moves(card_kind,card_id,target_column)
      VALUES('bath','cut-result:1',$1),('bath','cut-result:2',$1)`, [column]);
    const events = await eventsFor({ kind: 'bath', id: 'cut-result:1' });
    expect(events).toEqual([{ eventType: `mdf.board.${column}`, orderId: 1,
      scope: { source: { kind: 'bath', id: 'cut-result:1' },
        details: [{ detailId: 1, requiredQuantity: 3, eligibleQuantity: 3 }] } }]);
  });

  it('uses only current effective bath sheets, excluding old revisions and unresolved identities', async () => {
    await client.query(`UPDATE pg_temp.order_details SET production_status_id=NULL,quantity=3 WHERE detail_id=1`);
    await seed(1, [1, 1, 1], '2026-09-05T12:00:00+05', 1);
    await seed(2, [1], '2026-09-06T12:00:00+05', 1);
    await seed(3, [1, 1], '2026-09-06T12:00:00+05', 3);
    await client.query('UPDATE pg_temp.cut_result_sheet_map SET is_effective=false WHERE cut_result_id=3');
    expect(await eventsFor({ kind: 'bath', id: 'cut-result:1' })).toEqual([]);
    const [event] = await eventsFor({ kind: 'bath', id: 'cut-result:2' });
    expect(event.scope.details).toEqual([{ detailId: 1, requiredQuantity: 3, eligibleQuantity: 1 }]);
  });

  it.each(['rework', 'material', 'deleted', 'mismatch'] as const)('fails closed for invalid source membership: %s', async problem => {
    if (problem === 'rework') await client.query('UPDATE pg_temp.cnc_telegram_packets SET rework=true');
    if (problem === 'material') await client.query("UPDATE pg_temp.cnc_telegram_packets SET program_name='fanera_18.nc'");
    if (problem === 'deleted') await client.query('UPDATE pg_temp.order_details SET delete_flag=true WHERE detail_id=1');
    if (problem === 'mismatch') await client.query('UPDATE pg_temp.cnc_telegram_packet_items SET match_order_id=2');
    expect(await eventsFor()).toEqual([]);
  });

  it('does not expand ordinary card scope through a whole-order chat marker', async () => {
    await client.query(`INSERT INTO pg_temp.cnc_telegram_packet_whole_order_keys(packet_id,order_key)
      VALUES('00000000-0000-0000-0000-000000000001','e2e-тест 1')`);
    const [event] = await eventsFor();
    expect(event.scope.details.map(d => d.detailId)).toEqual([1]);
  });

  it('executes a real scoped batch, preserves partial/unrelated/advanced positions and manual moves, then replays without effects', async () => {
    const previousFlag = process.env.BACKEND_STATUS_AUTOMATION;
    process.env.BACKEND_STATUS_AUTOMATION = 'true';
    await client.query('BEGIN');
    try {
      await client.query(`UPDATE pg_temp.orders SET version=1,order_status_id=4,payment_status_id=1;
        UPDATE pg_temp.order_details SET quantity=10,production_status_id=NULL WHERE detail_id=1;
        UPDATE pg_temp.cnc_telegram_packet_items SET quantity=4;
        INSERT INTO pg_temp.cnc_telegram_packet_items(packet_id,match_order_id,match_detail_id,quantity)
          VALUES('00000000-0000-0000-0000-000000000001',2,2,1);
        INSERT INTO pg_temp.production_statuses(production_status_id,production_status_code,production_status_name,sort_order,is_active)
          VALUES(4,'cut','Распилен',10,true);
        INSERT INTO pg_temp.status_automation_rules(id,name,event_type,action_type,target_status_id,conditions_json,
          priority,is_enabled,version,action_config_json)
          VALUES(901,'E2E scoped','mdf.board.completed','change_details_production_status',4,'{}',100,true,1,'{"detailTransitionMode":"set_exact"}');
        INSERT INTO pg_temp.mdf_board_manual_moves(card_kind,card_id,target_column)
          VALUES('packet','00000000-0000-0000-0000-000000000001','completed'),('bath','cut-result:999','baths');`);
      const tx = { raw: client, query: (sql: string, params: unknown[]) =>
        // The production aggregate function has its own regression suite. Never
        // execute public stored-function code from this isolated writer fixture.
        sql.trim().startsWith('SELECT recalc_order_production_status')
          ? client.query('SELECT 1') : client.query(sql, params),
      } as unknown as TransactionClient;
      const input = { source: sourcePacket, actor: { id: '3', username: 'E2E', role: 'admin', permissions: [] } as never,
        requestId: 'E2E-scoped', sourceIdempotencyKey: 'E2E-scoped' };
      await dispatchMdfBoardEvent(tx, input);
      expect((await client.query('SELECT production_status_id FROM pg_temp.order_details WHERE detail_id=1')).rows[0].production_status_id).toBeNull();
      await addBasis(6);
      await dispatchMdfBoardEvent(tx, input);
      const beforeReplay = (await client.query('SELECT detail_id,production_status_id FROM pg_temp.order_details ORDER BY detail_id')).rows;
      expect(beforeReplay.map(r => [Number(r.detail_id), Number(r.production_status_id) || null])).toEqual([
        [1,4], [2,2], [3,null], [4,3],
      ]);
      const count = async (table: 'outbox_events' | 'mdf_board_manual_moves') =>
        Number((await client.query(`SELECT COUNT(*) FROM pg_temp.${table}`)).rows[0].count);
      expect(await count('mdf_board_manual_moves')).toBe(3);
      const outbox = await count('outbox_events');
      await dispatchMdfBoardEvent(tx, input);
      expect(await count('outbox_events')).toBe(outbox);
      expect((await client.query('SELECT detail_id,production_status_id FROM pg_temp.order_details ORDER BY detail_id')).rows).toEqual(beforeReplay);
      expect(await count('mdf_board_manual_moves')).toBe(3);
      const audits = await client.query(`SELECT metadata_json FROM pg_temp.audit_log WHERE event='orders.detail_production_status_batch_change'`);
      expect(audits.rows).toHaveLength(1);
      expect(audits.rows[0].metadata_json).toMatchObject({ changedDetailIds: [1], mdfBoardScope: { source: sourcePacket } });
    } finally {
      await client.query('ROLLBACK');
      if (previousFlag === undefined) delete process.env.BACKEND_STATUS_AUTOMATION;
      else process.env.BACKEND_STATUS_AUTOMATION = previousFlag;
    }
    expect((await client.query('SELECT production_status_id FROM pg_temp.order_details WHERE detail_id=1')).rows[0].production_status_id).toBe(1);
  });

  describe('enabled stage MDF rules 16/17 (configuration captured 2026-09-08)', () => {
    const rules = [
      { id: 16, event_type: 'mdf.board.baths_laminated', target_status_id: 6,
        conditions_json: { currentOrderStatusNotIn: [8], currentProductionStatusNotIn: [22] } },
      { id: 17, event_type: 'mdf.board.completed', target_status_id: 2,
        conditions_json: { currentOrderStatusIn: [1, 2, 3, 4], currentOrderStatusNotIn: [6, 7, 8],
          currentProductionStatusNotIn: [7, 8, 22] } },
    ].map(rule => ({ ...rule, action_type: 'change_details_production_status', priority: 100,
      is_enabled: true, action_config_json: { detailTransitionMode: 'advance_only' } }));
    const actor: CurrentUser = { id: '3', username: 'E2E-Test', role: 'admin', roleId: 1, permissions: [] };
    let previousFlag: string | undefined;
    const tx = { raw: client, query: (sql: string, params: unknown[]) =>
      // Deliberately exclude the public stored aggregate function: its internals
      // are not guaranteed to honor pg_temp. This suite tests resolver -> rule
      // conditions -> actual detail UPDATE/audit/outbox, not DB trigger cascades.
      sql.trim().startsWith('SELECT recalc_order_production_status')
        ? client.query('SELECT 1') : client.query(sql, params),
    } as unknown as TransactionClient;
    const dispatch = (source: MdfBoardSource = sourcePacket, key = 'E2E-enabled-rule') =>
      dispatchMdfBoardEvent(tx, { source, actor, requestId: key, sourceIdempotencyKey: key });
    const statuses = async () => (await client.query(`SELECT detail_id,production_status_id
      FROM pg_temp.order_details ORDER BY detail_id`)).rows.map(row => [Number(row.detail_id), row.production_status_id]);
    const effects = async () => ({
      statuses: await statuses(),
      orders: (await client.query('SELECT order_id,order_status_id,version FROM pg_temp.orders ORDER BY order_id')).rows,
      commands: (await client.query(`SELECT audit_id FROM pg_temp.audit_log
        WHERE event='orders.detail_production_status_batch_change' ORDER BY audit_id`)).rows,
      outbox: (await client.query('SELECT idempotency_key FROM pg_temp.outbox_events ORDER BY idempotency_key')).rows,
      moves: (await client.query('SELECT card_kind,card_id,target_column FROM pg_temp.mdf_board_manual_moves ORDER BY card_kind,card_id')).rows,
    });

    beforeEach(async () => {
      previousFlag = process.env.BACKEND_STATUS_AUTOMATION;
      process.env.BACKEND_STATUS_AUTOMATION = 'true';
      await client.query('BEGIN');
      await client.query(`TRUNCATE pg_temp.production_statuses;
        INSERT INTO pg_temp.production_statuses(production_status_id,production_status_code,production_status_name,sort_order,is_active)
          VALUES(16,'new','Новый',5,true),(2,'cut','Распилен',20,true),(6,'laminated','Закатан',70,true),
            (7,'packed','Упакован',80,true),(8,'issued','Выдан',90,true),(22,'finished','Завершено',100,true);
        UPDATE pg_temp.orders SET order_status_id=4,production_status_id=16,payment_status_id=1,version=1;
        UPDATE pg_temp.order_details SET quantity=1,production_status_id=16;
        UPDATE pg_temp.cnc_telegram_packets SET completion_status='pending';
        UPDATE pg_temp.cnc_telegram_packet_items SET quantity=1;
        INSERT INTO pg_temp.mdf_board_manual_moves(card_kind,card_id,target_column)
          VALUES('packet','00000000-0000-0000-0000-000000000001','completed');`);
      for (const rule of rules) await client.query(`INSERT INTO pg_temp.status_automation_rules
        (id,name,event_type,action_type,target_status_id,conditions_json,priority,is_enabled,version,action_config_json)
        VALUES($1,$2,$3,$4,$5,$6,100,true,3,$7)`, [rule.id, `E2E-Test rule ${rule.id}`, rule.event_type,
        rule.action_type, rule.target_status_id, JSON.stringify(rule.conditions_json), JSON.stringify(rule.action_config_json)]);
    });
    afterEach(async () => {
      try { await client.query('ROLLBACK'); }
      finally {
        if (previousFlag === undefined) delete process.env.BACKEND_STATUS_AUTOMATION;
        else process.env.BACKEND_STATUS_AUTOMATION = previousFlag;
      }
    });

    it.skipIf(process.env.MDF_STAGE_RULES_VERIFY !== '1')('matches the currently enabled public stage rules without modifying them', async () => {
      const live = await client.query(`SELECT id,event_type,action_type,target_status_id,conditions_json,
        priority,is_enabled,action_config_json FROM public.status_automation_rules
        WHERE event_type LIKE 'mdf.%' AND is_enabled=true ORDER BY id`);
      expect(live.rows.map(row => ({ ...row, id: Number(row.id), target_status_id: Number(row.target_status_id) }))).toEqual(rules);
    });

    it.each([1, 2, 3, 4])('rule17 applies for allowed order status %i, only to the source position', async orderStatus => {
      await client.query('UPDATE pg_temp.orders SET order_status_id=$1 WHERE order_id=1', [orderStatus]);
      await dispatch();
      expect(await statuses()).toEqual([[1, 2], [2, 16], [3, 16], [4, 16]]);
      const result = await effects();
      expect(result.orders.map(row => [Number(row.order_id), row.order_status_id, Number(row.version)]))
        .toEqual([[1, orderStatus, 2], [2, 4, 1]]);
      expect(result.commands).toHaveLength(1);
      expect(result.outbox).toHaveLength(1);
      expect(result.moves).toHaveLength(1);
      expect((await client.query('SELECT completion_status FROM pg_temp.cnc_telegram_packets')).rows[0].completion_status).toBe('pending');
    });

    it.each([5, 6, 7, 8])('rule17 blocks order status %i even when file quantity is complete', async orderStatus => {
      await client.query('UPDATE pg_temp.orders SET order_status_id=$1 WHERE order_id=1', [orderStatus]);
      const before = await effects();
      await dispatch();
      expect(await effects()).toEqual(before);
    });

    it.each([7, 8, 22])('rule17 checks order-level production exclusion %i, not the candidate detail status', async productionStatus => {
      await client.query('UPDATE pg_temp.orders SET production_status_id=$1 WHERE order_id=1', [productionStatus]);
      const before = await effects();
      await dispatch();
      expect(await effects()).toEqual(before);
    });

    it.each(['packet', 'bazisCutSet'] as const)('rule17 waits for 4 CNC + 3 CNC + 3 BASIS, triggered by %s', async kind => {
      await client.query(`UPDATE pg_temp.order_details SET quantity=10 WHERE detail_id=1;
        UPDATE pg_temp.cnc_telegram_packet_items SET quantity=4;
        INSERT INTO pg_temp.cnc_telegram_packets(packet_id,completion_status,material_name)
          VALUES('00000000-0000-0000-0000-000000000002','completed','MDF 10mm');
        INSERT INTO pg_temp.cnc_telegram_packet_items(packet_id,match_order_id,match_detail_id,quantity)
          VALUES('00000000-0000-0000-0000-000000000002',1,1,3),
            ('00000000-0000-0000-0000-000000000002',1,3,1);`);
      await addBasis(2);
      const source = kind === 'packet' ? sourcePacket : { kind, id: '1' };
      await dispatch(source, 'E2E-partial');
      expect(await statuses()).toEqual([[1, 16], [2, 16], [3, 16], [4, 16]]);
      expect((await effects()).commands).toHaveLength(0);
      await client.query('UPDATE pg_temp.bazis_cut_set_details SET quantity=3');
      await dispatch(source, 'E2E-full');
      expect(await statuses()).toEqual([[1, 2], [2, 16], [3, 16], [4, 16]]);
    });

    async function bathSource() {
      await seed(1, [1], '2026-09-06T12:00:00+05');
      await client.query(`INSERT INTO pg_temp.mdf_board_manual_moves(card_kind,card_id,target_column)
        VALUES('bath','cut-result:1','baths_laminated')`);
      return { kind: 'bath' as const, id: 'cut-result:1' };
    }

    it.each([1, 4, 6, 7])('rule16 permits order status %i and changes only bath members', async orderStatus => {
      await client.query('UPDATE pg_temp.orders SET order_status_id=$1 WHERE order_id=1', [orderStatus]);
      await dispatch(await bathSource());
      expect(await statuses()).toEqual([[1, 6], [2, 16], [3, 16], [4, 16]]);
      expect((await effects()).orders[0].order_status_id).toBe(orderStatus);
    });

    it.each(['order8', 'production22'])('rule16 blocks its configured exclusion %s', async exclusion => {
      await client.query(exclusion === 'order8'
        ? 'UPDATE pg_temp.orders SET order_status_id=8 WHERE order_id=1'
        : 'UPDATE pg_temp.orders SET production_status_id=22 WHERE order_id=1');
      const source = await bathSource();
      const before = await effects();
      await dispatch(source);
      expect(await effects()).toEqual(before);
    });

    it('rule16 waits for all three instances across two baths, including an old bath', async () => {
      await client.query('UPDATE pg_temp.order_details SET quantity=3 WHERE detail_id=1');
      const source = await bathSource();
      await seed(2, [1, 1], '2026-07-06T12:00:00+05');
      await client.query(`INSERT INTO pg_temp.mdf_board_manual_moves(card_kind,card_id,target_column)
        VALUES('bath','cut-result:2','baths_ready')`);
      await dispatch(source, 'E2E-one-of-three');
      expect((await statuses())[0]).toEqual([1, 16]);
      await client.query(`UPDATE pg_temp.mdf_board_manual_moves SET target_column='baths_laminated'
        WHERE card_kind='bath' AND card_id='cut-result:2'`);
      await dispatch({ kind: 'bath', id: 'cut-result:2' }, 'E2E-three-of-three');
      expect(await statuses()).toEqual([[1, 6], [2, 16], [3, 16], [4, 16]]);
    });

    it.each([16, 17])('rule%i evaluates mixed-card orders independently and audits the exact source', async ruleId => {
      await client.query(`INSERT INTO pg_temp.cnc_telegram_packet_items(packet_id,match_order_id,match_detail_id,quantity)
        VALUES('00000000-0000-0000-0000-000000000001',2,2,1);
        UPDATE pg_temp.orders SET order_status_id=8 WHERE order_id=2;`);
      const source = ruleId === 16 ? await bathSource() : sourcePacket;
      if (ruleId === 16) await client.query(`INSERT INTO pg_temp.cut_result_placement
        (cut_result_id,cut_result_sheet_map_id,order_id,order_detail_id,instance,variant,detail_width_mm,detail_height_mm)
        VALUES(1,1,2,2,2,'auto',10,20)`);
      await dispatch(source);
      expect(await statuses()).toEqual([[1, ruleId === 16 ? 6 : 2], [2, 16], [3, 16], [4, 16]]);
      const audit = await client.query(`SELECT metadata_json FROM pg_temp.audit_log
        WHERE event='orders.detail_production_status_batch_change'`);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].metadata_json).toMatchObject({ changedDetailIds: [1], ruleId,
        mdfBoardScope: { source, details: [{ detailId: 1, requiredQuantity: 1, eligibleQuantity: 1 }] } });
    });

    it.each([16, 17])('rule%i replay has no repeated detail/version/command/outbox effects', async ruleId => {
      const source = ruleId === 16 ? await bathSource() : sourcePacket;
      await dispatch(source);
      const before = await effects();
      expect(before.commands).toHaveLength(1);
      await dispatch(source);
      await dispatch(source, 'E2E-new-revision-same-state');
      expect(await effects()).toEqual(before);
    });

    it.each([...[2, 6, 7, 8, 22].map(status => [17, status]), ...[6, 7, 8, 22].map(status => [16, status])])(
      'rule%i does not roll back/effect an equal or later detail status %i', async (ruleId, status) => {
        const source = ruleId === 16 ? await bathSource() : sourcePacket;
        await client.query('UPDATE pg_temp.order_details SET production_status_id=$1 WHERE detail_id=1', [status]);
        const before = await effects();
        await dispatch(source);
        expect(await effects()).toEqual(before);
      });

    it('enabled rules cannot be executed order-wide through a generic event or mass refresh', async () => {
      const before = await effects();
      for (const eventType of ['mdf.board.completed', 'mdf.board.baths_laminated'] as const)
        await evaluateStatusAutomation(tx, { eventType, origin: 'user', orderId: 1, actor, requestId: 'E2E-unscoped' });
      const summary = await evaluateAllStatusAutomationRulesForOrder(tx, {
        orderId: 1, actor, requestId: 'E2E-refresh', sourceIdempotencyKey: 'E2E-refresh',
      });
      expect(summary).toMatchObject({ executedActionCount: 0, skippedRuleCount: 2 });
      expect(await effects()).toEqual(before);
    });

    it('both rules remain inert when disabled, then use the same persisted source when enabled', async () => {
      const source = await bathSource();
      await client.query('UPDATE pg_temp.status_automation_rules SET is_enabled=false');
      const before = await effects();
      await dispatch(sourcePacket);
      await dispatch(source);
      expect(await effects()).toEqual(before);
      await client.query('UPDATE pg_temp.status_automation_rules SET is_enabled=true');
      await dispatch(source);
      expect((await statuses())[0]).toEqual([1, 6]);
    });
  });

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

  it('adds CNC and BASIS portions of the same detail in every bath calculation', async () => {
    await seed(1, [1, 1], '2026-09-06T12:00:00+05');
    await client.query('UPDATE pg_temp.cnc_telegram_packet_items SET quantity=1');
    await addBasis(1);
    await expectAllReadiness(true);
  });

  it.each([
    [2, 1, 1, 2, false],
    [2, 2, 3, 3, true],
    [3, 3, 3, 3, true],
  ])('sums multiple files and sets (%i+%i+%i+%i) for ten bath instances', async (fileA, fileB, basisA, basisB, ready) => {
    await seed(1, Array(10).fill(1), '2026-09-06T12:00:00+05');
    await client.query('UPDATE pg_temp.cnc_telegram_packet_items SET quantity=$1', [fileA]);
    await client.query(`INSERT INTO pg_temp.cnc_telegram_packets(packet_id,workday,completion_status,thumbs_up,material_name)
      VALUES('00000000-0000-0000-0000-000000000002','2026-09-06','completed',false,'MDF 10mm');
      INSERT INTO pg_temp.bazis_cut_sets(bazis_cut_set_id,name,created_at)
      VALUES(2,'E2E-БАЗИС-2','2026-09-06T12:00:00+05');
      INSERT INTO pg_temp.mdf_board_manual_moves(card_kind,card_id,target_column)
      VALUES('bazisCutSet','2','completed')`);
    await client.query(`INSERT INTO pg_temp.cnc_telegram_packet_items(packet_id,match_order_id,match_detail_id,quantity)
      VALUES('00000000-0000-0000-0000-000000000002',1,1,$1)`, [fileB]);
    await addBasis(basisA);
    await client.query(`INSERT INTO pg_temp.bazis_cut_set_details(bazis_cut_set_detail_id,
      bazis_cut_set_id,source_order_id,source_order_detail_id,quantity,material_name)
      VALUES(2,2,1,1,$1,'МДФ 18мм')`, [basisB]);
    await expectAllReadiness(ready);
    const response = await load();
    expect(response.columns.flatMap((column) => column.baths)[0]?.items[0].completedQuantity)
      .toBe(fileA + fileB + basisA + basisB);
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
