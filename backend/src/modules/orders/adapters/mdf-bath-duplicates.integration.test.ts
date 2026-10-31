import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { TransactionClient } from '../../../database/database.types';
import { loadBoardBathDuplicates } from './mdf-bath-duplicate-facts';
import { PgMdfBathDuplicateRepository } from './pg-mdf-bath-duplicate-repository';

/**
 * «Разобрать дубль» on the real PostgreSQL schema. Opt-in (MDF_ENGINE_INTEGRATION=1). Every table lives in an own
 * throw-away schema `e2e_bath_dup_<uuid>` (search_path first): migration 287 runs there, the public audit → board
 * history trigger functions are attached to its copies, nothing in `public` is written. Workers and the outbox relay
 * read `public` only, so the fixtures' outbox rows are never delivered. The schema is dropped and its absence checked.
 */
const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';
const FIXTURE_TABLES = [
  'cut_job', 'cut_result', 'cut_result_board_projection', 'cut_result_label_map_projection', 'cut_result_archive_state',
  'cut_result_sheet_map', 'cut_result_placement', 'cut_job_item', 'orders', 'order_details', 'production_statuses',
  'cnc_telegram_packets', 'mdf_board_manual_moves', 'outbox_events', 'audit_log', 'audit_log_related_entity',
] as const;
const ID = 800_000_000;
const ORDER_A = ID + 1;
const ORDER_B = ID + 2;
const ORDER_C = ID + 3; // created by someone else: outside a manager's own-orders scope
const USER = ID + 7;
const OLD = ID + 101; // old bath (job ID+11)
const NEW = ID + 102; // re-cut bath (job ID+12)

describe.skipIf(!enabled)('MDF bath duplicates PostgreSQL (own schema)', () => {
  const schema = `e2e_bath_dup_${randomUUID().replaceAll('-', '')}`;
  const connection = {
    host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
    database: process.env.PG_DB, user: process.env.PG_USER, password: process.env.PG_PASSWORD,
    connectionTimeoutMillis: 5000,
  };
  let admin: Pool;
  let pool: Pool;
  const admin_user = { id: String(USER), username: 'E2E-Тест', role: 'admin', roleId: 1,
    permissions: ['cut.manage', 'orders.view'] } as unknown as CurrentUser;

  const database = () => ({
    isConfigured: true,
    query: (text: string, params: readonly unknown[] = []) => pool.query(text, [...params]),
    async transaction<T>(handler: (client: TransactionClient) => Promise<T>): Promise<T> {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await handler({ raw: client, query: (text: string, params: readonly unknown[] = []) =>
          client.query(text, [...params]) } as unknown as TransactionClient);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  }) as never;
  const repository = () => new PgMdfBathDuplicateRepository(database());
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  const count = async (sql: string, params: unknown[] = []) => Number((await q(sql, params)).rows[0].n);

  async function boardEntry(bath: number, user: CurrentUser = admin_user) {
    const result = await loadBoardBathDuplicates({ query: (t: string, p: readonly unknown[] = []) => pool.query(t, [...p]) },
      user, { shown: [{ bathCardId: `cut-result:${bath}`, column: 'baths', orderIds: [ORDER_A, ORDER_B] }],
        engineOwnsBoard: false });
    return result.get(`cut-result:${bath}`);
  }

  beforeAll(async () => {
    admin = new Pool({ ...connection, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const table of FIXTURE_TABLES) {
      await admin.query(`CREATE TABLE ${schema}.${table} AS TABLE public.${table} WITH NO DATA`);
    }
    await admin.query(`
      CREATE TABLE ${schema}.mdf_board_history_events (LIKE public.mdf_board_history_events INCLUDING ALL);
      CREATE TABLE ${schema}.users (user_id bigint PRIMARY KEY);
      CREATE TABLE ${schema}.mdf_engine_state (singleton boolean PRIMARY KEY, mode text NOT NULL);
      ALTER TABLE ${schema}.audit_log ALTER COLUMN audit_id SET DEFAULT gen_random_uuid(),
        ALTER COLUMN created_at SET DEFAULT now();
      ALTER TABLE ${schema}.outbox_events ALTER COLUMN created_at SET DEFAULT now();
      CREATE UNIQUE INDEX ON ${schema}.outbox_events(idempotency_key);
      -- CREATE TABLE AS / LIKE copy no foreign keys: recreate the production ones the command's writes go through
      -- (their KEY SHARE checks on orders/users take part in lock waits, e.g. against an archive holding orders).
      ALTER TABLE ${schema}.orders ADD PRIMARY KEY (order_id);
      ALTER TABLE ${schema}.audit_log ADD PRIMARY KEY (audit_id),
        ADD FOREIGN KEY (user_id) REFERENCES ${schema}.users(user_id) ON DELETE SET NULL;
      ALTER TABLE ${schema}.audit_log_related_entity
        ADD FOREIGN KEY (audit_id) REFERENCES ${schema}.audit_log(audit_id) ON DELETE CASCADE;
      ALTER TABLE ${schema}.mdf_board_history_events
        ADD FOREIGN KEY (order_id) REFERENCES ${schema}.orders(order_id) ON DELETE RESTRICT,
        ADD FOREIGN KEY (actor_user_id) REFERENCES ${schema}.users(user_id) ON DELETE SET NULL,
        ADD FOREIGN KEY (triggered_by_user_id) REFERENCES ${schema}.users(user_id) ON DELETE SET NULL;
      CREATE TRIGGER e2e_history_from_audit AFTER INSERT ON ${schema}.audit_log
        FOR EACH ROW EXECUTE FUNCTION public.record_mdf_board_history_from_audit();
      CREATE TRIGGER e2e_history_from_relation AFTER INSERT ON ${schema}.audit_log_related_entity
        FOR EACH ROW EXECUTE FUNCTION public.record_mdf_board_history_from_audit_relation();
    `);
    const migration = readFileSync(new URL('../../../../db/migrations/287_mdf_bath_duplicate_resolutions.sql', import.meta.url),
      'utf8').replaceAll('public.', `${schema}.`);
    await admin.query(migration);
    pool = new Pool({ ...connection, max: 6,
      options: `-c search_path=${schema},public -c statement_timeout=15000 -c lock_timeout=5000 -c jit=off` });
  }, 30_000);

  afterAll(async () => {
    try {
      await pool?.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      expect((await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows).toHaveLength(0);
      // Nothing of these fixtures ever reached the shared schema.
      expect(Number((await admin.query(`SELECT count(*) n FROM public.outbox_events
        WHERE event_type='mdf_board.bath_duplicate_resolved' AND payload_json->>'actorUserId'=$1`, [String(USER)])).rows[0].n))
        .toBe(0);
    } finally {
      await admin?.end();
    }
  });

  beforeEach(async () => {
    await q(`TRUNCATE ${[...FIXTURE_TABLES, 'mdf_board_history_events', 'mdf_bath_duplicate_resolutions', 'users',
      'mdf_engine_state'].join(',')}`);
    await q(`INSERT INTO users VALUES ($1); INSERT INTO mdf_engine_state VALUES (true, 'legacy');
      INSERT INTO production_statuses(production_status_id, production_status_code, production_status_name, sort_order)
        VALUES (30001, 'laminated', 'Закатан', 20), (30002, 'packed', 'Упакован', 30);
      INSERT INTO orders(order_id, order_name, order_kind, delete_flag, created_by)
        VALUES (${ORDER_A}, 'E2E-Тест A', 'production_order', false, $1), (${ORDER_B}, 'E2E-Тест B', 'production_order', false, $1),
          (${ORDER_C}, 'E2E-Тест C', 'production_order', false, 1);
      INSERT INTO order_details(detail_id, order_id, detail_number, delete_flag, production_round)
        VALUES (${ID + 11}, ${ORDER_A}, 1, false, 1), (${ID + 12}, ${ORDER_A}, 2, false, 1), (${ID + 21}, ${ORDER_B}, 1, false, 1);`
      .replaceAll('$1', String(USER)));
    // Old and re-cut baths of the same three details (job items qty = placements).
    await seedBath(OLD, ID + 11, [[ORDER_A, ID + 11, 2], [ORDER_A, ID + 12, 1], [ORDER_B, ID + 21, 1]]);
    await seedBath(NEW, ID + 12, [[ORDER_A, ID + 11, 2], [ORDER_A, ID + 12, 1], [ORDER_B, ID + 21, 1]]);
  });

  async function seedBath(resultId: number, jobId: number, lines: Array<[number, number, number]>) {
    await q(`INSERT INTO cut_job(cut_job_id, name, status, version, current_cut_result_id) VALUES ($1, 'E2E-Тест ванна', 'completed', 1, $2)`,
      [jobId, resultId]);
    await q(`INSERT INTO cut_result(cut_result_id, cut_job_id, result_no, revision_no, created_at, snapshot_digest)
      VALUES ($1, $2, 1, 1, now(), $3)`, [resultId, jobId, `e2e-${resultId}`]);
    await q(`INSERT INTO cut_result_board_projection(cut_result_id, snapshot_digest, is_vacuum, cut_job_name, result_created_at)
      VALUES ($1, $2, true, 'E2E-Тест', now())`, [resultId, `e2e-${resultId}`]);
    await q(`INSERT INTO cut_result_label_map_projection(cut_result_id, snapshot_digest, sheet_count, placement_count)
      VALUES ($1, $2, 1, 1)`, [resultId, `e2e-${resultId}`]);
    await q(`INSERT INTO cut_result_sheet_map(cut_result_sheet_map_id, cut_result_id, cut_job_id, is_effective)
      VALUES ($1, $1, $2, true)`, [resultId, jobId]);
    let instance = 0;
    for (const [orderId, detailId, quantity] of lines) {
      await q(`INSERT INTO cut_job_item(cut_job_item_id, cut_job_id, order_id, order_detail_id, qty, is_active)
        VALUES ($1, $2, $3, $4, $5, true)`, [resultId * 10 + instance, jobId, orderId, detailId, quantity]);
      for (let i = 0; i < quantity; i += 1) {
        instance += 1;
        await q(`INSERT INTO cut_result_placement(cut_result_placement_id, cut_result_sheet_map_id, cut_result_id, cut_job_id,
          order_id, order_detail_id, instance) VALUES ($1, $2, $2, $3, $4, $5, $6)`,
        [resultId * 100 + instance, resultId, jobId, orderId, detailId, instance]);
      }
    }
  }

  const resolveCommand = (digest: string, patch: Record<string, unknown> = {}) => ({
    currentUser: admin_user, bathCardId: `cut-result:${NEW}`, otherBathCardId: `cut-result:${OLD}`,
    action: 'keep_both' as const, expectedDigest: digest, idempotencyKey: `E2E-key-${randomUUID()}`,
    requestId: 'E2E-request', ...patch,
  });

  it('migration 287 enforces the canonical pair, pair-side target, action, digest and a unique command key', async () => {
    const insert = (patch: Record<string, string>) => q(`INSERT INTO mdf_bath_duplicate_resolutions
      (bath_a, bath_b, target_bath, action, digest, shared_json, order_ids, request_id, command_key, request_digest)
      VALUES ($1, $2, $3, $4, $5, '[]', '{}', 'E2E', $6, $7)`, [patch.a ?? 'cut-result:1', patch.b ?? 'cut-result:2',
      patch.target ?? 'cut-result:1', patch.action ?? 'keep_both', patch.digest ?? 'a'.repeat(64), patch.key ?? 'E2E-k',
      'b'.repeat(64)]);
    await insert({});
    await expect(insert({ key: 'E2E-k' })).rejects.toMatchObject({ code: '23505' });
    await expect(insert({ key: 'E2E-2', a: 'cut-result:2', b: 'cut-result:1', target: 'cut-result:2' }))
      .rejects.toMatchObject({ code: '23514' });
    await expect(insert({ key: 'E2E-3', target: 'cut-result:3' })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ key: 'E2E-4', action: 'archive' })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ key: 'E2E-5', digest: 'xyz' })).rejects.toMatchObject({ code: '23514' });
  });

  it('records the decision, audit, one outbox event and a board history row per order; the pair hides', async () => {
    const entry = (await boardEntry(NEW))!.duplicates[0];
    expect(entry).toMatchObject({ otherBathCardId: `cut-result:${OLD}`, sharedCount: 3, coveredBy: true });
    expect((await boardEntry(OLD))!.duplicates[0]).toMatchObject({ digest: entry.digest, archivable: true });
    const result = await repository().resolve(resolveCommand(entry.digest));
    expect(result).toMatchObject({ replayed: false, resolution: { action: 'keep_both', orderIds: [ORDER_A, ORDER_B] } });
    const audit = (await q(`SELECT audit_id::text, event, entity_type, entity_id, source FROM audit_log`)).rows;
    expect(audit).toEqual([{ audit_id: result.auditId, event: 'mdf_board.bath_duplicate_resolved',
      entity_type: 'mdf_bath_duplicate', entity_id: String(result.resolution.resolutionId), source: 'backend-mdf-board' }]);
    expect((await q('SELECT audit_id::text FROM mdf_bath_duplicate_resolutions')).rows).toEqual([{ audit_id: result.auditId }]);
    expect(await count(`SELECT count(*) n FROM audit_log_related_entity`)).toBe(2 + 3 + 2 + 2);
    expect(await count(`SELECT count(*) n FROM outbox_events WHERE event_type='mdf_board.bath_duplicate_resolved'`)).toBe(1);
    const history = (await q(`SELECT order_id::bigint AS order_id, event_kind FROM mdf_board_history_events
      WHERE source_event_id=$1 ORDER BY order_id`, [result.auditId])).rows;
    expect(history).toEqual([{ order_id: String(ORDER_A), event_kind: 'progress' },
      { order_id: String(ORDER_B), event_kind: 'progress' }]);
    expect(await boardEntry(NEW)).toBeUndefined();
  });

  it('rolls back everything when a write after the audit fails', async () => {
    const entry = (await boardEntry(NEW))!.duplicates[0];
    await q(`CREATE FUNCTION e2e_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'E2E outbox failure'; END $$;
      CREATE TRIGGER e2e_fail_outbox BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION e2e_fail_outbox()`);
    try {
      await expect(repository().resolve(resolveCommand(entry.digest))).rejects.toThrow('E2E outbox failure');
    } finally {
      await q('DROP TRIGGER e2e_fail_outbox ON outbox_events; DROP FUNCTION e2e_fail_outbox()');
    }
    for (const table of ['mdf_bath_duplicate_resolutions', 'audit_log', 'audit_log_related_entity', 'outbox_events',
      'mdf_board_history_events']) {
      expect(await count(`SELECT count(*) n FROM ${table}`), table).toBe(0);
    }
  });

  it('runs concurrent identical retries as one decision and refuses the key with another body', async () => {
    const entry = (await boardEntry(NEW))!.duplicates[0];
    const command = resolveCommand(entry.digest);
    const [first, second] = await Promise.all([repository().resolve(command), repository().resolve(command)]);
    expect(first.resolution.resolutionId).toBe(second.resolution.resolutionId);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(await count('SELECT count(*) n FROM mdf_bath_duplicate_resolutions')).toBe(1);
    expect(await count('SELECT count(*) n FROM audit_log')).toBe(1);
    expect(await count('SELECT count(*) n FROM outbox_events')).toBe(1);
    await expect(repository().resolve({ ...command, action: 'rework_mark' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  const manager = { id: String(USER), username: 'E2E-Тест', role: 'manager', roleId: 2,
    permissions: ['cut.manage', 'orders.view'] } as unknown as CurrentUser;

  it('lets a manager owning every order resolve, refuses a stale digest (409) without writes', async () => {
    const entry = (await boardEntry(NEW, manager))!.duplicates[0];
    expect(entry.otherJobLabel).not.toBeNull();
    await expect(repository().resolve(resolveCommand('c'.repeat(64), { currentUser: manager })))
      .rejects.toMatchObject({ statusCode: 409, code: 'MDF_BATH_DUPLICATE_STALE' });
    expect(await count('SELECT count(*) n FROM mdf_bath_duplicate_resolutions')).toBe(0);
    await repository().resolve(resolveCommand(entry.digest, { currentUser: manager }));
    expect(await count('SELECT count(*) n FROM mdf_bath_duplicate_resolutions')).toBe(1);
  });

  it('treats an invisible owner of HDF placements only as an owner: 403, redacted label, not listed', async () => {
    // The old bath also carries an HDF piece of order C (not a shared MDF detail).
    await q(`INSERT INTO cut_result_placement(cut_result_placement_id, cut_result_sheet_map_id, cut_result_id, cut_job_id,
      order_id, order_detail_id, order_hdf_detail_id, instance) VALUES ($1, $2, $2, $3, $4, NULL, $5, 99)`,
    [OLD * 100 + 99, OLD, ID + 11, ORDER_C, ID + 31]);
    const entry = (await boardEntry(NEW, manager))!.duplicates[0];
    expect(entry).toMatchObject({ otherJobLabel: null, blockedReason: 'scope', sharedCount: 3 });
    await expect(repository().resolve(resolveCommand(entry.digest, { currentUser: manager })))
      .rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    const listed = await repository().list({ currentUser: manager, bathCardIds: [`cut-result:${OLD}`, `cut-result:${NEW}`] });
    expect(listed.baths.map(b => b.bathCardId)).toEqual([`cut-result:${NEW}`]);
    expect(await count('SELECT count(*) n FROM mdf_bath_duplicate_resolutions')).toBe(0);
    // An admin sees every owner: the decision records order C among the bath owners.
    const result = await repository().resolve(resolveCommand((await boardEntry(NEW))!.duplicates[0].digest));
    expect(result.resolution.orderIds).toEqual([ORDER_A, ORDER_B, ORDER_C]);
  });

  it('marks rework on the target bath only, counted by distinct details', async () => {
    const entry = (await boardEntry(OLD))!.duplicates[0];
    await repository().resolve(resolveCommand(entry.digest, { action: 'rework_mark', bathCardId: `cut-result:${OLD}`,
      otherBathCardId: `cut-result:${NEW}` }));
    expect(await boardEntry(OLD)).toMatchObject({ reworkDetailCount: 3,
      reworkMarks: [{ otherBathCardId: `cut-result:${NEW}`, detailCount: 3 }] });
    expect((await boardEntry(NEW))!.reworkMarks).toEqual([]);
  });

  it('does not wait for a concurrent addItems (job → orders) and the decision stops applying after it', async () => {
    const entry = (await boardEntry(NEW))!.duplicates[0];
    const cut = await pool.connect();
    try {
      // addItems lock order on the other bath's job: cut_job FOR UPDATE → orders FOR KEY SHARE, then its writes.
      await cut.query('BEGIN');
      await cut.query('SELECT 1 FROM cut_job WHERE cut_job_id=$1 FOR UPDATE', [ID + 11]);
      await cut.query('SELECT 1 FROM orders WHERE order_id = ANY($1::bigint[]) ORDER BY order_id FOR KEY SHARE', [[ORDER_A, ORDER_B]]);
      await cut.query('UPDATE cut_job SET version = version + 1 WHERE cut_job_id=$1', [ID + 11]);
      await cut.query(`INSERT INTO cut_job_item(cut_job_item_id, cut_job_id, order_id, order_detail_id, qty, is_active)
        VALUES ($1, $2, $3, $4, 1, true)`, [ID + 999, ID + 11, ORDER_A, ID + 12]);
      const resolved = await repository().resolve(resolveCommand(entry.digest));
      expect(resolved.replayed).toBe(false);
      await cut.query('COMMIT');
    } finally {
      await cut.query('ROLLBACK').catch(() => undefined);
      cut.release();
    }
    const again = (await boardEntry(NEW))!.duplicates[0];
    expect(again.digest).not.toBe(entry.digest);
  });

  it('waits a bounded time for a concurrent archive holding orders (orders → job), then commits atomically; the pair goes', async () => {
    const entry = (await boardEntry(NEW))!.duplicates[0];
    const cut = await pool.connect();
    let resolving: Promise<unknown> | null = null;
    try {
      // Archive lock order: orders FOR UPDATE → the job; it commits while the decision waits.
      await cut.query('BEGIN');
      await cut.query('SELECT 1 FROM orders WHERE order_id = ANY($1::bigint[]) ORDER BY order_id FOR UPDATE', [[ORDER_A, ORDER_B]]);
      await cut.query("UPDATE cut_job SET status='archived', version = version + 1 WHERE cut_job_id=$1", [ID + 11]);
      const started = Date.now();
      resolving = repository().resolve(resolveCommand(entry.digest)).then(
        value => ({ value, ms: Date.now() - started }), error => ({ error, ms: Date.now() - started }));
      // The history rows' FK to orders needs KEY SHARE on the rows the archive holds: the decision waits, no deadlock.
      const early = await Promise.race([resolving, new Promise(resolve => setTimeout(() => resolve('waiting'), 700))]);
      expect(early).toBe('waiting');
      const waiters = await count(`SELECT count(*) n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE NOT l.granted AND a.query LIKE 'INSERT INTO audit_log_related_entity%'`);
      expect(waiters).toBeGreaterThan(0);
      await cut.query('COMMIT');
    } finally {
      await cut.query('ROLLBACK').catch(() => undefined);
      cut.release();
    }
    const outcome = await resolving! as { value?: { resolution: { resolutionId: number } }; error?: unknown; ms: number };
    expect(outcome.error).toBeUndefined();
    expect(outcome.ms).toBeLessThan(5000);
    // Atomic: decision, its audit, outbox and one history row per order are all there.
    expect(await count('SELECT count(*) n FROM mdf_bath_duplicate_resolutions')).toBe(1);
    expect(await count('SELECT count(*) n FROM audit_log')).toBe(1);
    expect(await count('SELECT count(*) n FROM outbox_events')).toBe(1);
    expect(await count('SELECT count(*) n FROM mdf_board_history_events')).toBe(2);
    // The other bath is archived: the pair no longer exists and a new decision on it is stale.
    expect(await boardEntry(NEW)).toBeUndefined();
    await expect(repository().resolve(resolveCommand(entry.digest)))
      .rejects.toMatchObject({ statusCode: 409, code: 'MDF_BATH_DUPLICATE_STALE' });
  });
});
