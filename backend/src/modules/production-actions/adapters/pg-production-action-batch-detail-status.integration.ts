import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { PgProductionActionRepository } from './pg-production-action-repository';

// Real-DB proof of the batch detail production-status command against the erp_test schema
// (real recalc_order_production_status function + triggers + audit/outbox tables) — things the
// unit mock cannot exercise. Gated on PRODUCTION_ACTIONS_INTEGRATION_DATABASE_URL (falls back to
// TEST_DATABASE_URL); skips cleanly without a database. Uses a `E2E-Тест` order it creates and
// fully removes. erp_test is test data (mutate freely).
const databaseUrl =
  process.env.PRODUCTION_ACTIONS_INTEGRATION_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

// Valid erp_test FK ids (probed 2026-06-23).
const CLIENT_ID = 1007;
const USER_ID = 7;
const MILLING_TYPE_ID = 41;
const EDGE_TYPE_ID = 28;
const SHEET_MATERIAL_TYPE_ID = 2;
// production_statuses: 1=drawn(sort 10), 16=new(sort 5), 9=film_purchase(sort 15).
const STATUS_INITIAL = 1;
const STATUS_NEW_MIN = 16; // lower sort_order than initial → becomes the order's min-status in auto
const STATUS_FILM = 9;

function realService(pool: Pool): DatabaseService {
  return {
    async transaction<T>(handler: (tx: TransactionClient) => Promise<T>): Promise<T> {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx = {
          query: (text: string, params: readonly unknown[] = []) => client.query(text, [...params]),
        } as unknown as TransactionClient;
        const result = await handler(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    query: (text: string, params: readonly unknown[] = []) => pool.query(text, [...params]),
  } as unknown as DatabaseService;
}

function adminUser(): CurrentUser {
  return {
    id: String(USER_ID),
    username: 'e2e-batch-admin',
    role: 'admin',
    roleId: 1,
    permissions: getPermissionsForRole('admin'),
  };
}

describeIntegration('changeBatchDetailProductionStatus (real erp_test DB)', () => {
  let pool: Pool;
  let repository: PgProductionActionRepository;
  let orderId: number;
  let detailIds: number[];

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    repository = new PgProductionActionRepository(realService(pool));

    const orderRow = await pool.query<{ order_id: string | number }>(
      `INSERT INTO orders
         (order_name, client_id, order_status_id, payment_status_id, created_by,
          production_status_id, production_status_from_details_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING order_id`,
      [
        `E2E-Тест batch §7.2 ${randomUUID().slice(0, 8)}`,
        CLIENT_ID,
        1,
        1,
        USER_ID,
        STATUS_INITIAL,
      ],
    );
    orderId = Number(orderRow.rows[0].order_id);

    const detailRows = await pool.query<{ detail_id: string | number }>(
      `INSERT INTO order_details
         (order_id, detail_number, height, width, area, milling_type_id, edge_type_id,
          created_by, sheet_material_type_id, production_status_id)
       VALUES
         ($1, 1, 100, 200, 0.02, $2, $3, $4, $5, $6),
         ($1, 2, 150, 250, 0.0375, $2, $3, $4, $5, $6)
       RETURNING detail_id`,
      [orderId, MILLING_TYPE_ID, EDGE_TYPE_ID, USER_ID, SHEET_MATERIAL_TYPE_ID, STATUS_INITIAL],
    );
    detailIds = detailRows.rows.map((row) => Number(row.detail_id)).sort((a, b) => a - b);
  });

  afterAll(async () => {
    if (!pool) {
      return;
    }
    try {
      if (orderId) {
        await pool.query(`DELETE FROM audit_log WHERE related_order_id = $1`, [orderId]);
        await pool.query(
          `DELETE FROM outbox_events WHERE aggregate_type = 'order' AND aggregate_id = $1`,
          [String(orderId)],
        );
        await pool.query(
          `DELETE FROM command_idempotency_keys WHERE entity_type = 'order' AND entity_id = $1`,
          [String(orderId)],
        );
        if (detailIds?.length) {
          await pool.query(
            `DELETE FROM production_status_events WHERE detail_id = ANY($1::bigint[])`,
            [detailIds],
          );
        }
        await pool.query(`DELETE FROM order_details WHERE order_id = $1`, [orderId]);
        await pool.query(`DELETE FROM orders WHERE order_id = $1`, [orderId]);
      }
    } finally {
      await pool.end();
    }
  });

  it('auto mode: updates details, recalcs order to min-sort status, bumps version, no events', async () => {
    const eventsBefore = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM production_status_events WHERE detail_id = ANY($1::bigint[])`,
      [detailIds],
    );
    const versionBefore = (
      await pool.query<{ version: string | number }>(`SELECT version FROM orders WHERE order_id = $1`, [
        orderId,
      ])
    ).rows[0].version;

    const response = await repository.changeBatchDetailProductionStatus({
      currentUser: adminUser(),
      orderId,
      requestId: `e2e-batch-auto-${randomUUID().slice(0, 8)}`,
      dto: {
        detailIds,
        productionStatusId: STATUS_NEW_MIN,
        version: Number(versionBefore),
        idempotencyKey: `e2e-batch-auto-${randomUUID()}`,
      },
    });

    expect(response.affectedDetailCount).toBe(2);
    expect(response.selectedDetailCount).toBe(2);

    const details = await pool.query<{ production_status_id: number }>(
      `SELECT production_status_id FROM order_details WHERE order_id = $1 ORDER BY detail_id`,
      [orderId],
    );
    expect(details.rows.every((row) => Number(row.production_status_id) === STATUS_NEW_MIN)).toBe(true);

    const order = await pool.query<{ production_status_id: number; version: string | number }>(
      `SELECT production_status_id, version FROM orders WHERE order_id = $1`,
      [orderId],
    );
    // Auto mode: recalc set the order to the min-sort active detail status (STATUS_NEW_MIN, sort 5).
    expect(Number(order.rows[0].production_status_id)).toBe(STATUS_NEW_MIN);
    expect(Number(order.rows[0].version)).toBe(Number(versionBefore) + 1);

    const eventsAfter = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM production_status_events WHERE detail_id = ANY($1::bigint[])`,
      [detailIds],
    );
    expect(eventsAfter.rows[0].count).toBe(eventsBefore.rows[0].count); // zero new events

    const audit = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log
       WHERE related_order_id = $1 AND event = 'orders.detail_production_status_batch_change'`,
      [orderId],
    );
    expect(Number(audit.rows[0].count)).toBeGreaterThanOrEqual(1);

    const outbox = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM outbox_events
       WHERE aggregate_type = 'order' AND aggregate_id = $1
         AND event_type = 'order.detail_production_status_batch_changed'`,
      [String(orderId)],
    );
    expect(Number(outbox.rows[0].count)).toBeGreaterThanOrEqual(1);
  });

  it('legacy manual flag: still recalcs order production_status_id and bumps version', async () => {
    await pool.query(
      `UPDATE orders SET production_status_from_details_enabled = false WHERE order_id = $1`,
      [orderId],
    );
    const before = (
      await pool.query<{ production_status_id: number; version: string | number }>(
        `SELECT production_status_id, version FROM orders WHERE order_id = $1`,
        [orderId],
      )
    ).rows[0];

    await repository.changeBatchDetailProductionStatus({
      currentUser: adminUser(),
      orderId,
      requestId: `e2e-batch-manual-${randomUUID().slice(0, 8)}`,
      dto: {
        detailIds,
        productionStatusId: STATUS_FILM,
        version: Number(before.version),
        idempotencyKey: `e2e-batch-manual-${randomUUID()}`,
      },
    });

    const after = (
      await pool.query<{
        production_status_id: number;
        production_status_from_details_enabled: boolean;
        version: string | number;
      }>(
        `SELECT production_status_id, production_status_from_details_enabled, version FROM orders WHERE order_id = $1`,
        [orderId],
      )
    ).rows[0];

    expect(Number(after.production_status_id)).toBe(STATUS_FILM);
    expect(after.production_status_from_details_enabled).toBe(true);
    expect(Number(after.version)).toBe(Number(before.version) + 1);

    const details = await pool.query<{ production_status_id: number }>(
      `SELECT production_status_id FROM order_details WHERE order_id = $1`,
      [orderId],
    );
    expect(details.rows.every((row) => Number(row.production_status_id) === STATUS_FILM)).toBe(true);
  });
});
