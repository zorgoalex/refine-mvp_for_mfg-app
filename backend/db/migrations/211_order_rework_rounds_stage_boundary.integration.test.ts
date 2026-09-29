import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Real PostgreSQL proof of migration 211 («Переделка», migration B): the old
// «stage once» indexes are gone and the stage-event command boundary admits
// only backend writers in the current round. Gated on
// REWORK_INTEGRATION_DATABASE_URL (scratch DB with the erp schema, 210 and 211);
// creates and removes its own `E2E-Тест` fixtures.
const databaseUrl = process.env.REWORK_INTEGRATION_DATABASE_URL;
const migration211 = readFileSync(new URL('./211_order_rework_rounds_stage_boundary.sql', import.meta.url), 'utf8');
const rollback211 = readFileSync(new URL('../rollback/211_order_rework_rounds_stage_boundary.down.sql', import.meta.url), 'utf8');

describe.skipIf(!databaseUrl)('211 stage-event command boundary (real PostgreSQL)', () => {
  let pool: Pool;
  let userId: number;
  let authorId: number;
  let clientId: number;
  let projectId: number;
  let orderId: number;
  let detailId: number;
  let cut: number;
  const tag = randomUUID().slice(0, 8);

  async function inTx<T>(run: (client: PoolClient) => Promise<T>, writer?: 'backend' | 'historical_import'): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (writer) await client.query("SELECT set_config('erp.pse_writer', $1, true)", [writer]);
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Runs a multi-statement script (own BEGIN/COMMIT) on a dedicated connection.
  async function runScript(script: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query(script);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  const insertDetailEvent = (client: PoolClient, round: number) => client.query(
    `INSERT INTO production_status_events (detail_id, production_status_id, payload, round_no)
     VALUES ($1, $2, '{}'::jsonb, $3) RETURNING event_id`,
    [detailId, cut, round],
  );

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const phaseB = (await pool.query("SELECT to_regclass('public.uq_pse_detail_status_once') IS NULL AS b")).rows[0].b;
    expect(phaseB, 'migration 211 must be applied to the scratch DB').toBe(true);
    cut = Number((await pool.query("SELECT production_status_id FROM production_statuses WHERE production_status_code = 'cut'")).rows[0].production_status_id);
    const draft = Number((await pool.query("SELECT order_status_id FROM order_statuses WHERE order_status_code = 'legacy_2'")).rows[0].order_status_id);
    userId = Number((await pool.query(
      "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, 'x') RETURNING user_id",
      [`e2e_rework_b_${tag}`, `e2e_rework_b_${tag}@example.invalid`],
    )).rows[0].user_id);
    authorId = Number((await pool.query(
      "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, 'x') RETURNING user_id",
      [`e2e_rework_author_${tag}`, `e2e_rework_author_${tag}@example.invalid`],
    )).rows[0].user_id);
    clientId = Number((await pool.query(
      'INSERT INTO clients (client_name, created_by) VALUES ($1, $2) RETURNING client_id',
      [`E2E-Тест клиент B ${tag}`, userId],
    )).rows[0].client_id);
    projectId = Number((await pool.query(
      'INSERT INTO projects (code, name, client_id, created_by) VALUES ($1, $2, $3, $4) RETURNING project_id',
      [`E2E-B-${tag}`, `E2E-Тест группа B ${tag}`, clientId, userId],
    )).rows[0].project_id);
    const payment = Number((await pool.query('SELECT min(payment_status_id) AS id FROM payment_statuses')).rows[0].id);
    const refs = (await pool.query(
      `SELECT (SELECT min(milling_type_id) FROM milling_types) AS milling,
              (SELECT min(edge_type_id) FROM edge_types) AS edge,
              (SELECT min(sheet_material_type_id) FROM sheet_material_types) AS sheet`,
    )).rows[0];
    await inTx(async (client) => {
      orderId = Number((await client.query(
        `INSERT INTO orders (order_name, client_id, project_id, order_status_id, payment_status_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING order_id`,
        [`E2E-Тест переделка B ${tag}`, clientId, projectId, draft, payment, userId],
      )).rows[0].order_id);
      detailId = Number((await client.query(
        `INSERT INTO order_details
           (order_id, detail_number, height, width, area, milling_type_id, edge_type_id, created_by, sheet_material_type_id)
         VALUES ($1, 1, 100, 200, 0.02, $2, $3, $4, $5) RETURNING detail_id`,
        [orderId, refs.milling, refs.edge, userId, refs.sheet],
      )).rows[0].detail_id);
    });
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      if (orderId) {
        await pool.query('DELETE FROM realtime_event_log WHERE order_id = $1', [orderId]);
        // No writer marker: the cascade to stage events must pass the boundary.
        await pool.query('DELETE FROM orders WHERE order_id = $1', [orderId]);
        const left = await pool.query('SELECT count(*)::int AS n FROM production_status_events WHERE detail_id = $1', [detailId]);
        expect(left.rows[0].n).toBe(0);
      }
      if (projectId) await pool.query('DELETE FROM projects WHERE project_id = $1', [projectId]);
      if (clientId) await pool.query('DELETE FROM clients WHERE client_id = $1', [clientId]);
      if (userId) await pool.query('DELETE FROM users WHERE user_id = $1', [userId]);
      if (authorId) await pool.query('DELETE FROM users WHERE user_id = $1', [authorId]);
      // Guarded rollback succeeds only when no round > 1 is left anywhere; then 211 is re-applied.
      const rounds = await pool.query(
        'SELECT (SELECT count(*) FROM production_status_events WHERE round_no > 1)::int + (SELECT count(*) FROM order_production_rounds)::int AS n',
      );
      if (rounds.rows[0].n === 0) {
        await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
        // No later rounds: a stage command that has read events FOR UPDATE but not written yet
        // must make the rollback fail at once (NOWAIT), not deadlock on the later DROP TRIGGER.
        const command = await pool.connect();
        try {
          await command.query('BEGIN');
          await command.query('SELECT event_id FROM production_status_events WHERE false FOR UPDATE');
          await expect(runScript(rollback211)).rejects.toThrow(/could not obtain lock/);
        } finally {
          await command.query('ROLLBACK').catch(() => undefined);
          command.release();
        }
        await runScript(rollback211);
        const after = (await pool.query(
          `SELECT to_regclass('public.uq_pse_detail_status_once') IS NOT NULL AS once_idx,
                  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_production_status_events_command_boundary') AS boundary`,
        )).rows[0];
        expect(after).toEqual({ once_idx: true, boundary: false });
        await runScript(migration211);
        const reapplied = (await pool.query(
          `SELECT to_regclass('public.uq_pse_detail_status_once') IS NULL AS dropped,
                  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_production_status_events_command_boundary') AS boundary`,
        )).rows[0];
        expect(reapplied).toEqual({ dropped: true, boundary: true });
      }
    } finally {
      await pool.end();
    }
  });

  it('drops the old «stage once» indexes and keeps the round-aware ones', async () => {
    const rows = await pool.query(
      `SELECT to_regclass('public.uq_pse_detail_status_once') AS a, to_regclass('public.uq_pse_order_status_once') AS b,
              to_regclass('public.uq_pse_detail_status_round') AS c, to_regclass('public.uq_pse_order_status_round') AS d`,
    );
    expect(rows.rows[0]).toMatchObject({ a: null, b: null });
    expect(rows.rows[0].c).not.toBeNull();
    expect(rows.rows[0].d).not.toBeNull();
  });

  it('rejects stage-event writes without the backend marker (direct Hasura/SQL)', async () => {
    await expect(inTx((client) => insertDetailEvent(client, 1))).rejects.toThrow(/STAGE_EVENT_WRITE_REQUIRES_BACKEND/);
  });

  it('lets the backend repeat a stage in the next round and only in the current round', async () => {
    await inTx((client) => insertDetailEvent(client, 1), 'backend');
    await expect(inTx((client) => insertDetailEvent(client, 2), 'backend')).rejects.toThrow(/STAGE_EVENT_ROUND_MISMATCH/);
    await pool.query('UPDATE order_details SET production_round = 2 WHERE detail_id = $1', [detailId]);
    await pool.query('UPDATE orders SET last_round_no = 2 WHERE order_id = $1', [orderId]);
    await inTx((client) => insertDetailEvent(client, 2), 'backend');
    const rounds = await pool.query(
      'SELECT round_no FROM production_status_events WHERE detail_id = $1 AND production_status_id = $2 ORDER BY round_no',
      [detailId, cut],
    );
    expect(rounds.rows.map((row) => Number(row.round_no))).toEqual([1, 2]);
    await expect(inTx((client) => insertDetailEvent(client, 2), 'backend')).rejects.toThrow(/uq_pse_detail_status_round/);
  });

  it('deletes only current-round events and never without the marker', async () => {
    const past = await pool.query('SELECT event_id FROM production_status_events WHERE detail_id = $1 AND round_no = 1', [detailId]);
    const current = await pool.query('SELECT event_id FROM production_status_events WHERE detail_id = $1 AND round_no = 2', [detailId]);
    await expect(inTx((client) => client.query('DELETE FROM production_status_events WHERE event_id = $1', [past.rows[0].event_id]), 'backend'))
      .rejects.toThrow(/STAGE_EVENT_PAST_ROUND_DELETE/);
    await expect(inTx((client) => client.query('DELETE FROM production_status_events WHERE event_id = $1', [current.rows[0].event_id])))
      .rejects.toThrow(/STAGE_EVENT_WRITE_REQUIRES_BACKEND/);
    await inTx((client) => client.query('DELETE FROM production_status_events WHERE event_id = $1', [current.rows[0].event_id]), 'backend');
    const left = await pool.query('SELECT round_no FROM production_status_events WHERE detail_id = $1', [detailId]);
    expect(left.rows.map((row) => Number(row.round_no))).toEqual([1]);
  });

  it('lets a backend snapshot import write past-round history', async () => {
    await inTx((client) => client.query(
      `INSERT INTO production_status_events (order_id, production_status_id, payload, round_no)
       VALUES ($1, $2, '{}'::jsonb, 1)`,
      [orderId, cut],
    ), 'historical_import');
    const rows = await pool.query('SELECT round_no FROM production_status_events WHERE order_id = $1', [orderId]);
    expect(rows.rows.map((row) => Number(row.round_no))).toEqual([1]);
  });

  it('never lets UPDATE move an event to another round/parent/stage or touch a past round', async () => {
    const past = (await pool.query('SELECT event_id FROM production_status_events WHERE detail_id = $1 AND round_no = 1', [detailId])).rows[0].event_id;
    await expect(inTx((client) => client.query('UPDATE production_status_events SET round_no = 2 WHERE event_id = $1', [past]), 'backend'))
      .rejects.toThrow(/STAGE_EVENT_IDENTITY_IMMUTABLE/);
    await expect(inTx((client) => client.query('UPDATE production_status_events SET round_no = 2 WHERE event_id = $1', [past]), 'historical_import'))
      .rejects.toThrow(/STAGE_EVENT_IDENTITY_IMMUTABLE/);
    await expect(inTx((client) => client.query("UPDATE production_status_events SET note = 'x' WHERE event_id = $1", [past]), 'backend'))
      .rejects.toThrow(/STAGE_EVENT_PAST_ROUND_UPDATE/);
    await expect(inTx((client) => client.query("UPDATE production_status_events SET note = 'x' WHERE event_id = $1", [past])))
      .rejects.toThrow(/STAGE_EVENT_WRITE_REQUIRES_BACKEND/);
  });

  it('lets deleting the author null event_by in current and past rounds without a marker', async () => {
    await inTx(async (client) => {
      await client.query(
        `INSERT INTO production_status_events (detail_id, production_status_id, payload, round_no, event_by)
         VALUES ($1, $2, '{}'::jsonb, 2, $3)`,
        [detailId, cut, authorId],
      );
    }, 'backend');
    // Past-round event authored by the same user (written as history).
    await inTx((client) => client.query(
      `UPDATE production_status_events SET event_by = $2 WHERE detail_id = $1 AND round_no = 1`,
      [detailId, authorId],
    ), 'historical_import');
    await pool.query('DELETE FROM users WHERE user_id = $1', [authorId]);
    authorId = 0;
    const authors = await pool.query('SELECT round_no, event_by FROM production_status_events WHERE detail_id = $1 ORDER BY round_no', [detailId]);
    expect(authors.rows.map((row) => [Number(row.round_no), row.event_by])).toEqual([[1, null], [2, null]]);
  });

  it('refuses the guarded rollback while production rounds > 1 exist', async () => {
    await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    await expect(runScript(rollback211)).rejects.toThrow(/REWORK_211_ROLLBACK_BLOCKED/);
    const still = await pool.query("SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_production_status_events_command_boundary') AS b");
    expect(still.rows[0].b).toBe(true);
  });

  it('rejects clearing the author directly while the author user still exists', async () => {
    const keeper = Number((await pool.query(
      "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, 'x') RETURNING user_id",
      [`e2e_rework_keep_${tag}`, `e2e_rework_keep_${tag}@example.invalid`],
    )).rows[0].user_id);
    try {
      await inTx((client) => client.query(
        'UPDATE production_status_events SET event_by = $2 WHERE detail_id = $1 AND round_no = 1',
        [detailId, keeper],
      ), 'historical_import');
      await inTx((client) => client.query(
        `INSERT INTO production_status_events (detail_id, production_status_id, payload, round_no, event_by)
         VALUES ($1, $2, '{}'::jsonb, 2, $3)
         ON CONFLICT (detail_id, production_status_id, round_no) WHERE detail_id IS NOT NULL
         DO UPDATE SET event_by = EXCLUDED.event_by`,
        [detailId, cut, keeper],
      ), 'backend');
      for (const round of [1, 2]) {
        await expect(inTx((client) => client.query(
          'UPDATE production_status_events SET event_by = NULL WHERE detail_id = $1 AND round_no = $2',
          [detailId, round],
        ))).rejects.toThrow(/STAGE_EVENT_WRITE_REQUIRES_BACKEND/);
      }
      await expect(inTx((client) => client.query(
        'UPDATE production_status_events SET event_by = NULL WHERE detail_id = $1 AND round_no = 1',
        [detailId],
      ), 'backend')).rejects.toThrow(/STAGE_EVENT_PAST_ROUND_UPDATE/);
    } finally {
      // Deleting the author is the FK path: allowed without a marker in every round.
      await pool.query('DELETE FROM users WHERE user_id = $1', [keeper]);
    }
    const authors = await pool.query('SELECT event_by FROM production_status_events WHERE detail_id = $1', [detailId]);
    expect(authors.rows.every((row) => row.event_by === null)).toBe(true);
  });

  it('the guarded rollback cannot race a concurrent round writer', async () => {
    await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query("SELECT set_config('erp.pse_writer', 'backend', true)");
      // A later-round write in flight (not yet committed).
      await writer.query(
        `INSERT INTO production_status_events (order_id, production_status_id, payload, round_no)
         VALUES ($1, (SELECT production_status_id FROM production_statuses WHERE production_status_code = 'drawn'),
                 '{}'::jsonb, (SELECT production_round FROM orders WHERE order_id = $1))`,
        [orderId],
      );
      await expect(runScript(rollback211)).rejects.toThrow(/could not obtain lock/);
      await writer.query('COMMIT');
    } catch (error) {
      await writer.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      writer.release();
    }
    // Committed later-round data now blocks the rollback by the guard.
    await expect(runScript(rollback211)).rejects.toThrow(/REWORK_211_ROLLBACK_BLOCKED/);
    const boundary = await pool.query("SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_production_status_events_command_boundary') AS b");
    expect(boundary.rows[0].b).toBe(true);
  });
});
