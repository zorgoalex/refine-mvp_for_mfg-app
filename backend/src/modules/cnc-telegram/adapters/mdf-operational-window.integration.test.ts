import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PgCncTelegramRepository } from './pg-cnc-telegram-repository';

// Opt-in, single connection. All fixtures live ONLY in session-local pg_temp
// tables; public data is never inserted, changed, or deleted by these tests.
const enabled = process.env.MDF_PROJECTION_INTEGRATION === '1';
const tables = [
  'cut_job', 'cut_result', 'cut_result_board_projection', 'cut_result_label_map_projection',
  'cut_result_archive_state', 'cut_result_placement', 'cut_result_sheet_map',
  'orders', 'order_details', 'production_statuses', 'cnc_telegram_packets',
  'cnc_telegram_packet_items', 'cnc_telegram_packet_whole_order_keys',
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
    await client.query(`INSERT INTO pg_temp.cut_job(cut_job_id,status,current_cut_result_id,name)
      SELECT $1,'completed',$2,'E2E-Тест' WHERE NOT EXISTS(SELECT 1 FROM pg_temp.cut_job WHERE cut_job_id=$1)`, [job, id]);
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
