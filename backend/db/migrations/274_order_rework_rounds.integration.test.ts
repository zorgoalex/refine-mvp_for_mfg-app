import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../src/database/database.types';
import { PgOrderReadRepository } from '../../src/modules/orders/adapters/pg-order-read-repository';

// Real PostgreSQL proof of migration 274 («Переделка», migration A): old-backend
// compatibility, the rework status guard, the commit-time status/round
// consistency, realtime stream pre-creation and deferred emission.
// Gated on REWORK_INTEGRATION_DATABASE_URL (a scratch DB with the erp schema and
// migration 274 applied); skips cleanly without it. Creates and removes its own
// `E2E-Тест` fixtures.
const databaseUrl = process.env.REWORK_INTEGRATION_DATABASE_URL;

describe.skipIf(!databaseUrl)('274 order rework rounds (real PostgreSQL)', () => {
  let pool: Pool;
  let userId: number;
  let clientId: number;
  let projectId: number;
  let orderId: number;
  let detailIds: number[];
  let status: { draft: number; ready: number; rework: number };
  let stage: { drawn: number; cut: number };
  const tag = randomUUID().slice(0, 8);
  // Migration B (275) drops the old «stage once» indexes: phase-A-only checks skip then.
  let phaseB = false;

  async function inTx<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
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

  async function orderStatusByCode(code: string): Promise<number> {
    const row = (await pool.query('SELECT order_status_id FROM order_statuses WHERE order_status_code = $1', [code])).rows[0];
    return Number(row.order_status_id);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    phaseB = (await pool.query("SELECT to_regclass('public.uq_pse_detail_status_once') IS NULL AS b")).rows[0].b === true;
    status = {
      draft: await orderStatusByCode('legacy_2'),
      ready: await orderStatusByCode('legacy_6'),
      rework: await orderStatusByCode('rework'),
    };
    const stages = await pool.query<{ production_status_code: string; production_status_id: number }>(
      "SELECT production_status_code, production_status_id FROM production_statuses WHERE production_status_code = ANY($1::text[])",
      [['drawn', 'cut']],
    );
    const byCode = new Map(stages.rows.map((row) => [row.production_status_code, Number(row.production_status_id)]));
    stage = { drawn: byCode.get('drawn')!, cut: byCode.get('cut')! };
    expect(stage.drawn).toBeGreaterThan(0);
    expect(stage.cut).toBeGreaterThan(0);

    userId = Number((await pool.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, 'x') RETURNING user_id`,
      [`e2e_rework_${tag}`, `e2e_rework_${tag}@example.invalid`],
    )).rows[0].user_id);
    clientId = Number((await pool.query(
      'INSERT INTO clients (client_name, created_by) VALUES ($1, $2) RETURNING client_id',
      [`E2E-Тест клиент ${tag}`, userId],
    )).rows[0].client_id);
    projectId = Number((await pool.query(
      'INSERT INTO projects (code, name, client_id, created_by) VALUES ($1, $2, $3, $4) RETURNING project_id',
      [`E2E-${tag}`, `E2E-Тест группа ${tag}`, clientId, userId],
    )).rows[0].project_id);
    const paymentStatusId = Number((await pool.query('SELECT min(payment_status_id) AS id FROM payment_statuses')).rows[0].id);
    const refs = (await pool.query(
      `SELECT (SELECT min(milling_type_id) FROM milling_types) AS milling,
              (SELECT min(edge_type_id) FROM edge_types) AS edge,
              (SELECT min(sheet_material_type_id) FROM sheet_material_types) AS sheet`,
    )).rows[0];
    // A production order must have an active detail at commit (deferred check).
    await inTx(async (client) => {
      orderId = Number((await client.query(
        `INSERT INTO orders (order_name, client_id, project_id, order_status_id, payment_status_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING order_id`,
        [`E2E-Тест переделка ${tag}`, clientId, projectId, status.draft, paymentStatusId, userId],
      )).rows[0].order_id);
      detailIds = (await client.query(
        `INSERT INTO order_details
           (order_id, detail_number, height, width, area, milling_type_id, edge_type_id,
            created_by, sheet_material_type_id, production_status_id)
         VALUES ($1, 1, 100, 200, 0.02, $2, $3, $4, $5, $6),
                ($1, 2, 150, 250, 0.0375, $2, $3, $4, $5, $6)
         RETURNING detail_id`,
        [orderId, refs.milling, refs.edge, userId, refs.sheet, stage.drawn],
      )).rows.map((row) => Number(row.detail_id)).sort((a, b) => a - b);
    });
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      if (orderId) {
        await pool.query('DELETE FROM realtime_event_log WHERE order_id = $1', [orderId]);
        await pool.query('DELETE FROM audit_log_related_entity WHERE audit_id IN (SELECT audit_id FROM audit_log WHERE related_order_id = $1)', [orderId]);
        await pool.query('DELETE FROM audit_log WHERE related_order_id = $1', [orderId]);
        await pool.query("DELETE FROM outbox_events WHERE aggregate_type = 'order' AND aggregate_id = $1", [String(orderId)]);
        // Append-only MDF board history (written by DB triggers on status changes): remove with triggers off.
        const history = await pool.connect();
        try {
          await history.query('BEGIN');
          await history.query('SET LOCAL session_replication_role = replica');
          await history.query('DELETE FROM mdf_board_history_state WHERE order_id = $1', [orderId]);
          await history.query('DELETE FROM mdf_board_history_coverage WHERE order_id = $1', [orderId]);
          await history.query('DELETE FROM mdf_board_history_events WHERE order_id = $1', [orderId]);
          await history.query('COMMIT');
        } catch (error) {
          await history.query('ROLLBACK');
          throw error;
        } finally {
          history.release();
        }
        await pool.query('DELETE FROM orders WHERE order_id = $1', [orderId]);
      }
      if (projectId) await pool.query('DELETE FROM projects WHERE project_id = $1', [projectId]);
      if (clientId) await pool.query('DELETE FROM clients WHERE client_id = $1', [clientId]);
      if (userId) await pool.query('DELETE FROM users WHERE user_id = $1', [userId]);
      const residue = await pool.query(
        "SELECT count(*)::int AS n FROM orders WHERE order_name LIKE 'E2E-Тест переделка ' || $1",
        [tag],
      );
      expect(residue.rows[0].n).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('creates the realtime stream row together with the order', async () => {
    const row = await pool.query('SELECT commit_sequence FROM order_realtime_stream WHERE order_id = $1', [orderId]);
    expect(row.rowCount).toBe(1);
    // Inserting details may already have emitted (realtime writes on): only presence matters.
    expect(Number(row.rows[0].commit_sequence)).toBeGreaterThanOrEqual(0);
  });

  it('keeps the old stage-event ON CONFLICT working (old backend compatibility)', async (ctx) => {
    if (phaseB) ctx.skip();
    await inTx(async (client) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await client.query(
          `INSERT INTO production_status_events (detail_id, production_status_id, event_by, note, payload)
           VALUES ($1, $2, $3, NULL, '{}'::jsonb)
           ON CONFLICT (detail_id, production_status_id) WHERE detail_id IS NOT NULL
           DO UPDATE SET payload = production_status_events.payload`,
          [detailIds[0], stage.cut, userId],
        );
      }
    });
    const rows = await pool.query(
      'SELECT round_no FROM production_status_events WHERE detail_id = $1 AND production_status_id = $2',
      [detailIds[0], stage.cut],
    );
    expect(rows.rows.map((row) => Number(row.round_no))).toEqual([1]);
  });

  it('writes stage events of the detail round through the new conflict target', async () => {
    await inTx(async (client) => {
      await client.query("SELECT set_config('erp.pse_writer', 'backend', true)");
      await client.query(
        `INSERT INTO production_status_events (detail_id, production_status_id, event_by, note, payload, round_no)
         VALUES ($1, $2, $3, NULL, '{}'::jsonb, (SELECT production_round FROM order_details WHERE detail_id = $1))
         ON CONFLICT (detail_id, production_status_id, round_no) WHERE detail_id IS NOT NULL
         DO UPDATE SET payload = production_status_events.payload`,
        [detailIds[0], stage.cut, userId],
      );
    });
    const rows = await pool.query(
      'SELECT count(*)::int AS n FROM production_status_events WHERE detail_id = $1 AND production_status_id = $2',
      [detailIds[0], stage.cut],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('still rejects a second round of the same stage until migration B drops the old index', async (ctx) => {
    if (phaseB) ctx.skip();
    await expect(inTx((client) => client.query(
      `INSERT INTO production_status_events (detail_id, production_status_id, event_by, payload, round_no)
       VALUES ($1, $2, $3, '{}'::jsonb, 2)`,
      [detailIds[0], stage.cut, userId],
    ))).rejects.toThrow(/uq_pse_detail_status_once/);
  });

  it('rejects entering «Переделка» without the rework command marker', async () => {
    await expect(inTx((client) => client.query(
      'UPDATE orders SET order_status_id = $2 WHERE order_id = $1',
      [orderId, status.rework],
    ))).rejects.toThrow(/ORDER_REWORK_REQUIRES_COMMAND/);
  });

  it('rejects «Переделка» without an open round at commit', async () => {
    await expect(inTx(async (client) => {
      await client.query("SELECT set_config('erp.rework_command', 'on', true)");
      await client.query('UPDATE orders SET order_status_id = $2 WHERE order_id = $1', [orderId, status.rework]);
    })).rejects.toThrow(/ORDER_REWORK_STATUS_WITHOUT_ROUND/);
  });

  it('accepts «Переделка» with an open round and rejects a terminal status while it stays open', async () => {
    const reasonId = Number((await pool.query("SELECT order_rework_reason_id FROM order_rework_reasons WHERE code = 'workshop_defect'")).rows[0].order_rework_reason_id);
    await inTx(async (client) => {
      await client.query("SELECT set_config('erp.rework_command', 'on', true)");
      await client.query(
        `INSERT INTO order_production_rounds
           (order_id, round_no, mode, reason_id, from_order_status_id, from_order_production_round, started_by)
         VALUES ($1, 2, 'after_ready', $2, $3, 1, $4)`,
        [orderId, reasonId, status.ready, userId],
      );
      await client.query(
        'UPDATE orders SET order_status_id = $2, production_round = 2, last_round_no = 2 WHERE order_id = $1',
        [orderId, status.rework],
      );
    });
    await expect(inTx((client) => client.query(
      `INSERT INTO order_production_rounds
         (order_id, round_no, mode, reason_id, from_order_status_id, from_order_production_round)
       VALUES ($1, 3, 'after_ready', $2, $3, 2)`,
      [orderId, reasonId, status.ready],
    ))).rejects.toThrow(/uq_order_production_rounds_open/);
    // With migration 276 a terminal status closes the open round; without it the commit is refused.
    const closure = (await pool.query(
      "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_orders_close_rework_round') AS b",
    )).rows[0].b === true;
    if (closure) {
      await inTx((client) => client.query('UPDATE orders SET order_status_id = $2 WHERE order_id = $1', [orderId, status.ready]));
      const closed = (await pool.query('SELECT close_reason FROM order_production_rounds WHERE order_id = $1 AND round_no = 2', [orderId])).rows[0];
      expect(closed.close_reason).toBe('ready');
    } else {
      await expect(inTx((client) => client.query(
        'UPDATE orders SET order_status_id = $2 WHERE order_id = $1',
        [orderId, status.ready],
      ))).rejects.toThrow(/ORDER_REWORK_ROUND_OPEN_AT_TERMINAL/);
      await inTx(async (client) => {
        await client.query(
          "UPDATE order_production_rounds SET closed_at = now(), close_reason = 'ready' WHERE order_id = $1 AND round_no = 2",
          [orderId],
        );
        await client.query('UPDATE orders SET order_status_id = $2, production_round = 2 WHERE order_id = $1', [orderId, status.ready]);
      });
    }
    const order = (await pool.query('SELECT order_status_id, production_round, last_round_no FROM orders WHERE order_id = $1', [orderId])).rows[0];
    expect(Number(order.order_status_id)).toBe(status.ready);
    expect(Number(order.last_round_no)).toBe(2);
  });

  it('rejects deleting an open round or moving it onto a terminal order; allows a cascading order delete', async () => {
    const reasonId = Number((await pool.query("SELECT order_rework_reason_id FROM order_rework_reasons WHERE code = 'other'")).rows[0].order_rework_reason_id);
    await inTx(async (client) => {
      await client.query("SELECT set_config('erp.rework_command', 'on', true)");
      await client.query(
        `INSERT INTO order_production_rounds
           (order_id, round_no, mode, reason_id, from_order_status_id, from_order_production_round)
         VALUES ($1, 3, 'after_ready', $2, $3, 2)`,
        [orderId, reasonId, status.ready],
      );
      await client.query(
        'UPDATE orders SET order_status_id = $2, production_round = 3, last_round_no = 3 WHERE order_id = $1',
        [orderId, status.rework],
      );
    });
    await expect(inTx((client) => client.query(
      'DELETE FROM order_production_rounds WHERE order_id = $1 AND round_no = 3',
      [orderId],
    ))).rejects.toThrow(/ORDER_REWORK_STATUS_WITHOUT_ROUND/);

    // A second, terminal order to move the open round onto.
    const paymentStatusId = Number((await pool.query('SELECT min(payment_status_id) AS id FROM payment_statuses')).rows[0].id);
    const refs = (await pool.query(
      `SELECT (SELECT min(milling_type_id) FROM milling_types) AS milling,
              (SELECT min(edge_type_id) FROM edge_types) AS edge,
              (SELECT min(sheet_material_type_id) FROM sheet_material_types) AS sheet`,
    )).rows[0];
    const otherOrderId = await inTx(async (client) => {
      const id = Number((await client.query(
        `INSERT INTO orders (order_name, client_id, project_id, order_status_id, payment_status_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING order_id`,
        [`E2E-Тест переделка ${tag} other`, clientId, projectId, status.ready, paymentStatusId, userId],
      )).rows[0].order_id);
      await client.query(
        `INSERT INTO order_details
           (order_id, detail_number, height, width, area, milling_type_id, edge_type_id, created_by, sheet_material_type_id)
         VALUES ($1, 1, 100, 200, 0.02, $2, $3, $4, $5)`,
        [id, refs.milling, refs.edge, userId, refs.sheet],
      );
      return id;
    });
    try {
      await expect(inTx(async (client) => {
        await client.query("SELECT set_config('erp.rework_command', 'on', true)");
        // Keep the source order consistent so only the target check can fire.
        await client.query(
          `INSERT INTO order_production_rounds
             (order_id, round_no, mode, reason_id, from_order_status_id, from_order_production_round)
           VALUES ($1, 9, 'after_ready', $2, $3, 1)`,
          [otherOrderId, reasonId, status.ready],
        );
      })).rejects.toThrow(/ORDER_REWORK_ROUND_OPEN_AT_TERMINAL/);
      await expect(inTx((client) => client.query(
        'UPDATE order_production_rounds SET order_id = $2 WHERE order_id = $1 AND round_no = 3',
        [orderId, otherOrderId],
      ))).rejects.toThrow(/ORDER_REWORK_(STATUS_WITHOUT_ROUND|ROUND_OPEN_AT_TERMINAL)/);
    } finally {
      await pool.query('DELETE FROM orders WHERE order_id = $1', [otherOrderId]);
    }

    // Close the round again so later tests see a terminal-consistent order.
    await inTx(async (client) => {
      await client.query(
        "UPDATE order_production_rounds SET closed_at = now(), close_reason = 'ready' WHERE order_id = $1 AND round_no = 3",
        [orderId],
      );
      await client.query('UPDATE orders SET order_status_id = $2 WHERE order_id = $1', [orderId, status.ready]);
    });
  });

  it('defers realtime emission under erp.realtime_defer and emits normally without it', async () => {
    const writes = (await pool.query("SELECT value_json FROM app_settings WHERE setting_key = 'order_realtime.writes'")).rows[0];
    await pool.query(
      "UPDATE app_settings SET value_json = jsonb_set(value_json, '{enabled}', 'true'::jsonb) WHERE setting_key = 'order_realtime.writes'",
    );
    try {
      const before = Number((await pool.query('SELECT commit_sequence FROM order_realtime_stream WHERE order_id = $1', [orderId])).rows[0].commit_sequence);
      await inTx(async (client) => {
        await client.query("SELECT set_config('erp.realtime_defer', 'on', true)");
        await client.query('UPDATE order_details SET production_status_id = $2 WHERE detail_id = $1', [detailIds[1], stage.cut]);
      });
      const deferred = await pool.query('SELECT domains, detail_ids FROM order_realtime_deferred WHERE order_id = $1', [orderId]);
      expect(deferred.rowCount).toBe(1);
      expect(deferred.rows[0].domains).toEqual(['detail_status']);
      const afterDeferred = Number((await pool.query('SELECT commit_sequence FROM order_realtime_stream WHERE order_id = $1', [orderId])).rows[0].commit_sequence);
      expect(afterDeferred).toBe(before);

      await inTx((client) => client.query('UPDATE order_details SET production_status_id = $2 WHERE detail_id = $1', [detailIds[1], stage.drawn]));
      const afterNormal = Number((await pool.query('SELECT commit_sequence FROM order_realtime_stream WHERE order_id = $1', [orderId])).rows[0].commit_sequence);
      expect(afterNormal).toBe(before + 1);
    } finally {
      await pool.query(
        "UPDATE app_settings SET value_json = $1::jsonb WHERE setting_key = 'order_realtime.writes'",
        [JSON.stringify(writes.value_json)],
      );
      await pool.query('DELETE FROM order_realtime_deferred WHERE order_id = $1', [orderId]);
    }
    const restored = (await pool.query("SELECT value_json FROM app_settings WHERE setting_key = 'order_realtime.writes'")).rows[0];
    expect(restored.value_json).toEqual(writes.value_json);
  });

  it('order reads (list + card, both sheet flags) count only stage events of the current round', async () => {
    const drilled = Number((await pool.query("SELECT production_status_id FROM production_statuses WHERE production_status_code = 'drilled'")).rows[0].production_status_id);
    const current = Number((await pool.query('SELECT production_round FROM orders WHERE order_id = $1', [orderId])).rows[0].production_round);
    expect(current).toBeGreaterThan(1);
    // Past-round history is written as a historical import (allowed by the phase-B boundary).
    await inTx(async (client) => {
      await client.query("SELECT set_config('erp.pse_writer', 'historical_import', true)");
      await client.query(
        `INSERT INTO production_status_events (order_id, production_status_id, payload, round_no)
         VALUES ($1, $2, '{}'::jsonb, 1), ($1, $3, '{}'::jsonb, $4)`,
        [orderId, stage.cut, drilled, current],
      );
    });
    const database: DatabaseClient = {
      query: (text: string, params: readonly unknown[] = []) => pool.query(text, [...params]),
    } as unknown as DatabaseClient;
    const currentUser = { id: String(userId), username: 'e2e_rework', role: 'admin', roleId: 1, permissions: [] } as never;
    for (const sheetOrdersReads of [true, false]) {
      const repository = new PgOrderReadRepository(database, sheetOrdersReads);
      const list = await repository.listOrders({
        currentUser,
        query: { page: 1, pageSize: 50, sortBy: 'orderId', sortOrder: 'desc', onlyMyOrders: false },
      } as never);
      const item = list.data.find((row) => row.orderId === orderId);
      expect(item, `listOrders sheetOrdersReads=${sheetOrdersReads}`).toBeDefined();
      expect(item!.passedProductionStatusCodes).toContain('drilled');
      expect(item!.passedProductionStatusCodes).not.toContain('cut');
      const card = await repository.getOrderById({ currentUser, orderId } as never);
      expect(card?.header.passedProductionStatusCodes, `getOrderById sheetOrdersReads=${sheetOrdersReads}`).toContain('drilled');
      expect(card?.header.passedProductionStatusCodes).not.toContain('cut');
    }
  });
});
