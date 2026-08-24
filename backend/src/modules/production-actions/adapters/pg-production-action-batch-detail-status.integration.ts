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

let CLIENT_ID: number;
let PROJECT_ID: number;
let ORDER_STATUS_ID: number;
let PAYMENT_STATUS_ID: number;
let USER_ID: number;
let MILLING_TYPE_ID: number;
let EDGE_TYPE_ID: number;
let SHEET_MATERIAL_TYPE_ID: number;
let STATUS_INITIAL: number;
let STATUS_NEW_MIN: number;
let STATUS_FILM: number;

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
  let hdfDetailId: number | undefined;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    repository = new PgProductionActionRepository(realService(pool));
    const orderRefs = (await pool.query(
      `SELECT client_id, project_id, order_status_id, payment_status_id, created_by
       FROM orders
       WHERE client_id IS NOT NULL AND project_id IS NOT NULL
         AND order_status_id IS NOT NULL AND payment_status_id IS NOT NULL AND created_by IS NOT NULL
       ORDER BY order_id LIMIT 1`,
    )).rows[0];
    CLIENT_ID = Number(orderRefs.client_id);
    PROJECT_ID = Number(orderRefs.project_id);
    ORDER_STATUS_ID = Number(orderRefs.order_status_id);
    PAYMENT_STATUS_ID = Number(orderRefs.payment_status_id);
    USER_ID = Number(orderRefs.created_by);

    const detailRefs = (await pool.query(
      `SELECT milling_type_id, edge_type_id, sheet_material_type_id
       FROM order_details
       WHERE milling_type_id IS NOT NULL AND edge_type_id IS NOT NULL
         AND sheet_material_type_id IS NOT NULL
       ORDER BY detail_id LIMIT 1`,
    )).rows[0];
    MILLING_TYPE_ID = Number(detailRefs.milling_type_id);
    EDGE_TYPE_ID = Number(detailRefs.edge_type_id);
    SHEET_MATERIAL_TYPE_ID = Number(detailRefs.sheet_material_type_id);

    const productionStatuses = await pool.query<{ production_status_code: string; production_status_id: number }>(
      `SELECT production_status_code, production_status_id
       FROM production_statuses
       WHERE production_status_code = ANY($1::text[])`,
      [['drawn', 'new', 'film_purchase']],
    );
    const productionStatusByCode = new Map(
      productionStatuses.rows.map((row) => [row.production_status_code, Number(row.production_status_id)]),
    );
    STATUS_INITIAL = productionStatusByCode.get('drawn')!;
    STATUS_NEW_MIN = productionStatusByCode.get('new')!;
    STATUS_FILM = productionStatusByCode.get('film_purchase')!;

    const orderRow = await pool.query<{ order_id: string | number }>(
      `INSERT INTO orders
         (order_name, client_id, project_id, order_status_id, payment_status_id, created_by,
          production_status_id, production_status_from_details_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       RETURNING order_id`,
      [
        `E2E-Тест batch §7.2 ${randomUUID().slice(0, 8)}`,
        CLIENT_ID,
        PROJECT_ID,
        ORDER_STATUS_ID,
        PAYMENT_STATUS_ID,
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
        await pool.query(`DELETE FROM order_hdf_details WHERE order_id = $1`, [orderId]);
        await pool.query(`DELETE FROM order_details WHERE order_id = $1`, [orderId]);
        const cleanupClient = await pool.connect();
        try {
          await cleanupClient.query('BEGIN');
          await cleanupClient.query('SET LOCAL session_replication_role = replica');
          await cleanupClient.query(`DELETE FROM mdf_board_history_state WHERE order_id = $1`, [orderId]);
          await cleanupClient.query(`DELETE FROM mdf_board_history_coverage WHERE order_id = $1`, [orderId]);
          await cleanupClient.query(`DELETE FROM mdf_board_history_events WHERE order_id = $1`, [orderId]);
          await cleanupClient.query(`DELETE FROM orders WHERE order_id = $1`, [orderId]);
          await cleanupClient.query('COMMIT');
        } catch (error) {
          await cleanupClient.query('ROLLBACK');
          throw error;
        } finally {
          cleanupClient.release();
        }
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

  it('ignores fresh HDF status when recalculating the parent from ordinary details', async () => {
    const revision = Number((
      await pool.query<{ revision: string | number }>(
        `SELECT revision FROM hdf_calculation_config_state WHERE id = 1`,
      )
    ).rows[0].revision);
    const inserted = await pool.query<{ order_hdf_detail_id: string | number }>(
      `INSERT INTO order_hdf_details (
         order_id, source_order_detail_id, source_order_detail_id_snapshot,
         hdf_enabled, edge_mm, threshold_mm, hdf_sheet_material_type_id,
         hdf_height_mm, hdf_width_mm, quantity, area_m2, status,
         source_snapshot_hash, source_snapshot_json, config_revision,
         production_status_id, created_by
       ) VALUES (
         $1, $2, $2, true, 67, 15, $3,
         100, 200, 1, 0.02, 'ok',
         $4, '{}'::jsonb, $5, $6, $7
       )
       RETURNING order_hdf_detail_id`,
      [
        orderId,
        detailIds[0],
        SHEET_MATERIAL_TYPE_ID,
        `e2e-hdf-${randomUUID()}`,
        revision,
        STATUS_NEW_MIN,
        USER_ID,
      ],
    );
    hdfDetailId = Number(inserted.rows[0].order_hdf_detail_id);

    await pool.query(
      `UPDATE order_details SET production_status_id = $2 WHERE order_id = $1`,
      [orderId, STATUS_FILM],
    );
    await pool.query(`SELECT recalc_order_production_status($1)`, [orderId]);

    const parent = await pool.query<{ production_status_id: number }>(
      `SELECT production_status_id FROM orders WHERE order_id = $1`,
      [orderId],
    );
    expect(Number(parent.rows[0].production_status_id)).toBe(STATUS_FILM);

    await pool.query(
      `UPDATE order_hdf_details SET production_status_id = $2, version = version + 1
       WHERE order_hdf_detail_id = $1`,
      [hdfDetailId, STATUS_INITIAL],
    );
    await pool.query(`SELECT recalc_order_production_status($1)`, [orderId]);
    const afterHdfRegeneration = await pool.query<{ production_status_id: number }>(
      `SELECT production_status_id FROM orders WHERE order_id = $1`,
      [orderId],
    );
    expect(Number(afterHdfRegeneration.rows[0].production_status_id)).toBe(STATUS_FILM);
  });

  it('manual parent production status cascades only to ordinary details', async () => {
    await pool.query(`UPDATE orders SET production_status_id = $2 WHERE order_id = $1`, [
      orderId,
      STATUS_NEW_MIN,
    ]);

    const details = await pool.query<{ production_status_id: number }>(
      `SELECT production_status_id FROM order_details WHERE order_id = $1`,
      [orderId],
    );
    expect(details.rows.every((row) => Number(row.production_status_id) === STATUS_NEW_MIN)).toBe(true);

    const hdf = await pool.query<{ production_status_id: number }>(
      `SELECT production_status_id FROM order_hdf_details WHERE order_hdf_detail_id = $1`,
      [hdfDetailId],
    );
    expect(Number(hdf.rows[0].production_status_id)).toBe(STATUS_INITIAL);
  });
});
