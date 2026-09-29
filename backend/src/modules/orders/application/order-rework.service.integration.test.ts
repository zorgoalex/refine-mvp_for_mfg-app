import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { OrderDto } from '../dto/order.dto';
import { OrderReworkService } from './order-rework.service';

// Real PostgreSQL proof of the rework commands («Переделка», slice 4). Gated on
// REWORK_INTEGRATION_DATABASE_URL (scratch DB: erp schema + migrations 210/211).
// Creates and removes its own `E2E-Тест` fixtures.
const databaseUrl = process.env.REWORK_INTEGRATION_DATABASE_URL;

describe.skipIf(!databaseUrl)('OrderReworkService (real PostgreSQL)', () => {
  let pool: Pool;
  let service: OrderReworkService;
  const tag = randomUUID().slice(0, 8);
  let userId: number;
  let clientId: number;
  let projectId: number;
  const orderIds: number[] = [];
  let status: Record<string, number>;
  let stage: Record<string, number>;
  let reasons: Record<string, number>;
  let admin: CurrentUser;

  function database(): DatabaseService {
    return {
      async transaction<T>(handler: (tx: TransactionClient) => Promise<T>): Promise<T> {
        const client: PoolClient = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await handler({ raw: client, query: (text: string, params: readonly unknown[] = []) => client.query(text, [...params]) } as never);
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

  async function createOrder(statusCode: string, detailStage: string, detailCount = 3): Promise<{ orderId: number; detailIds: number[] }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('erp.pse_writer', 'backend', true)");
      const refs = (await client.query(
        `SELECT (SELECT min(milling_type_id) FROM milling_types) AS milling,
                (SELECT min(edge_type_id) FROM edge_types) AS edge,
                (SELECT min(sheet_material_type_id) FROM sheet_material_types) AS sheet,
                (SELECT min(payment_status_id) FROM payment_statuses) AS payment`,
      )).rows[0];
      const orderId = Number((await client.query(
        `INSERT INTO orders (order_name, client_id, project_id, order_status_id, payment_status_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING order_id`,
        [`E2E-Тест переделка сервис ${tag} ${orderIds.length}`, clientId, projectId, status[statusCode], refs.payment, userId],
      )).rows[0].order_id);
      const detailIds: number[] = [];
      for (let n = 1; n <= detailCount; n += 1) {
        detailIds.push(Number((await client.query(
          `INSERT INTO order_details
             (order_id, detail_number, height, width, area, milling_type_id, edge_type_id, created_by, sheet_material_type_id, production_status_id)
           VALUES ($1, $2, 100, 200, 0.02, $3, $4, $5, $6, $7) RETURNING detail_id`,
          [orderId, n, refs.milling, refs.edge, userId, refs.sheet, stage[detailStage]],
        )).rows[0].detail_id));
      }
      for (const detailId of detailIds) {
        await client.query(
          `INSERT INTO production_status_events (detail_id, production_status_id, payload, round_no) VALUES ($1, $2, '{}'::jsonb, 1)`,
          [detailId, stage[detailStage]],
        );
      }
      await client.query('COMMIT');
      orderIds.push(orderId);
      return { orderId, detailIds };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  const version = async (orderId: number) => Number((await pool.query('SELECT version FROM orders WHERE order_id = $1', [orderId])).rows[0].version);
  const key = () => `e2e-rework-${randomUUID()}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 6 });
    service = new OrderReworkService({
      database: database(),
      isEnabled: () => true,
      readOrder: async () => ({}) as OrderDto,
    });
    status = Object.fromEntries((await pool.query('SELECT order_status_code, order_status_id FROM order_statuses')).rows
      .map((row) => [row.order_status_code, Number(row.order_status_id)]));
    stage = Object.fromEntries((await pool.query('SELECT production_status_code, production_status_id FROM production_statuses')).rows
      .map((row) => [row.production_status_code, Number(row.production_status_id)]));
    reasons = Object.fromEntries((await pool.query('SELECT code, order_rework_reason_id FROM order_rework_reasons')).rows
      .map((row) => [row.code, Number(row.order_rework_reason_id)]));
    userId = Number((await pool.query(
      "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, 'x') RETURNING user_id",
      [`e2e_rework_svc_${tag}`, `e2e_rework_svc_${tag}@example.invalid`],
    )).rows[0].user_id);
    clientId = Number((await pool.query('INSERT INTO clients (client_name, created_by) VALUES ($1, $2) RETURNING client_id', [`E2E-Тест клиент svc ${tag}`, userId])).rows[0].client_id);
    projectId = Number((await pool.query(
      'INSERT INTO projects (code, name, client_id, created_by) VALUES ($1, $2, $3, $4) RETURNING project_id',
      [`E2E-S-${tag}`, `E2E-Тест группа svc ${tag}`, clientId, userId],
    )).rows[0].project_id);
    admin = { id: String(userId), username: `e2e_rework_svc_${tag}`, role: 'admin', roleId: 1, permissions: getPermissionsForRole('admin') };
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      for (const orderId of orderIds) {
        await pool.query('DELETE FROM audit_log_related_entity WHERE audit_id IN (SELECT audit_id FROM audit_log WHERE related_order_id = $1)', [orderId]);
        await pool.query('DELETE FROM audit_log WHERE related_order_id = $1', [orderId]);
        await pool.query("DELETE FROM outbox_events WHERE aggregate_type = 'order' AND aggregate_id = $1", [String(orderId)]);
        await pool.query("DELETE FROM command_idempotency_keys WHERE entity_type = 'order' AND entity_id = $1", [String(orderId)]);
        await pool.query('DELETE FROM realtime_event_log WHERE order_id = $1', [orderId]);
        // Status changes are recorded in the append-only MDF board history by a DB trigger:
        // remove it with triggers off (as other suites do), then delete the order normally so
        // the FK cascade removes details, stage events and rounds.
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
      if (userId) {
        await pool.query('DELETE FROM audit_log WHERE user_id = $1', [String(userId)]).catch(() => undefined);
        await pool.query('DELETE FROM users WHERE user_id = $1', [userId]);
      }
      const residue = await pool.query("SELECT count(*)::int AS n FROM orders WHERE order_name LIKE $1", [`E2E-Тест переделка сервис ${tag}%`]);
      expect(residue.rows[0].n).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('starts a round after readiness: «Переделка», round 2, restaged details, audit, outbox, deferred realtime', async () => {
    const { orderId, detailIds } = await createOrder('legacy_6', 'packed');
    const idempotencyKey = key();
    const command = {
      currentUser: admin, orderId, version: await version(orderId), idempotencyKey,
      dto: { reasonId: reasons.workshop_defect, comment: ' скол ', details: [{ detailId: detailIds[0], productionStatusId: stage.drawn }] },
    };
    const result = await service.startOrExtend(command);
    expect(result).toMatchObject({ orderId, roundNo: 2, mode: 'after_ready', action: 'started', detailIds: [detailIds[0]] });

    const order = (await pool.query('SELECT order_status_id, production_round, last_round_no FROM orders WHERE order_id = $1', [orderId])).rows[0];
    expect(Number(order.order_status_id)).toBe(status.rework);
    expect([Number(order.production_round), Number(order.last_round_no)]).toEqual([2, 2]);
    const details = (await pool.query('SELECT detail_id, production_status_id, production_round FROM order_details WHERE order_id = $1 ORDER BY detail_id', [orderId])).rows;
    expect(details.map((d) => [Number(d.production_status_id), Number(d.production_round)])).toEqual([
      [stage.drawn, 2], [stage.packed, 1], [stage.packed, 1],
    ]);
    const round = (await pool.query('SELECT reason_comment, from_order_status_id, from_order_production_round, mode FROM order_production_rounds WHERE order_id = $1', [orderId])).rows[0];
    expect(round).toMatchObject({ reason_comment: 'скол', mode: 'after_ready' });
    const events = (await pool.query('SELECT production_status_id, round_no FROM production_status_events WHERE detail_id = $1 ORDER BY round_no', [detailIds[0]])).rows;
    expect(events.map((e) => [Number(e.production_status_id), Number(e.round_no)])).toEqual([[stage.packed, 1], [stage.drawn, 2]]);
    const audit = (await pool.query("SELECT event FROM audit_log WHERE related_order_id = $1 ORDER BY event", [orderId])).rows.map((r) => r.event);
    expect(audit).toEqual(['order.rework_started', 'orders.status_change']);
    const outbox = (await pool.query("SELECT event_type, idempotency_key FROM outbox_events WHERE aggregate_id = $1 ORDER BY event_type", [String(orderId)])).rows;
    expect(outbox.map((o) => o.event_type)).toEqual(['order.rework_started', 'order.status_changed']);
    expect(outbox[0].idempotency_key).toBe(`order:${orderId}:rework:2:started:1`);

    // Idempotent replay: same result, no new rows.
    const replay = await service.startOrExtend(command);
    expect(replay).toMatchObject({ roundNo: 2, action: 'started', version: result.version });
    expect(Number((await pool.query('SELECT count(*) FROM audit_log WHERE related_order_id = $1', [orderId])).rows[0].count)).toBe(2);

    // Extend: a new detail joins round 2; an already included detail is a no-op.
    const extended = await service.startOrExtend({
      currentUser: admin, orderId, version: await version(orderId), idempotencyKey: key(),
      dto: { details: [{ detailId: detailIds[0], productionStatusId: stage.drawn }, { detailId: detailIds[1], productionStatusId: stage.cut }] },
    });
    expect(extended).toMatchObject({ roundNo: 2, action: 'extended', detailIds: [detailIds[1]] });
    const noop = await service.startOrExtend({
      currentUser: admin, orderId, version: await version(orderId), idempotencyKey: key(),
      dto: { details: [{ detailId: detailIds[1], productionStatusId: stage.drawn }] },
    });
    expect(noop.action).toBe('noop');
    await expect(service.startOrExtend({
      currentUser: admin, orderId, version: await version(orderId), idempotencyKey: key(),
      dto: { reasonId: reasons.other, details: [{ detailId: detailIds[2], productionStatusId: stage.cut }] },
    })).rejects.toMatchObject({ code: 'ORDER_REWORK_REASON_NOT_APPLICABLE' });

    // Clarify the reason, then close as «не переделка»: exact before-state restored.
    const clarified = await service.clarifyReason({
      currentUser: admin, orderId, roundNo: 2, version: await version(orderId), idempotencyKey: key(),
      dto: { reasonId: reasons.measurement_error, comment: 'замер' },
    });
    expect(clarified.action).toBe('reason_clarified');
    const closed = await service.falsePositive({
      currentUser: admin, orderId, roundNo: 2, version: await version(orderId), idempotencyKey: key(), dto: {},
    });
    expect(closed).toMatchObject({ action: 'false_positive', detailIds: [detailIds[0], detailIds[1]] });
    const after = (await pool.query('SELECT order_status_id, production_round, last_round_no FROM orders WHERE order_id = $1', [orderId])).rows[0];
    expect([Number(after.order_status_id), Number(after.production_round), Number(after.last_round_no)]).toEqual([status.legacy_6, 1, 2]);
    const restored = (await pool.query('SELECT production_status_id, production_round FROM order_details WHERE order_id = $1 ORDER BY detail_id', [orderId])).rows;
    expect(restored.map((d) => [Number(d.production_status_id), Number(d.production_round)])).toEqual([
      [stage.packed, 1], [stage.packed, 1], [stage.packed, 1],
    ]);
    const roundAfter = (await pool.query('SELECT close_reason, reason_id FROM order_production_rounds WHERE order_id = $1', [orderId])).rows[0];
    expect(roundAfter).toMatchObject({ close_reason: 'false_positive' });
    // The next round gets a fresh number (monotonic).
    const next = await service.startOrExtend({
      currentUser: admin, orderId, version: await version(orderId), idempotencyKey: key(),
      dto: { reasonId: reasons.client_change, details: [{ detailId: detailIds[2], productionStatusId: stage.cut }] },
    });
    expect(next.roundNo).toBe(3);
    expect(Number((await pool.query('SELECT count(*) FROM order_realtime_deferred WHERE order_id = $1', [orderId])).rows[0].count)).toBeGreaterThan(0);
  });

  it('opens a round inside production without changing the order status (D6)', async () => {
    const { orderId, detailIds } = await createOrder('legacy_4', 'cut');
    const result = await service.startOrExtend({
      currentUser: admin, orderId, version: await version(orderId), idempotencyKey: key(),
      dto: { reasonId: reasons.workshop_defect, details: [{ detailId: detailIds[0], productionStatusId: stage.drawn }] },
    });
    expect(result).toMatchObject({ mode: 'in_production', roundNo: 2, action: 'started' });
    const order = (await pool.query('SELECT order_status_id, production_round FROM orders WHERE order_id = $1', [orderId])).rows[0];
    expect([Number(order.order_status_id), Number(order.production_round)]).toEqual([status.legacy_4, 2]);
    const audit = (await pool.query("SELECT event FROM audit_log WHERE related_order_id = $1", [orderId])).rows.map((r) => r.event);
    expect(audit).toEqual(['order.rework_started']);
    const closed = await service.falsePositive({
      currentUser: admin, orderId, roundNo: 2, version: await version(orderId), idempotencyKey: key(), dto: { comment: 'ошибка' },
    });
    expect(closed.action).toBe('false_positive');
    const detail = (await pool.query('SELECT production_status_id, production_round FROM order_details WHERE detail_id = $1', [detailIds[0]])).rows[0];
    expect([Number(detail.production_status_id), Number(detail.production_round)]).toEqual([stage.cut, 1]);
    expect(Number((await pool.query('SELECT order_status_id FROM orders WHERE order_id = $1', [orderId])).rows[0].order_status_id)).toBe(status.legacy_4);
  });

  it('rejects invalid commands without side effects', async () => {
    const { orderId, detailIds } = await createOrder('legacy_7', 'issued');
    const other = await createOrder('legacy_7', 'issued', 1);
    const base = { currentUser: admin, orderId, idempotencyKey: key() };
    const v = await version(orderId);
    const cases: Array<[Record<string, unknown>, string | number]> = [
      [{ version: v + 1, dto: { reasonId: reasons.other, comment: 'x', details: [{ detailId: detailIds[0], productionStatusId: stage.drawn }] } }, 'ORDER_VERSION_CONFLICT'],
      [{ version: v, dto: { reasonId: reasons.other, details: [{ detailId: detailIds[0], productionStatusId: stage.drawn }] } }, 'ORDER_REWORK_COMMENT_REQUIRED'],
      [{ version: v, dto: { reasonId: reasons.unclarified, details: [{ detailId: detailIds[0], productionStatusId: stage.drawn }] } }, 'ORDER_REWORK_REASON_INVALID'],
      [{ version: v, dto: { details: [{ detailId: detailIds[0], productionStatusId: stage.drawn }] } }, 'ORDER_REWORK_REASON_REQUIRED'],
      [{ version: v, dto: { reasonId: reasons.workshop_defect, details: [{ detailId: other.detailIds[0], productionStatusId: stage.drawn }] } }, 'ORDER_REWORK_DETAIL_NOT_IN_ORDER'],
      [{ version: v, dto: { reasonId: reasons.workshop_defect, details: [{ detailId: detailIds[0], productionStatusId: stage.issued }] } }, 'ORDER_REWORK_TARGET_STAGE_INVALID'],
    ];
    for (const [patch, code] of cases) {
      await expect(service.startOrExtend({ ...base, idempotencyKey: key(), ...patch } as never)).rejects.toMatchObject({ code });
    }
    await expect(service.startOrExtend({
      ...base, version: v, currentUser: { ...admin, permissions: admin.permissions.filter((p) => p !== 'orders.rework') },
      dto: { reasonId: reasons.workshop_defect, details: [{ detailId: detailIds[0], productionStatusId: stage.drawn }] },
    })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const draft = await createOrder('legacy_1', 'drawn', 1);
    await expect(service.startOrExtend({
      currentUser: admin, orderId: draft.orderId, version: await version(draft.orderId), idempotencyKey: key(),
      dto: { reasonId: reasons.workshop_defect, details: [{ detailId: draft.detailIds[0], productionStatusId: stage.new }] },
    })).rejects.toMatchObject({ code: 'ORDER_REWORK_STATUS_NOT_ALLOWED' });
    const untouched = (await pool.query('SELECT order_status_id, production_round, version FROM orders WHERE order_id = $1', [orderId])).rows[0];
    expect([Number(untouched.order_status_id), Number(untouched.production_round), Number(untouched.version)]).toEqual([status.legacy_7, 1, v]);
    expect(Number((await pool.query('SELECT count(*) FROM order_production_rounds WHERE order_id = $1', [orderId])).rows[0].count)).toBe(0);
  });

  it('does not wait on a concurrent writer holding FK key-share locks on the order/detail (§5.7)', async () => {
    const { orderId, detailIds } = await createOrder('legacy_6', 'packed', 2);
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query("SELECT set_config('erp.pse_writer', 'backend', true)");
      // FK checks of this insert take FOR KEY SHARE on order_details/orders.
      await writer.query(
        `INSERT INTO production_status_events (detail_id, production_status_id, payload, round_no) VALUES ($1, $2, '{}'::jsonb, 1)`,
        [detailIds[1], stage.laminated],
      );
      const started = await Promise.race([
        service.startOrExtend({
          currentUser: admin, orderId, version: await version(orderId), idempotencyKey: key(),
          dto: { reasonId: reasons.workshop_defect, details: [{ detailId: detailIds[0], productionStatusId: stage.cut }] },
        }).then(() => 'done'),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 4000)),
      ]);
      expect(started).toBe('done');
      await writer.query('COMMIT');
    } catch (error) {
      await writer.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      writer.release();
    }
  });

  it('links rework audit rows to the touched details (related entities)', async () => {
    const { orderId, detailIds } = await createOrder('legacy_6', 'packed', 2);
    await service.startOrExtend({
      currentUser: admin, orderId, version: await version(orderId), idempotencyKey: key(),
      dto: { reasonId: reasons.workshop_defect, details: [{ detailId: detailIds[1], productionStatusId: stage.cut }] },
    });
    const linked = await pool.query(
      `SELECT a.event FROM audit_log_related_entity r JOIN audit_log a ON a.audit_id = r.audit_id
       WHERE r.entity_type = 'order_detail' AND r.entity_id = $1`,
      [detailIds[1]],
    );
    expect(linked.rows.map((row) => row.event)).toEqual(['order.rework_started']);
  });

  it('refuses «не переделка» when a round detail was moved to another order; the other order is untouched', async () => {
    const source = await createOrder('legacy_6', 'packed', 2);
    const target = await createOrder('legacy_4', 'cut', 1);
    await service.startOrExtend({
      currentUser: admin, orderId: source.orderId, version: await version(source.orderId), idempotencyKey: key(),
      dto: { reasonId: reasons.workshop_defect, details: [{ detailId: source.detailIds[0], productionStatusId: stage.drawn }] },
    });
    // Simulates a detail transfer (blocked for rework rounds by slice 5, §5.3).
    await pool.query('UPDATE order_details SET order_id = $2, detail_number = 99 WHERE detail_id = $1', [source.detailIds[0], target.orderId]);
    const targetBefore = (await pool.query('SELECT version, production_round FROM orders WHERE order_id = $1', [target.orderId])).rows[0];
    await expect(service.falsePositive({
      currentUser: admin, orderId: source.orderId, roundNo: 2, version: await version(source.orderId), idempotencyKey: key(), dto: {},
    })).rejects.toMatchObject({ code: 'ORDER_REWORK_DETAILS_CHANGED' });
    const moved = (await pool.query('SELECT order_id, production_status_id, production_round FROM order_details WHERE detail_id = $1', [source.detailIds[0]])).rows[0];
    expect([Number(moved.order_id), Number(moved.production_status_id), Number(moved.production_round)]).toEqual([target.orderId, stage.drawn, 2]);
    const targetAfter = (await pool.query('SELECT version, production_round FROM orders WHERE order_id = $1', [target.orderId])).rows[0];
    expect(targetAfter).toEqual(targetBefore);
    // Put it back so the cleanup cascades normally.
    await pool.query('UPDATE order_details SET order_id = $2, detail_number = 1 WHERE detail_id = $1', [source.detailIds[0], source.orderId]);
  });

  it('fails fast with 409 on every round command while the MDF cutover holds the exclusive fence', async () => {
    const { orderId, detailIds } = await createOrder('legacy_6', 'packed', 1);
    await service.startOrExtend({
      currentUser: admin, orderId, version: await version(orderId), idempotencyKey: key(),
      dto: { reasonId: reasons.workshop_defect, details: [{ detailId: detailIds[0], productionStatusId: stage.cut }] },
    });
    const cutover = await pool.connect();
    try {
      await cutover.query('BEGIN');
      await cutover.query("SELECT pg_advisory_xact_lock(hashtextextended('mdf-engine-cutover', 0))");
      const v = await version(orderId);
      for (const run of [
        () => service.clarifyReason({ currentUser: admin, orderId, roundNo: 2, version: v, idempotencyKey: key(), dto: { reasonId: reasons.client_change } }),
        () => service.falsePositive({ currentUser: admin, orderId, roundNo: 2, version: v, idempotencyKey: key(), dto: {} }),
        () => service.startOrExtend({ currentUser: admin, orderId, version: v, idempotencyKey: key(), dto: { details: [{ detailId: detailIds[0], productionStatusId: stage.drawn }] } }),
      ]) {
        await expect(run()).rejects.toMatchObject({ code: 'ORDER_REWORK_MDF_CUTOVER_IN_PROGRESS' });
      }
    } finally {
      await cutover.query('ROLLBACK').catch(() => undefined);
      cutover.release();
    }
  });
});
