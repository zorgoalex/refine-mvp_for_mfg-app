import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { OrderDto } from '../dto/order.dto';
import { almatyToday } from '../domain/order-rework-deadline';
import { OrderReworkService } from './order-rework.service';
import { enterMdfCommand } from '../../mdf-board/application/mdf-command-boundary';
import { OrderDetailTransferService } from './order-detail-transfer.service';
import { PgStatusAutomationRepository } from '../../status-automation/adapters/pg-status-automation-repository';
import { parseCreateStatusAutomationRuleRequest } from '../../status-automation/dto/status-automation.dto';
import { changeOrderStatusFromAutomationInTransaction } from '../../production-actions/adapters/pg-production-action-repository';
import { PgOrderSnapshot } from '../adapters/pg-order-snapshot';
import type { OrderSnapshotDto } from '../dto/order-snapshot.dto';
import { ConfigService } from '@nestjs/config';
import { OrderRealtimeDeferredDrainService } from '../../order-realtime/application/order-realtime-deferred-drain.service';
import { PgRecipientSourceAdapter } from '../../notifications-engine/adapters/pg-recipient-source';
import { PgVisibilityAdapter } from '../../notifications-engine/adapters/pg-visibility';
import { RecipientResolverService } from '../../notifications-engine/application/recipient-resolver.service';
import { ROLE_TO_ROLE_ID } from '../../../permissions/permissions';
import { OrderReworkReasonCatalogService } from './order-rework-reason-catalog.service';

// Real PostgreSQL proof of the rework commands («Переделка», slice 4). Gated on
// REWORK_INTEGRATION_DATABASE_URL (scratch DB: erp schema + migrations 274–276).
// Creates and removes its own `E2E-Тест` fixtures.
const databaseUrl = process.env.REWORK_INTEGRATION_DATABASE_URL;

const roundDeadline = (() => {
  const value = new Date(`${almatyToday()}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 30);
  return value.toISOString().slice(0, 10);
})();

describe.skipIf(!databaseUrl)('OrderReworkService (real PostgreSQL)', () => {
  let pool: Pool;
  let service: OrderReworkService;
  const tag = randomUUID().slice(0, 8);
  let userId: number;
  let clientId: number;
  let projectId: number;
  const orderIds: number[] = [];
  const importProjectIds: number[] = [];
  const importSource = `e2e-rework-${tag}`;
  let status: Record<string, number>;
  let stage: Record<string, number>;
  let reasons: Record<string, number>;
  let admin: CurrentUser;

  function database(): DatabaseService {
    return {
      async transaction<T>(
        handler: (tx: TransactionClient) => Promise<T>,
        options: { mdf?: { writer: string; capability: string }; isolation?: string } = {},
      ): Promise<T> {
        const client: PoolClient = await pool.connect();
        try {
          await client.query('BEGIN');
          // Like DatabaseService.transaction: honour the requested isolation level.
          if (options.isolation) await client.query(`SET TRANSACTION ISOLATION LEVEL ${options.isolation.toUpperCase()}`);
          const tx = { raw: client, query: (text: string, params: readonly unknown[] = []) => client.query(text, [...params]) } as never;
          // Like DatabaseService.transaction: MDF-aware commands enter the command boundary first.
          if (options.mdf) await enterMdfCommand(tx, options.mdf as never);
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
  let engineMode: string | null = null;
  // Order stage-mark automation (266) audits its own changes; command assertions exclude it.
  const commandAudit = "event NOT LIKE 'production_stage_mark.%'";
  const orderMarks = async (orderId: number) => (await pool.query(
    `SELECT ps.production_status_code AS code, pse.round_no FROM production_status_events pse
       JOIN production_statuses ps USING (production_status_id)
      WHERE pse.order_id = $1 AND pse.detail_id IS NULL ORDER BY pse.round_no, ps.sort_order`, [orderId],
  )).rows.map((r) => [r.code, Number(r.round_no)]);

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 6 });
    // Rounds are refused while the MDF engine is active (§5.5): the suite runs on «legacy»
    // and restores the database's own mode afterwards (stage copies may be «active»).
    engineMode = (await pool.query('SELECT mode FROM mdf_engine_state WHERE singleton')).rows[0]?.mode ?? null;
    if (engineMode) await pool.query("UPDATE mdf_engine_state SET mode = 'legacy' WHERE singleton");
    service = new OrderReworkService({
      database: database(),
      isEnabled: () => true,
      readOrder: async () => ({}) as OrderDto,
    });
    // Since 1.1 «Вернуть в переделку» needs the round deadline; these stage-1 scenarios do not test it, so a start
    // refused for the missing date is repeated with a fixed one (deadline behaviour: order-rework-deadline.integration).
    const startOrExtend = service.startOrExtend.bind(service);
    service.startOrExtend = (input) => startOrExtend(input).catch((error: { code?: string }) => {
      if (error?.code !== 'ORDER_REWORK_PLANNED_COMPLETION_REQUIRED') throw error;
      return startOrExtend({ ...input, dto: { ...input.dto, plannedCompletionDate: roundDeadline } });
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
      if (engineMode) await pool.query('UPDATE mdf_engine_state SET mode = $1 WHERE singleton', [engineMode]);
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
      await pool.query('DELETE FROM order_import_entity_map WHERE source_instance_id LIKE $1', [`${importSource}%`]);
      await pool.query('DELETE FROM order_import_runs WHERE source_instance_id LIKE $1', [`${importSource}%`]);
      for (const importProject of importProjectIds) {
        await pool.query(
          "DELETE FROM audit_log_related_entity WHERE audit_id IN (SELECT audit_id FROM audit_log WHERE entity_type = 'project' AND entity_id = $1)",
          [String(importProject)],
        );
        await pool.query("DELETE FROM audit_log WHERE entity_type = 'project' AND entity_id = $1", [String(importProject)]);
        await pool.query("DELETE FROM outbox_events WHERE aggregate_type = 'project' AND aggregate_id = $1", [String(importProject)]);
        await pool.query('DELETE FROM projects WHERE project_id = $1', [importProject]);
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
  }, 120_000);

  it('starts a round after readiness: «Переделка», round 2, restaged details, audit, outbox, deferred realtime', async () => {
    const { orderId, detailIds } = await createOrder('legacy_6', 'packed');
    const idempotencyKey = key();
    const command = {
      currentUser: admin, orderId, version: await version(orderId), idempotencyKey,
      dto: { reasonId: reasons.workshop_defect, comment: ' скол ', plannedCompletionDate: roundDeadline, details: [{ detailId: detailIds[0], productionStatusId: stage.drawn }] },
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
    const audit = (await pool.query(`SELECT event FROM audit_log WHERE related_order_id = $1 AND ${commandAudit} ORDER BY event`, [orderId])).rows.map((r) => r.event);
    // 1.1: the round deadline changes the order date → also an `orders.update` fact (order history).
    expect(audit).toEqual(['order.rework_started', 'orders.status_change', 'orders.update']);
    // Order stage marks (266): the original run keeps its mark, the new round gets its own.
    expect(await orderMarks(orderId)).toEqual([['packed', 1], ['drawn', 2]]);
    const outbox = (await pool.query("SELECT event_type, idempotency_key FROM outbox_events WHERE aggregate_id = $1 AND event_type LIKE 'order.%' ORDER BY event_type", [String(orderId)])).rows;
    // 1.1: the round deadline is a change of the order's planned completion date too.
    expect(outbox.map((o) => o.event_type)).toEqual(['order.planned_completion_date_changed', 'order.rework_started', 'order.status_changed']);
    expect(outbox[1].idempotency_key).toBe(`order:${orderId}:rework:2:started:1`);
    expect(outbox[0].idempotency_key).toBe(`order:${orderId}:rework:2:started:1:planned-completion`);

    // Idempotent replay: same result, no new rows.
    const replay = await service.startOrExtend(command);
    expect(replay).toMatchObject({ roundNo: 2, action: 'started', version: result.version });
    // Replay adds nothing: started + status change + the date fact (`orders.update`, 1.1).
    expect(Number((await pool.query(`SELECT count(*) FROM audit_log WHERE related_order_id = $1 AND ${commandAudit}`, [orderId])).rows[0].count)).toBe(3);

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

  it.each(['legacy_4', 'legacy_5'] as const)('opens a round inside production (%s) without changing the order status (D6)', async (statusCode) => {
    // «Распилен» (legacy_5) is production too: a cutting defect is reworked there.
    const { orderId, detailIds } = await createOrder(statusCode, 'cut');
    const result = await service.startOrExtend({
      currentUser: admin, orderId, version: await version(orderId), idempotencyKey: key(),
      dto: { reasonId: reasons.workshop_defect, details: [{ detailId: detailIds[0], productionStatusId: stage.drawn }] },
    });
    expect(result).toMatchObject({ mode: 'in_production', roundNo: 2, action: 'started' });
    const order = (await pool.query('SELECT order_status_id, production_round FROM orders WHERE order_id = $1', [orderId])).rows[0];
    expect([Number(order.order_status_id), Number(order.production_round)]).toEqual([status[statusCode], 2]);
    const audit = (await pool.query(`SELECT event FROM audit_log WHERE related_order_id = $1 AND ${commandAudit}`, [orderId])).rows.map((r) => r.event);
    expect(audit).toEqual(['order.rework_started']);
    const closed = await service.falsePositive({
      currentUser: admin, orderId, roundNo: 2, version: await version(orderId), idempotencyKey: key(), dto: { comment: 'ошибка' },
    });
    expect(closed.action).toBe('false_positive');
    const detail = (await pool.query('SELECT production_status_id, production_round FROM order_details WHERE detail_id = $1', [detailIds[0]])).rows[0];
    expect([Number(detail.production_status_id), Number(detail.production_round)]).toEqual([stage.cut, 1]);
    expect(Number((await pool.query('SELECT order_status_id FROM orders WHERE order_id = $1', [orderId])).rows[0].order_status_id)).toBe(status[statusCode]);
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

  async function setStatusAsWriter(orderId: number, code: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_session_user($1)', [userId]);
      await client.query("SELECT set_config('erp.request_id', 'req-e2e-writer', true)");
      await client.query('UPDATE orders SET order_status_id = $2, version = version + 1 WHERE order_id = $1', [orderId, status[code]]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  it('closes the open round when any writer moves the order to ready/issued/completed (§5.4)', async () => {
    const readyAgain = await createOrder('legacy_7', 'issued', 2);
    await service.startOrExtend({
      currentUser: admin, orderId: readyAgain.orderId, version: await version(readyAgain.orderId), idempotencyKey: key(),
      dto: { reasonId: reasons.delivery_damage, details: [{ detailId: readyAgain.detailIds[0], productionStatusId: stage.cut }] },
    });
    // «Переделка» → «В производстве» keeps the round open; «Готов к выдаче» closes it.
    await setStatusAsWriter(readyAgain.orderId, 'legacy_4');
    expect((await pool.query('SELECT closed_at FROM order_production_rounds WHERE order_id = $1', [readyAgain.orderId])).rows[0].closed_at).toBeNull();
    // A real status writer (automation action) moves the order to «Готов к выдаче».
    const writerClient = await pool.connect();
    try {
      await writerClient.query('BEGIN');
      const written = await changeOrderStatusFromAutomationInTransaction(
        { raw: writerClient, query: (text: string, params: readonly unknown[] = []) => writerClient.query(text, [...params]) } as never,
        readyAgain.orderId, status.legacy_6,
        { actor: admin, requestId: 'req-e2e-automation', outboxIdempotencyKey: `e2e-close-${tag}` } as never,
      );
      expect(written.status).toBe('executed');
      await writerClient.query('COMMIT');
    } catch (error) {
      await writerClient.query('ROLLBACK');
      throw error;
    } finally {
      writerClient.release();
    }
    const round = (await pool.query('SELECT close_reason, closed_by, event_seq FROM order_production_rounds WHERE order_id = $1', [readyAgain.orderId])).rows[0];
    expect(round).toMatchObject({ close_reason: 'ready', closed_by: null });
    const audit = (await pool.query(
      "SELECT audit_id, request_id, user_id, created_at, metadata_json FROM audit_log WHERE related_order_id = $1 AND event = 'order.rework_closed'",
      [readyAgain.orderId],
    )).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].user_id).toBeNull();
    expect(audit[0].request_id).toMatch(/^db-order-rework-close:\d+$/);
    // Correlation: the writer's own audit row of the same transaction carries the real actor/request.
    const writerAudit = (await pool.query(
      `SELECT user_id, request_id FROM audit_log
       WHERE related_order_id = $1 AND event = 'orders.status_change'
         AND created_at = (SELECT created_at FROM audit_log WHERE audit_id = $2)`,
      [readyAgain.orderId, audit[0].audit_id],
    )).rows;
    expect(writerAudit).toHaveLength(1);
    expect(writerAudit[0]).toMatchObject({ request_id: 'req-e2e-automation' });
    expect(Number(writerAudit[0].user_id)).toBe(userId);
    expect(audit[0].metadata_json).toMatchObject({ roundNo: 2, closeReason: 'ready' });
    const linked = await pool.query("SELECT entity_id FROM audit_log_related_entity WHERE audit_id = $1 AND entity_type = 'order_detail'", [audit[0].audit_id]);
    expect(linked.rows.map((row) => Number(row.entity_id))).toEqual([readyAgain.detailIds[0]]);
    const outbox = (await pool.query("SELECT idempotency_key FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'order.rework_closed'", [String(readyAgain.orderId)])).rows;
    expect(outbox.map((row) => row.idempotency_key)).toEqual([`order:${readyAgain.orderId}:rework:2:closed:${round.event_seq}`]);
    // A later status change does not close anything again.
    await setStatusAsWriter(readyAgain.orderId, 'legacy_7');
    expect(Number((await pool.query("SELECT count(*) FROM audit_log WHERE related_order_id = $1 AND event = 'order.rework_closed'", [readyAgain.orderId])).rows[0].count)).toBe(1);

    const inProduction = await createOrder('legacy_4', 'cut', 1);
    await service.startOrExtend({
      currentUser: admin, orderId: inProduction.orderId, version: await version(inProduction.orderId), idempotencyKey: key(),
      dto: { reasonId: reasons.workshop_defect, details: [{ detailId: inProduction.detailIds[0], productionStatusId: stage.drawn }] },
    });
    // Same connection: a user command set app.user_id earlier; a later writer without it must not
    // be attributed to that user.
    const shared = await pool.connect();
    try {
      await shared.query('BEGIN');
      await shared.query('SELECT set_session_user($1)', [userId]);
      await shared.query('COMMIT');
      await shared.query('BEGIN');
      await shared.query('UPDATE orders SET order_status_id = $2, version = version + 1 WHERE order_id = $1', [inProduction.orderId, status.legacy_8]);
      await shared.query('COMMIT');
    } finally {
      shared.release();
    }
    const closedCompleted = (await pool.query('SELECT close_reason, closed_by FROM order_production_rounds WHERE order_id = $1', [inProduction.orderId])).rows[0];
    expect(closedCompleted).toMatchObject({ close_reason: 'completed', closed_by: null });
    const closedAudit = (await pool.query(
      "SELECT user_id FROM audit_log WHERE related_order_id = $1 AND event = 'order.rework_closed'", [inProduction.orderId],
    )).rows;
    expect(closedAudit).toEqual([{ user_id: null }]);
  });

  it('blocks transferring details of an order under rework (§5.3)', async () => {
    const source = await createOrder('legacy_6', 'packed', 2);
    const target = await createOrder('legacy_4', 'cut', 1);
    await service.startOrExtend({
      currentUser: admin, orderId: source.orderId, version: await version(source.orderId), idempotencyKey: key(),
      dto: { reasonId: reasons.workshop_defect, details: [{ detailId: source.detailIds[0], productionStatusId: stage.drawn }] },
    });
    const transfer = new OrderDetailTransferService({ database: database() } as never);
    // A foreign detail (another order under rework) gets the same 404 as any foreign detail.
    const foreign = await createOrder('legacy_6', 'packed', 1);
    await service.startOrExtend({
      currentUser: admin, orderId: foreign.orderId, version: await version(foreign.orderId), idempotencyKey: key(),
      dto: { reasonId: reasons.workshop_defect, details: [{ detailId: foreign.detailIds[0], productionStatusId: stage.drawn }] },
    });
    await expect(transfer.transfer({
      currentUser: admin, sourceOrderId: target.orderId, sourceVersion: await version(target.orderId), idempotencyKey: key(),
      dto: { detailIds: [foreign.detailIds[0]], target: { mode: 'existing', orderId: source.orderId, version: await version(source.orderId) } } as never,
    })).rejects.toMatchObject({ code: 'ORDER_DETAIL_NOT_FOUND' });
    for (const detailIds of [[source.detailIds[0]], [source.detailIds[1]]]) {
      await expect(transfer.transfer({
        currentUser: admin, sourceOrderId: source.orderId, sourceVersion: await version(source.orderId), idempotencyKey: key(),
        dto: { detailIds, target: { mode: 'existing', orderId: target.orderId, version: await version(target.orderId) } } as never,
      })).rejects.toMatchObject({ code: 'ORDER_REWORK_TRANSFER_BLOCKED' });
    }
    const still = (await pool.query('SELECT count(*) FROM order_details WHERE order_id = $1', [source.orderId])).rows[0];
    expect(Number(still.count)).toBe(2);
  });

  it('refuses automation rules that target «Переделка»; skips such a rule at runtime (§5.2)', async () => {
    const repository = new PgStatusAutomationRepository(database());
    await expect(repository.createRule({
      currentUser: admin, requestId: 'e2e-rework-rule',
      dto: parseCreateStatusAutomationRuleRequest({
        name: `E2E-Тест правило переделки ${tag}`, eventType: 'order.status_changed', actionType: 'change_order_status',
        targetStatusId: status.rework, conditions: {}, priority: 100, isEnabled: false,
      }),
    })).rejects.toMatchObject({ code: 'TARGET_STATUS_REWORK_FORBIDDEN' });
    // «Переделка» remains a valid condition.
    const allowed = await repository.createRule({
      currentUser: admin, requestId: 'e2e-rework-rule',
      dto: parseCreateStatusAutomationRuleRequest({
        name: `E2E-Тест правило условие ${tag}`, eventType: 'order.status_changed', actionType: 'change_order_status',
        targetStatusId: status.legacy_4, conditions: { currentOrderStatusIn: [status.rework] }, priority: 100, isEnabled: false,
      }),
    });
    await pool.query('DELETE FROM status_automation_rules WHERE id = $1', [allowed.id]);
    await pool.query("DELETE FROM audit_log WHERE request_id = 'e2e-rework-rule'");
    await pool.query("DELETE FROM outbox_events WHERE payload_json->>'requestId' = 'e2e-rework-rule'");

    const { orderId } = await createOrder('legacy_6', 'packed', 1);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await changeOrderStatusFromAutomationInTransaction(
        { raw: client, query: (text: string, params: readonly unknown[] = []) => client.query(text, [...params]) } as never,
        orderId, status.rework,
        { actor: admin, requestId: 'e2e-rework-runtime', outboxIdempotencyKey: `e2e-rework-runtime-${tag}` } as never,
      );
      expect(result).toMatchObject({ status: 'skipped', skipReason: 'rework_requires_command' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(Number((await pool.query('SELECT order_status_id FROM orders WHERE order_id = $1', [orderId])).rows[0].order_status_id)).toBe(status.legacy_6);
  });

  // ---------------------------------------------------------------- snapshot (§6.2)

  const snapshots = () => new PgOrderSnapshot(database());
  async function exportSnapshot(orderId: number): Promise<OrderSnapshotDto> {
    return JSON.parse((await snapshots().exportOrderSnapshot({ orderId, currentUser: admin, requestId: key() })).content) as OrderSnapshotDto;
  }
  /** Same content as another ERP instance would send: fresh source instance, unique order name. */
  function retarget(snapshot: OrderSnapshotDto, label: string): OrderSnapshotDto {
    const copy = structuredClone(snapshot);
    copy.source.sourceInstanceId = `${importSource}-${randomUUID()}`;
    copy.source.payloadHash = '';
    copy.data.order.orderName = `E2E-Тест переделка сервис ${tag} ${label}`;
    return copy;
  }
  async function importSnapshot(snapshot: OrderSnapshotDto) {
    const result = await snapshots().importOrderSnapshot({ snapshot, currentUser: admin, requestId: key() });
    if (!orderIds.includes(result.orderId)) {
      orderIds.push(result.orderId);
      const project = (await pool.query('SELECT project_id FROM orders WHERE order_id = $1', [result.orderId])).rows[0];
      if (project && Number(project.project_id) !== projectId) importProjectIds.push(Number(project.project_id));
    }
    return result;
  }
  const detailRounds = async (orderId: number) => (await pool.query(
    'SELECT detail_id, production_round FROM order_details WHERE order_id = $1 ORDER BY detail_number', [orderId],
  )).rows.map((row) => ({ detailId: Number(row.detail_id), round: Number(row.production_round) }));
  const roundRows = async (orderId: number) => (await pool.query(
    `SELECT r.round_no, r.mode, r.close_reason, r.event_seq, reason.code, r.reason_comment,
            (SELECT count(*)::int FROM order_production_round_details d
             WHERE d.order_production_round_id = r.order_production_round_id) AS details
     FROM order_production_rounds r JOIN order_rework_reasons reason ON reason.order_rework_reason_id = r.reason_id
     WHERE r.order_id = $1 ORDER BY r.round_no`, [orderId],
  )).rows.map((row) => [Number(row.round_no), row.mode, row.close_reason, Number(row.event_seq), row.code, row.reason_comment, row.details]);
  const eventRounds = async (orderId: number) => (await pool.query(
    `SELECT d.detail_number, e.production_status_id, e.round_no FROM production_status_events e
     JOIN order_details d ON d.detail_id = e.detail_id WHERE d.order_id = $1
     ORDER BY d.detail_number, e.round_no, e.production_status_id`, [orderId],
  )).rows.map((row) => [Number(row.detail_number), Number(row.production_status_id), Number(row.round_no)]);

  async function orderWithRounds(): Promise<{ orderId: number; detailIds: number[] }> {
    const created = await createOrder('legacy_6', 'packed', 2);
    await service.startOrExtend({
      currentUser: admin, orderId: created.orderId, version: await version(created.orderId), idempotencyKey: key(),
      dto: { reasonId: reasons.workshop_defect, details: [{ detailId: created.detailIds[0], productionStatusId: stage.drawn }] },
    });
    await setStatusAsWriter(created.orderId, 'legacy_6'); // closes round 2 (ready)
    await service.startOrExtend({
      currentUser: admin, orderId: created.orderId, version: await version(created.orderId), idempotencyKey: key(),
      dto: { reasonId: reasons.client_change, comment: 'цвет', details: [{ detailId: created.detailIds[1], productionStatusId: stage.cut }] },
    });
    return created;
  }

  it('exports an order without rounds as unchanged format 1.0.0', async () => {
    const { orderId } = await createOrder('legacy_6', 'packed', 1);
    const snapshot = await exportSnapshot(orderId);
    expect(snapshot.formatVersion).toBe('1.0.0');
    expect(snapshot.exporterService.compatibleImportVersions).toEqual(['1.0.0']);
    expect(snapshot.data.productionRounds).toBeUndefined();
    expect(snapshot.data.productionStatusEvents.every((event) => !('roundNo' in event))).toBe(true);
  });

  it('round-trips rounds 1/2/3 into a NEW order (open «Переделка»); re-import is noop/skipped; the next start there is round 4', async () => {
    const source = await orderWithRounds();
    const exported = await exportSnapshot(source.orderId);
    expect(exported.formatVersion).toBe('1.1.0');
    expect(exported.data.productionRounds).toMatchObject({
      productionRound: 3, lastRoundNo: 3,
      detailRounds: [
        { detailSourceId: String(source.detailIds[0]), productionRound: 2 },
        { detailSourceId: String(source.detailIds[1]), productionRound: 3 },
      ],
    });
    expect(exported.data.productionRounds?.rounds.map((round) => [round.roundNo, round.reasonCode, round.closeReason]))
      .toEqual([[2, 'workshop_defect', 'ready'], [3, 'client_change', null]]);

    const snapshot = retarget(exported, 'импорт кругов');
    const imported = await importSnapshot(snapshot);
    expect(imported.status).toBe('created');
    const order = (await pool.query('SELECT order_status_id, production_round, last_round_no FROM orders WHERE order_id = $1', [imported.orderId])).rows[0];
    expect([Number(order.order_status_id), Number(order.production_round), Number(order.last_round_no)]).toEqual([status.rework, 3, 3]);
    expect((await detailRounds(imported.orderId)).map((detail) => detail.round)).toEqual([2, 3]);
    expect(await roundRows(imported.orderId)).toEqual(await roundRows(source.orderId));
    expect(await eventRounds(imported.orderId)).toEqual(await eventRounds(source.orderId));
    // Order stage marks come from the snapshot only: the detail-stage automation (266) adds none for the
    // imported current round (round-1/2 details would otherwise mark their stages in round 3).
    expect(await orderMarks(imported.orderId)).toEqual(await orderMarks(source.orderId));
    const before = (await pool.query(
      `SELECT d.from_production_status_id, d.from_production_round, d.to_production_status_id FROM order_production_round_details d
       JOIN order_production_rounds r USING (order_production_round_id) WHERE r.order_id = $1 ORDER BY r.round_no`, [imported.orderId],
    )).rows.map((row) => [Number(row.from_production_status_id), Number(row.from_production_round), Number(row.to_production_status_id)]);
    expect(before).toEqual([[stage.packed, 1, stage.drawn], [stage.packed, 1, stage.cut]]);
    const audit = (await pool.query(
      "SELECT metadata_json FROM audit_log WHERE related_order_id = $1 AND event = 'orders.snapshot_import'", [imported.orderId],
    )).rows;
    expect(audit.map((row) => row.metadata_json.productionRoundNos)).toEqual([[2, 3]]);

    // Existing target (new and old format): noop/skipped, rounds and counters untouched.
    const rounds = await roundRows(imported.orderId);
    expect((await importSnapshot(snapshot)).status).toBe('noop');
    const oldFormat = structuredClone(snapshot);
    oldFormat.formatVersion = '1.0.0';
    delete oldFormat.data.productionRounds;
    for (const event of oldFormat.data.productionStatusEvents) delete event.roundNo;
    expect(await importSnapshot(oldFormat)).toMatchObject({ status: 'skipped', orderId: imported.orderId });
    expect(await roundRows(imported.orderId)).toEqual(rounds);

    await setStatusAsWriter(imported.orderId, 'legacy_6'); // closes the imported round 3
    const details = await detailRounds(imported.orderId);
    const next = await service.startOrExtend({
      currentUser: admin, orderId: imported.orderId, version: await version(imported.orderId), idempotencyKey: key(),
      dto: { reasonId: reasons.workshop_defect, details: [{ detailId: details[1].detailId, productionStatusId: stage.drawn }] },
    });
    expect(next).toMatchObject({ roundNo: 4, action: 'started' });
  });

  it('exports one consistent snapshot while a rework commits between its reads; audit records the file format', async () => {
    const { orderId, detailIds } = await createOrder('legacy_6', 'packed', 1);
    const plain = database();
    let injected = false;
    const racing = {
      ...plain,
      async transaction<T>(handler: (tx: TransactionClient) => Promise<T>, options: { isolation?: string } = {}): Promise<T> {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          if (options.isolation) await client.query(`SET TRANSACTION ISOLATION LEVEL ${options.isolation.toUpperCase()}`);
          const tx = {
            raw: client,
            query: async (text: string, params: readonly unknown[] = []) => {
              const result = await client.query(text, [...params]);
              // Right after the export read its header, a rework round commits on another connection.
              if (!injected && /INNER JOIN clients c ON c\.client_id = o\.client_id/.test(text)) {
                injected = true;
                await service.startOrExtend({
                  currentUser: admin, orderId, version: await version(orderId), idempotencyKey: key(),
                  dto: { reasonId: reasons.workshop_defect, details: [{ detailId: detailIds[0], productionStatusId: stage.drawn }] },
                });
              }
              return result;
            },
          } as never;
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
    } as unknown as DatabaseService;
    const raced = JSON.parse((await new PgOrderSnapshot(racing).exportOrderSnapshot({ orderId, currentUser: admin, requestId: key() })).content) as OrderSnapshotDto;
    expect(injected).toBe(true);
    // The whole file is the state before the rework: no rounds, format 1.0.0, importable.
    expect(raced.formatVersion).toBe('1.0.0');
    expect(raced.data.productionRounds).toBeUndefined();
    expect(Number((await pool.query('SELECT production_round FROM orders WHERE order_id = $1', [orderId])).rows[0].production_round)).toBe(2);
    const after = await exportSnapshot(orderId);
    expect(after.formatVersion).toBe('1.1.0');
    const formats = (await pool.query(
      "SELECT metadata_json->>'formatVersion' AS format FROM audit_log WHERE related_order_id = $1 AND event = 'orders.snapshot_export' ORDER BY created_at",
      [orderId],
    )).rows.map((row) => row.format);
    expect(formats).toEqual(['1.0.0', '1.1.0']);
  });

  it('import → «Это не переделка» → export → import stays valid', async () => {
    const source = await orderWithRounds();
    const imported = await importSnapshot(retarget(await exportSnapshot(source.orderId), 'отмена после импорта'));
    await service.falsePositive({
      currentUser: admin, orderId: imported.orderId, roundNo: 3, version: await version(imported.orderId), idempotencyKey: key(), dto: {},
    });
    const again = await exportSnapshot(imported.orderId);
    expect(again.data.productionRounds).toMatchObject({ productionRound: 2 });
    const reimported = await importSnapshot(retarget(again, 'повторный импорт после отмены'));
    expect(reimported.status).toBe('created');
    expect((await roundRows(reimported.orderId)).map((round) => [round[0], round[2]])).toEqual([[2, 'ready'], [3, 'false_positive']]);
  });

  it('imports an intermediate state: open round with «В производстве» after «Переделка»', async () => {
    const { orderId, detailIds } = await createOrder('legacy_6', 'packed', 1);
    await service.startOrExtend({
      currentUser: admin, orderId, version: await version(orderId), idempotencyKey: key(),
      dto: { reasonId: reasons.workshop_defect, details: [{ detailId: detailIds[0], productionStatusId: stage.drawn }] },
    });
    await setStatusAsWriter(orderId, 'legacy_4');
    const imported = await importSnapshot(retarget(await exportSnapshot(orderId), 'промежуточный'));
    expect(imported.status).toBe('created');
    const order = (await pool.query('SELECT order_status_id, production_round FROM orders WHERE order_id = $1', [imported.orderId])).rows[0];
    expect([Number(order.order_status_id), Number(order.production_round)]).toEqual([status.legacy_4, 2]);
    expect((await roundRows(imported.orderId)).map((round) => [round[0], round[2]])).toEqual([[2, null]]);
  });

  it('rejects inconsistent round snapshots before creating anything (422)', async () => {
    const source = await orderWithRounds();
    const exported = await exportSnapshot(source.orderId);
    const cases: Array<[string, (snapshot: OrderSnapshotDto) => void, string]> = [
      ['без открытого круга', (snapshot) => {
        const last = snapshot.data.productionRounds!.rounds[1];
        last.closedAt = last.startedAt;
        last.closeReason = 'ready';
      }, 'SNAPSHOT_ROUNDS_INVALID'],
      ['неизвестная причина', (snapshot) => { snapshot.data.productionRounds!.rounds[0].reasonCode = 'e2e_unknown_reason'; }, 'SNAPSHOT_REWORK_REASON_UNKNOWN'],
      ['формат 1.0.0 с кругами', (snapshot) => { snapshot.formatVersion = '1.0.0'; }, 'SNAPSHOT_ROUNDS_INVALID'],
      ['чужая деталь круга', (snapshot) => { snapshot.data.productionRounds!.rounds[0].details[0].detailSourceId = '999999999'; }, 'SNAPSHOT_ROUNDS_INVALID'],
      ['событие неизвестного круга', (snapshot) => { snapshot.data.productionStatusEvents[0].roundNo = 7; }, 'SNAPSHOT_ROUNDS_INVALID'],
      ['текущий круг не равен открытому', (snapshot) => { snapshot.data.productionRounds!.productionRound = 2; }, 'SNAPSHOT_ROUNDS_INVALID'],
      ['деталь открытого круга без detailRounds', (snapshot) => {
        snapshot.data.productionRounds!.detailRounds = snapshot.data.productionRounds!.detailRounds.filter((detail) => detail.productionRound !== 3);
      }, 'SNAPSHOT_ROUNDS_INVALID'],
      ['before-state открытого круга на отменённый круг', (snapshot) => {
        const rounds = snapshot.data.productionRounds!;
        rounds.rounds[0].closeReason = 'false_positive';
        rounds.detailRounds = rounds.detailRounds.filter((detail) => detail.productionRound === 3);
        rounds.rounds[1].details[0].fromProductionRound = 1;
      }, 'SNAPSHOT_ROUNDS_INVALID'],
      ['отмена вернёт деталь ниже живого круга', (snapshot) => {
        const rounds = snapshot.data.productionRounds!;
        // Detail 2 also belonged to round 2 (closed ready); round 3 would restore it to round 1.
        rounds.rounds[0].details.push({ ...rounds.rounds[0].details[0], detailSourceId: rounds.rounds[1].details[0].detailSourceId });
        rounds.rounds[1].details[0].fromProductionRound = 1;
      }, 'SNAPSHOT_ROUNDS_INVALID'],
      ['отмена after_ready вернёт статус «Переделка»', (snapshot) => {
        snapshot.data.productionRounds!.rounds[1].fromOrderStatusId = status.rework;
      }, 'SNAPSHOT_ROUNDS_INVALID'],
      ['in_production при статусе «Переделка»', (snapshot) => {
        snapshot.data.productionRounds!.rounds[1].mode = 'in_production';
      }, 'SNAPSHOT_ROUNDS_INVALID'],
      ['деталь возвращается в круг, где её не было', (snapshot) => {
        snapshot.data.productionRounds!.rounds[1].details[0].fromProductionRound = 2;
      }, 'SNAPSHOT_ROUNDS_INVALID'],
      ['before-state на отсутствующий круг', (snapshot) => {
        snapshot.data.productionRounds!.rounds = snapshot.data.productionRounds!.rounds.filter((round) => round.roundNo === 3);
        snapshot.data.productionRounds!.detailRounds = snapshot.data.productionRounds!.detailRounds.filter((detail) => detail.productionRound === 3);
        for (const event of snapshot.data.productionStatusEvents) if (event.roundNo === 2) event.roundNo = 1;
      }, 'SNAPSHOT_ROUNDS_INVALID'],
    ];
    for (const [label, mutate, code] of cases) {
      const snapshot = retarget(exported, `отказ ${label}`);
      mutate(snapshot);
      await expect(importSnapshot(snapshot), label).rejects.toMatchObject({ code });
      const created = await pool.query('SELECT count(*)::int AS n FROM orders WHERE order_name = $1', [snapshot.data.order.orderName]);
      expect(created.rows[0].n, label).toBe(0);
    }
  });

  it('fails fast with 409 when the MDF cutover holds the fence; a direct «Переделка» insert without marker is refused', async () => {
    const source = await orderWithRounds();
    const snapshot = retarget(await exportSnapshot(source.orderId), 'fence');
    const cutover = await pool.connect();
    try {
      await cutover.query('BEGIN');
      await cutover.query("SELECT pg_advisory_xact_lock(hashtextextended('mdf-engine-cutover', 0))");
      await expect(importSnapshot(snapshot)).rejects.toMatchObject({ code: 'ORDER_REWORK_MDF_CUTOVER_IN_PROGRESS' });
    } finally {
      await cutover.query('ROLLBACK').catch(() => undefined);
      cutover.release();
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM orders WHERE order_name = $1', [snapshot.data.order.orderName])).rows[0].n).toBe(0);
    await expect(pool.query(
      'INSERT INTO orders (order_name, client_id, project_id, order_status_id, created_by) VALUES ($1, $2, $3, $4, $5)',
      [`E2E-Тест переделка сервис ${tag} прямая вставка`, clientId, projectId, status.rework, userId],
    )).rejects.toMatchObject({ message: expect.stringContaining('ORDER_REWORK_REQUIRES_COMMAND') });
  });

  // ------------------------------------------------ deferred realtime drain (§5.7 п.5)

  function drainService(enabled = true): OrderRealtimeDeferredDrainService {
    return new OrderRealtimeDeferredDrainService(new ConfigService({
      BACKEND_ORDER_REALTIME_DEFERRED_DRAIN: enabled, DATABASE_URL: databaseUrl, DATABASE_QUERY_TIMEOUT_MS: 10000,
    }) as never);
  }
  const queueRows = async (orderId: number) => (await pool.query(
    'SELECT attempts FROM order_realtime_deferred WHERE order_id = $1 ORDER BY order_realtime_deferred_id', [orderId],
  )).rows.map((row) => Number(row.attempts));
  const logCount = async (orderId: number) => Number((await pool.query(
    'SELECT count(*) FROM realtime_event_log WHERE order_id = $1', [orderId],
  )).rows[0].count);

  async function queuedOrder(): Promise<number> {
    const { orderId, detailIds } = await createOrder('legacy_6', 'packed', 1);
    await service.startOrExtend({
      currentUser: admin, orderId, version: await version(orderId), idempotencyKey: key(),
      dto: { reasonId: reasons.workshop_defect, details: [{ detailId: detailIds[0], productionStatusId: stage.drawn }] },
    });
    expect((await queueRows(orderId)).length).toBeGreaterThan(0);
    return orderId;
  }

  it('drain delivers the deferred emissions through emit_one and empties the queue', async () => {
    const orderId = await queuedOrder();
    const before = await logCount(orderId);
    const drain = drainService();
    try {
      expect(await drain.drainOrder(orderId)).toBe('delivered');
      expect(await queueRows(orderId)).toEqual([]);
      expect(await logCount(orderId)).toBeGreaterThan(before);
      expect(await drain.drainOrder(orderId)).toBe('empty');
    } finally {
      await drain.onModuleDestroy();
    }
  });

  it.each([
    ['the stream row is locked by another writer', 'SELECT 1 FROM order_realtime_stream WHERE order_id = $1 FOR UPDATE', true],
    ['DDL holds ACCESS EXCLUSIVE on app_settings', 'LOCK TABLE app_settings IN ACCESS EXCLUSIVE MODE', false],
    ['DDL holds ACCESS EXCLUSIVE on the event log', 'LOCK TABLE realtime_event_log IN ACCESS EXCLUSIVE MODE', false],
  ] as const)('drain never waits when %s: busy, queue kept with backoff, delivered afterwards', async (_label, holdSql, withOrder) => {
    const orderId = await queuedOrder();
    const holder = await pool.connect();
    const drain = drainService();
    try {
      await holder.query('BEGIN');
      await holder.query(holdSql, withOrder ? [orderId] : []);
      const started = Date.now();
      const result = await drain.drainOrder(orderId);
      expect(result).toBe('busy');
      expect(Date.now() - started).toBeLessThan(2000);
      await holder.query('ROLLBACK');
      const attempts = await queueRows(orderId);
      expect(attempts.length).toBeGreaterThan(0);
      // The backoff itself may be skipped when the queue table was the locked one; never an error.
      expect(attempts.every((value) => value <= 1)).toBe(true);
      expect(await drain.drainOrder(orderId)).toBe('delivered');
      expect(await queueRows(orderId)).toEqual([]);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      await drain.onModuleDestroy();
    }
  });

  it('with the drain flag off the queue is kept; after enabling, the sweeper delivers it', async () => {
    const orderId = await queuedOrder();
    const off = drainService(false);
    off.onModuleInit();
    off.request([orderId]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await queueRows(orderId)).length).toBeGreaterThan(0);
    await off.onModuleDestroy();

    const on = drainService(true);
    try {
      on.onModuleInit(); // first sweep runs immediately
      for (let i = 0; i < 50 && (await queueRows(orderId)).length > 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(await queueRows(orderId)).toEqual([]);
    } finally {
      await on.onModuleDestroy();
    }
  });

  it('bridge switched off before the drain: queue kept; delivered once it is on again', async () => {
    const orderId = await queuedOrder();
    const setting = (await pool.query("SELECT value_json FROM app_settings WHERE setting_key = 'order_realtime.writes'")).rows[0];
    const drain = drainService();
    try {
      await pool.query(
        "UPDATE app_settings SET value_json = jsonb_set(value_json, '{enabled}', 'false'::jsonb) WHERE setting_key = 'order_realtime.writes'");
      expect(await drain.drainOrder(orderId)).toBe('bridge_disabled');
      expect((await queueRows(orderId)).length).toBeGreaterThan(0);
    } finally {
      await pool.query("UPDATE app_settings SET value_json = $1 WHERE setting_key = 'order_realtime.writes'", [setting.value_json]);
    }
    try {
      expect(await drain.drainOrder(orderId)).toBe('delivered');
      expect(await queueRows(orderId)).toEqual([]);
    } finally {
      await drain.onModuleDestroy();
    }
    expect((await pool.query("SELECT value_json FROM app_settings WHERE setting_key = 'order_realtime.writes'")).rows[0].value_json)
      .toEqual(setting.value_json);
  });

  it.each(['FOR UPDATE', 'FOR NO KEY UPDATE'] as const)(
    'drain holds the stream while a command holds the order (%s) and waits for the stream: the command completes, no deadlock, delivered once',
    async (orderLock) => {
      const orderId = await queuedOrder();
      const queued = (await queueRows(orderId)).length;
      const before = await logCount(orderId);
      const other = await pool.connect();
      let otherDone: Promise<unknown> | null = null;
      class SeamDrain extends OrderRealtimeDeferredDrainService {
        protected override async afterStreamLocked(): Promise<void> {
          if (otherDone) return; // only the first attempt races the command
          await other.query('BEGIN');
          await other.query(`SELECT 1 FROM orders WHERE order_id = $1 ${orderLock}`, [orderId]);
          // The command now needs the stream, which the drain holds: it waits.
          otherDone = other.query('SELECT 1 FROM order_realtime_stream WHERE order_id = $1 FOR UPDATE', [orderId]);
          for (let i = 0; i < 50; i += 1) {
            const waiting = await pool.query(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FROM order_realtime_stream WHERE order_id = $1 FOR UPDATE'");
            if (waiting.rows[0].n > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
      }
      const drain = new SeamDrain(new ConfigService({
        BACKEND_ORDER_REALTIME_DEFERRED_DRAIN: true, DATABASE_URL: databaseUrl, DATABASE_QUERY_TIMEOUT_MS: 10000,
      }) as never);
      try {
        const result = await drain.drainOrder(orderId);
        // FOR UPDATE conflicts with the drain's KEY SHARE NOWAIT → the drain yields;
        // FOR NO KEY UPDATE is compatible → the drain finishes first and the command follows.
        expect(result).toBe(orderLock === 'FOR UPDATE' ? 'busy' : 'delivered');
        await otherDone; // the command got the stream: not a deadlock victim
        await other.query('COMMIT');
        if (result === 'busy') {
          expect((await queueRows(orderId)).length).toBe(queued);
          expect(await drain.drainOrder(orderId)).toBe('delivered');
        }
        expect(await queueRows(orderId)).toEqual([]);
        expect(await logCount(orderId)).toBe(before + queued); // delivered exactly once
      } finally {
        await other.query('ROLLBACK').catch(() => undefined);
        other.release();
        await drain.onModuleDestroy();
      }
    },
  );

  it('rework_managers resolves active holders of orders.rework through the role matrix (real SQL)', async () => {
    const roleId = Number((await pool.query('SELECT role_id FROM users WHERE user_id = $1', [userId])).rows[0].role_id);
    const had = (await pool.query(
      "SELECT is_enabled FROM role_permissions WHERE role_id = $1 AND permission_name = 'orders.rework'", [roleId])).rows[0];
    const catalogHad = (await pool.query("SELECT is_active FROM permissions_catalog WHERE permission_name = 'orders.rework'")).rows[0];
    try {
      if (!catalogHad) {
        await pool.query(`INSERT INTO permissions_catalog (permission_name, domain, label, sort_order, is_dangerous)
          VALUES ('orders.rework', 'orders', 'Заказы: переделка', 9999, false)`);
      }
      await pool.query(`INSERT INTO role_permissions (role_id, permission_name, is_enabled) VALUES ($1, 'orders.rework', true)
        ON CONFLICT (role_id, permission_name) DO UPDATE SET is_enabled = true`, [roleId]);
      const resolve = () => new PgRecipientSourceAdapter().resolveDynamic(pool as never, 'rework_managers', {
        eventType: 'order.rework_started', orderId: 1, groupIds: [] } as never);
      expect(await resolve()).toContain(userId);
      await pool.query("UPDATE role_permissions SET is_enabled = false WHERE role_id = $1 AND permission_name = 'orders.rework'", [roleId]);
      expect(await resolve()).not.toContain(userId);
    } finally {
      if (had) {
        await pool.query("UPDATE role_permissions SET is_enabled = $2 WHERE role_id = $1 AND permission_name = 'orders.rework'", [roleId, had.is_enabled]);
      } else {
        await pool.query("DELETE FROM role_permissions WHERE role_id = $1 AND permission_name = 'orders.rework'", [roleId]);
      }
      if (!catalogHad) await pool.query("DELETE FROM permissions_catalog WHERE permission_name = 'orders.rework'");
    }
  });

  it('rework notifications reach only users the LIVE role matrix lets see the order (resolver → visibility)', async () => {
    const roleId = ROLE_TO_ROLE_ID.manager;
    const { orderId } = await createOrder('legacy_6', 'packed', 1);
    const foreign = await createOrder('legacy_6', 'packed', 1);
    // A foreign order: created by another (fixture) user.
    const otherUserId = Number((await pool.query(
      "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, 'x') RETURNING user_id",
      [`e2e_rework_other_${tag}`, `e2e_rework_other_${tag}@example.invalid`],
    )).rows[0].user_id);
    await pool.query('UPDATE orders SET created_by = $2, manager_id = NULL WHERE order_id = $1', [foreign.orderId, otherUserId]);
    const originalRole = (await pool.query('SELECT role_id FROM users WHERE user_id = $1', [userId])).rows[0].role_id;
    const snapshot = {
      permissions: (await pool.query('SELECT permission_name, is_enabled FROM role_permissions WHERE role_id = $1', [roleId])).rows,
      scopes: (await pool.query('SELECT scope_key, scope_value FROM role_policy_scopes WHERE role_id = $1', [roleId])).rows,
      catalog: (await pool.query("SELECT permission_name FROM permissions_catalog WHERE permission_name IN ('orders.rework','orders.view')")).rows
        .map((row) => row.permission_name as string),
    };
    const setPermission = (name: string, enabled: boolean) => pool.query(
      `INSERT INTO role_permissions (role_id, permission_name, is_enabled) VALUES ($1, $2, $3)
       ON CONFLICT (role_id, permission_name) DO UPDATE SET is_enabled = EXCLUDED.is_enabled`, [roleId, name, enabled]);
    const setScope = (value: string) => pool.query(
      `INSERT INTO role_policy_scopes (role_id, scope_key, scope_value) VALUES ($1, 'orders.view', $2)
       ON CONFLICT (role_id, scope_key) DO UPDATE SET scope_value = EXCLUDED.scope_value`, [roleId, value]);
    const resolver = new RecipientResolverService(new PgRecipientSourceAdapter(), new PgVisibilityAdapter());
    const recipients = (order: number) => resolver.resolve(pool as never, { resolvers: ['rework_managers'] },
      { eventType: 'order.rework_started', orderId: order, groupIds: [] } as never);
    try {
      for (const name of ['orders.rework', 'orders.view']) {
        if (!snapshot.catalog.includes(name)) {
          await pool.query(`INSERT INTO permissions_catalog (permission_name, domain, label, sort_order, is_dangerous)
            VALUES ($1, 'orders', $1, 9999, false)`, [name]);
        }
      }
      await pool.query('UPDATE users SET role_id = $2 WHERE user_id = $1', [userId, roleId]);
      await setPermission('orders.rework', true);
      await setPermission('orders.view', true);
      await setScope('all');
      expect(await recipients(orderId)).toContain(userId);
      await setPermission('orders.view', false);
      expect(await recipients(orderId)).not.toContain(userId);
      await setPermission('orders.view', true);
      await setScope('none');
      expect(await recipients(orderId)).not.toContain(userId);
      await setScope('own');
      expect(await recipients(orderId)).toContain(userId); // created by the test user
      expect(await recipients(foreign.orderId)).not.toContain(userId);
    } finally {
      await pool.query('UPDATE orders SET created_by = $2 WHERE order_id = $1', [foreign.orderId, userId]);
      await pool.query('DELETE FROM audit_log WHERE user_id = $1', [String(otherUserId)]).catch(() => undefined);
      await pool.query('DELETE FROM users WHERE user_id = $1', [otherUserId]);
      await pool.query('UPDATE users SET role_id = $2 WHERE user_id = $1', [userId, originalRole]);
      await pool.query("DELETE FROM role_permissions WHERE role_id = $1 AND permission_name IN ('orders.rework','orders.view')", [roleId]);
      for (const row of snapshot.permissions.filter((r) => ['orders.rework', 'orders.view'].includes(r.permission_name))) {
        await setPermission(row.permission_name, row.is_enabled);
      }
      await pool.query("DELETE FROM role_policy_scopes WHERE role_id = $1 AND scope_key = 'orders.view'", [roleId]);
      for (const row of snapshot.scopes.filter((r) => r.scope_key === 'orders.view')) await setScope(row.scope_value);
      for (const name of ['orders.rework', 'orders.view']) {
        if (!snapshot.catalog.includes(name)) await pool.query('DELETE FROM permissions_catalog WHERE permission_name = $1', [name]);
      }
    }
    const after = {
      permissions: (await pool.query('SELECT permission_name, is_enabled FROM role_permissions WHERE role_id = $1', [roleId])).rows,
      scopes: (await pool.query('SELECT scope_key, scope_value FROM role_policy_scopes WHERE role_id = $1', [roleId])).rows,
    };
    const sortRows = (rows: Array<Record<string, unknown>>) => rows.map((r) => JSON.stringify(r)).sort();
    expect(sortRows(after.permissions)).toEqual(sortRows(snapshot.permissions));
    expect(sortRows(after.scopes)).toEqual(sortRows(snapshot.scopes));
  });

  it('assigned scope: only the workshop-responsible user receives rework and ordinary order notifications', async () => {
    const roleId = ROLE_TO_ROLE_ID.operator;
    const { orderId } = await createOrder('legacy_6', 'packed', 1);
    const originalRole = (await pool.query('SELECT role_id, employee_id FROM users WHERE user_id = $1', [userId])).rows[0];
    const snapshot = {
      permissions: (await pool.query('SELECT permission_name, is_enabled FROM role_permissions WHERE role_id = $1', [roleId])).rows,
      scopes: (await pool.query('SELECT scope_key, scope_value FROM role_policy_scopes WHERE role_id = $1', [roleId])).rows,
      catalog: (await pool.query("SELECT permission_name FROM permissions_catalog WHERE permission_name IN ('orders.rework','orders.view')")).rows
        .map((row) => row.permission_name as string),
    };
    const setPermission = (name: string, enabled: boolean) => pool.query(
      `INSERT INTO role_permissions (role_id, permission_name, is_enabled) VALUES ($1, $2, $3)
       ON CONFLICT (role_id, permission_name) DO UPDATE SET is_enabled = EXCLUDED.is_enabled`, [roleId, name, enabled]);
    const setScope = (value: string) => pool.query(
      `INSERT INTO role_policy_scopes (role_id, scope_key, scope_value) VALUES ($1, 'orders.view', $2)
       ON CONFLICT (role_id, scope_key) DO UPDATE SET scope_value = EXCLUDED.scope_value`, [roleId, value]);
    const employeeId = Number((await pool.query(
      "INSERT INTO employees (position, full_name) VALUES ('E2E', $1) RETURNING employee_id", [`E2E-Тест исполнитель ${tag}`])).rows[0].employee_id);
    const workshopId = Number((await pool.query(
      'INSERT INTO workshops (workshop_name) VALUES ($1) RETURNING workshop_id', [`E2E-Тест цех ${tag}`])).rows[0].workshop_id);
    const otherUserId = Number((await pool.query(
      "INSERT INTO users (username, email, password_hash, role_id) VALUES ($1, $2, 'x', $3) RETURNING user_id",
      [`e2e_rework_unassigned_${tag}`, `e2e_rework_unassigned_${tag}@example.invalid`, roleId])).rows[0].user_id);
    const resolver = new RecipientResolverService(new PgRecipientSourceAdapter(), new PgVisibilityAdapter());
    // Only this test's users are judged: real users of a stage copy (e.g. admins with scope «all») also see the order.
    const recipients = async (eventType: string, resolvers: string[]) => (await resolver.resolve(pool as never, { resolvers: resolvers as never },
      { eventType, orderId, groupIds: [] } as never)).filter((id: number) => id === userId || id === otherUserId);
    let orderWorkshopId: number | null = null;
    try {
      for (const name of ['orders.rework', 'orders.view']) {
        if (!snapshot.catalog.includes(name)) {
          await pool.query(`INSERT INTO permissions_catalog (permission_name, domain, label, sort_order, is_dangerous)
            VALUES ($1, 'orders', $1, 9999, false)`, [name]);
        }
      }
      await pool.query('UPDATE users SET role_id = $2, employee_id = $3 WHERE user_id = $1', [userId, roleId, employeeId]);
      await setPermission('orders.rework', true);
      await setPermission('orders.view', true);
      await setScope('assigned');
      // Not assigned yet: nobody sees the order.
      expect(await recipients('order.rework_started', ['rework_managers'])).toEqual([]);
      orderWorkshopId = Number((await pool.query(
        `INSERT INTO order_workshops (order_id, workshop_id, production_status_id, created_by, responsible_employee_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING order_workshop_id`,
        [orderId, workshopId, stage.packed, userId, employeeId])).rows[0].order_workshop_id);
      expect(await recipients('order.rework_started', ['rework_managers'])).toEqual([userId]);
      expect(await recipients('order.status_changed', ['stage_assignee'])).toEqual([userId]);
      // Unassigned user of the same role never; removed assignment → nobody.
      expect(await recipients('order.rework_started', ['rework_managers'])).not.toContain(otherUserId);
      await pool.query('UPDATE order_workshops SET delete_flag = true WHERE order_workshop_id = $1', [orderWorkshopId]);
      expect(await recipients('order.rework_started', ['rework_managers'])).toEqual([]);
    } finally {
      if (orderWorkshopId) await pool.query('DELETE FROM order_workshops WHERE order_workshop_id = $1', [orderWorkshopId]);
      await pool.query('UPDATE users SET role_id = $2, employee_id = $3 WHERE user_id = $1', [userId, originalRole.role_id, originalRole.employee_id]);
      await pool.query('DELETE FROM users WHERE user_id = $1', [otherUserId]);
      await pool.query('DELETE FROM workshops WHERE workshop_id = $1', [workshopId]);
      await pool.query('DELETE FROM employees WHERE employee_id = $1', [employeeId]);
      await pool.query("DELETE FROM role_permissions WHERE role_id = $1 AND permission_name IN ('orders.rework','orders.view')", [roleId]);
      for (const row of snapshot.permissions.filter((r) => ['orders.rework', 'orders.view'].includes(r.permission_name))) {
        await setPermission(row.permission_name, row.is_enabled);
      }
      await pool.query("DELETE FROM role_policy_scopes WHERE role_id = $1 AND scope_key = 'orders.view'", [roleId]);
      for (const row of snapshot.scopes.filter((r) => r.scope_key === 'orders.view')) await setScope(row.scope_value);
      for (const name of ['orders.rework', 'orders.view']) {
        if (!snapshot.catalog.includes(name)) await pool.query('DELETE FROM permissions_catalog WHERE permission_name = $1', [name]);
      }
    }
    const sortRows = (rows: Array<Record<string, unknown>>) => rows.map((r) => JSON.stringify(r)).sort();
    expect(sortRows((await pool.query('SELECT permission_name, is_enabled FROM role_permissions WHERE role_id = $1', [roleId])).rows))
      .toEqual(sortRows(snapshot.permissions));
    expect(sortRows((await pool.query('SELECT scope_key, scope_value FROM role_policy_scopes WHERE role_id = $1', [roleId])).rows))
      .toEqual(sortRows(snapshot.scopes));
  });

  it('reason catalogue: references.manage, generated code, duplicates, stale edits, system reason, deactivation, audit', async () => {
    const catalog = new OrderReworkReasonCatalogService(database());
    const name = `E2E-Тест причина ${tag}`;
    const noManage = { ...admin, permissions: admin.permissions.filter((p) => p !== 'references.manage') };
    await expect(catalog.list(noManage)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(catalog.create(noManage, { name })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    let createdId: number | null = null;
    try {
      const created = await catalog.create(admin, { name, requiresComment: true, sortOrder: 55 }, 'e2e-reason');
      createdId = created.reasonId;
      expect(created).toMatchObject({ name, requiresComment: true, sortOrder: 55, isSystem: false, isActive: true, usedRounds: 0 });
      expect(created.code).toMatch(/^custom_[0-9a-f]{8}$/);
      await expect(catalog.create(admin, { name: name.toUpperCase() })).rejects.toMatchObject({ code: 'ORDER_REWORK_REASON_DUPLICATE' });
      await expect(catalog.create(admin, { name: `${name} 2`, code: created.code })).rejects.toMatchObject({ code: 'ORDER_REWORK_REASON_DUPLICATE' });

      const renamed = await catalog.update(admin, created.reasonId, { expectedUpdatedAt: created.updatedAt, name: `${name} изм` });
      expect(renamed).toMatchObject({ name: `${name} изм`, code: created.code });
      await expect(catalog.update(admin, created.reasonId, { expectedUpdatedAt: created.updatedAt, sortOrder: 1 }))
        .rejects.toMatchObject({ code: 'ORDER_REWORK_REASON_STALE' });
      const deactivated = await catalog.update(admin, created.reasonId, { expectedUpdatedAt: renamed.updatedAt, isActive: false });
      expect(deactivated.isActive).toBe(false);
      expect((await service.listReasons(admin)).data.map((r) => r.reasonId)).not.toContain(created.reasonId);
      expect((await catalog.list(admin)).data.find((r) => r.reasonId === created.reasonId)?.isActive).toBe(false);

      const system = (await catalog.list(admin)).data.find((r) => r.code === 'unclarified')!;
      await expect(catalog.update(admin, system.reasonId, { expectedUpdatedAt: system.updatedAt, name: 'x' }))
        .rejects.toMatchObject({ code: 'ORDER_REWORK_REASON_SYSTEM' });

      const audits = (await pool.query(
        "SELECT event FROM audit_log WHERE entity_type = 'order_rework_reason' AND entity_id = $1 ORDER BY created_at, audit_id",
        [String(created.reasonId)])).rows.map((row) => row.event);
      expect(audits).toEqual(['order_rework_reason.created', 'order_rework_reason.updated', 'order_rework_reason.updated']);
    } finally {
      if (createdId) {
        await pool.query(
          "DELETE FROM audit_log_related_entity WHERE audit_id IN (SELECT audit_id FROM audit_log WHERE entity_type = 'order_rework_reason' AND entity_id = $1)",
          [String(createdId)]);
        await pool.query("DELETE FROM audit_log WHERE entity_type = 'order_rework_reason' AND entity_id = $1", [String(createdId)]);
        await pool.query('DELETE FROM order_rework_reasons WHERE order_rework_reason_id = $1', [createdId]);
      }
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM order_rework_reasons WHERE name LIKE $1', [`E2E-Тест причина ${tag}%`])).rows[0].n).toBe(0);
  });

  it('order read DTO carries production rounds of the order and details', async () => {
    const { orderId, detailIds } = await createOrder('legacy_6', 'packed', 2);
    await service.startOrExtend({
      currentUser: admin, orderId, version: await version(orderId), idempotencyKey: key(),
      dto: { reasonId: reasons.workshop_defect, details: [{ detailId: detailIds[0], productionStatusId: stage.drawn }] },
    });
    const { PgOrderReadRepository } = await import('../adapters/pg-order-read-repository');
    const repo = new PgOrderReadRepository(pool as never);
    const order = await repo.getOrderById({ currentUser: admin, orderId }) as unknown as { header: { productionRound: number; lastRoundNo: number }; details: Array<{ id: number; productionRound: number }> };
    expect([order.header.productionRound, order.header.lastRoundNo]).toEqual([2, 2]);
    expect(order.details.map((d) => [d.id, d.productionRound])).toEqual([[detailIds[0], 2], [detailIds[1], 1]]);
  });

  it('rounds response tells the UI which rework action the order allows now', async () => {
    const ready = await createOrder('legacy_6', 'packed', 1);
    expect((await service.listRounds(admin, ready.orderId)).order).toMatchObject({ action: 'return', openRoundNo: null, productionRound: 1 });
    await service.startOrExtend({
      currentUser: admin, orderId: ready.orderId, version: await version(ready.orderId), idempotencyKey: key(),
      dto: { reasonId: reasons.workshop_defect, details: [{ detailId: ready.detailIds[0], productionStatusId: stage.drawn }] },
    });
    expect((await service.listRounds(admin, ready.orderId)).order).toMatchObject({
      action: 'extend', openRoundNo: 2, productionRound: 2, orderStatusCode: 'rework', version: await version(ready.orderId),
    });
    const inProduction = await createOrder('legacy_4', 'cut', 1);
    expect((await service.listRounds(admin, inProduction.orderId)).order.action).toBe('start_in_production');
    const completed = await createOrder('legacy_8', 'packed', 1);
    expect((await service.listRounds(admin, completed.orderId)).order.action).toBeNull();
  });

  it('refuses round commands while the MDF engine is active or read-only; the UI is told why', async () => {
    const ready = await createOrder('legacy_6', 'packed', 1);
    try {
      for (const mode of ['active', 'read_only']) {
        await pool.query('UPDATE mdf_engine_state SET mode = $1 WHERE singleton', [mode]);
        const before = await version(ready.orderId);
        await expect(service.startOrExtend({
          currentUser: admin, orderId: ready.orderId, version: before, idempotencyKey: key(),
          dto: { reasonId: reasons.workshop_defect, details: [{ detailId: ready.detailIds[0], productionStatusId: stage.drawn }] },
        })).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_REWORK_MDF_ENGINE_UNSUPPORTED' });
        expect(await version(ready.orderId)).toBe(before);
        expect((await pool.query('SELECT count(*)::int n FROM order_production_rounds WHERE order_id = $1', [ready.orderId])).rows[0].n).toBe(0);
        expect(await service.availability()).toEqual({ availability: 'mdf_engine_unsupported' });
      }
    } finally {
      await pool.query("UPDATE mdf_engine_state SET mode = 'legacy' WHERE singleton");
    }
  });

  it('reason catalogue under concurrency: case-insensitive duplicates → exactly one wins, the other 409 (never 500)', async () => {
    const catalog = new OrderReworkReasonCatalogService(database());
    const base = `E2E-Тест гонка ${tag}`;
    const created: number[] = [];
    try {
      const results = await Promise.allSettled([
        catalog.create(admin, { name: `${base} скол` }),
        catalog.create(admin, { name: `${base} СКОЛ` }),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled') as Array<PromiseFulfilledResult<{ reasonId: number }>>;
      ok.forEach((r) => created.push(r.value.reasonId));
      expect(ok).toHaveLength(1);
      expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)
        .toMatchObject({ statusCode: 409, code: 'ORDER_REWORK_REASON_DUPLICATE' });

      const a = await catalog.create(admin, { name: `${base} А` });
      const b = await catalog.create(admin, { name: `${base} Б` });
      created.push(a.reasonId, b.reasonId);
      const renames = await Promise.allSettled([
        catalog.update(admin, a.reasonId, { expectedUpdatedAt: a.updatedAt, name: `${base} общий` }),
        catalog.update(admin, b.reasonId, { expectedUpdatedAt: b.updatedAt, name: `${base} ОБЩИЙ` }),
      ]);
      expect(renames.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((renames.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)
        .toMatchObject({ code: 'ORDER_REWORK_REASON_DUPLICATE' });
    } finally {
      for (const id of created) {
        await pool.query(
          "DELETE FROM audit_log_related_entity WHERE audit_id IN (SELECT audit_id FROM audit_log WHERE entity_type = 'order_rework_reason' AND entity_id = $1)",
          [String(id)]);
        await pool.query("DELETE FROM audit_log WHERE entity_type = 'order_rework_reason' AND entity_id = $1", [String(id)]);
        await pool.query('DELETE FROM order_rework_reasons WHERE order_rework_reason_id = $1', [id]);
      }
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM order_rework_reasons WHERE name ILIKE $1', [`${base}%`])).rows[0].n).toBe(0);
  });

  it('the reason of a closed round can still be clarified (history action)', async () => {
    const { orderId, detailIds } = await createOrder('legacy_6', 'packed', 1);
    await service.startOrExtend({
      currentUser: admin, orderId, version: await version(orderId), idempotencyKey: key(),
      dto: { reasonId: reasons.workshop_defect, details: [{ detailId: detailIds[0], productionStatusId: stage.drawn }] },
    });
    await setStatusAsWriter(orderId, 'legacy_6'); // closes round 2
    const clarified = await service.clarifyReason({
      currentUser: admin, orderId, roundNo: 2, version: await version(orderId), idempotencyKey: key(),
      dto: { reasonId: reasons.client_change, comment: 'уточнили после выдачи' },
    });
    expect(clarified).toMatchObject({ action: 'reason_clarified', roundNo: 2 });
    const round = (await service.listRounds(admin, orderId)).data[0];
    expect(round).toMatchObject({ reasonCode: 'client_change', closeReason: 'ready' });
  });

  it('rounds and order version come from one snapshot even if a round starts between the reads', async () => {
    const { orderId, detailIds } = await createOrder('legacy_6', 'packed', 1);
    const before = await version(orderId);
    let injected = false;
    const plain = database();
    const racing = {
      ...plain,
      async transaction<T>(handler: (tx: TransactionClient) => Promise<T>, options: { isolation?: string } = {}): Promise<T> {
        return plain.transaction(async (tx) => handler({
          ...tx,
          query: async (text: string, params: readonly unknown[] = []) => {
            // After the order row was read, a rework round commits on another connection.
            if (!injected && text.includes('FROM order_production_rounds r')) {
              injected = true;
              await service.startOrExtend({
                currentUser: admin, orderId, version: before, idempotencyKey: key(),
                dto: { reasonId: reasons.workshop_defect, details: [{ detailId: detailIds[0], productionStatusId: stage.drawn }] },
              });
            }
            return tx.query(text, params as unknown[]);
          },
        } as never), options as never);
      },
    } as unknown as DatabaseService;
    const reader = new OrderReworkService({ database: racing, isEnabled: () => true, readOrder: async () => ({}) as OrderDto });
    const state = await reader.listRounds(admin, orderId);
    expect(injected).toBe(true);
    // The pair is the pre-round snapshot: version N with no rounds (not N with round 2).
    expect(state.order).toMatchObject({ version: before, openRoundNo: null, productionRound: 1, action: 'return' });
    expect(state.data).toEqual([]);
    expect(await version(orderId)).toBeGreaterThan(before);
  });

  it('canRework mirrors the command gates: orders.rework + orders.update within the update scope; history stays readable', async () => {
    const { orderId } = await createOrder('legacy_6', 'packed', 1);
    const foreign = await createOrder('legacy_6', 'packed', 1);
    await pool.query('UPDATE orders SET manager_id = NULL WHERE order_id = ANY($1::bigint[])', [[orderId, foreign.orderId]]);
    const own = { orders: { view: 'all', update: 'own', export: 'none', delete: 'none' },
      payments: { view: 'none', create: 'none', update: 'none', delete: 'none' },
      productionTasks: { view: 'none', update: 'none' } } as never;
    const noUpdate = { ...admin, permissions: admin.permissions.filter((p) => p !== 'orders.update') };
    const scoped = { ...admin, policyScopes: own };
    expect((await service.listRounds(admin, orderId)).order.canRework).toBe(true);
    expect((await service.listRounds(noUpdate, orderId)).order.canRework).toBe(false);
    // The test user created both orders; make the second one foreign (created by nobody the user owns).
    const other = Number((await pool.query(
      "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, 'x') RETURNING user_id",
      [`e2e_rework_owner_${tag}`, `e2e_rework_owner_${tag}@example.invalid`])).rows[0].user_id);
    try {
      await pool.query('UPDATE orders SET created_by = $2 WHERE order_id = $1', [foreign.orderId, other]);
      expect((await service.listRounds(scoped, orderId)).order.canRework).toBe(true);
      const foreignState = await service.listRounds(scoped, foreign.orderId);
      expect(foreignState.order.canRework).toBe(false);
      expect(foreignState.data).toEqual([]); // still readable
    } finally {
      await pool.query('UPDATE orders SET created_by = $2 WHERE order_id = $1', [foreign.orderId, userId]);
      await pool.query('DELETE FROM users WHERE user_id = $1', [other]);
    }
  });

  it('detail-stage marks (266, round-aware in 274) follow the current round; earlier rounds stay history', async () => {
    const { orderId, detailIds } = await createOrder('legacy_6', 'packed', 2);
    const marks = async () => (await pool.query(
      `SELECT ps.production_status_code AS code, e.round_no FROM production_status_events e
       JOIN production_statuses ps USING (production_status_id)
       WHERE e.order_id = $1 ORDER BY e.round_no, ps.sort_order`, [orderId],
    )).rows.map((row) => `${row.code}:${row.round_no}`);
    // A plain detail update (no backend marker in the session) still passes the stage-event boundary.
    await pool.query('UPDATE order_details SET production_status_id = $2 WHERE detail_id = $1', [detailIds[1], stage.cut]);
    const round1 = await marks();
    expect(round1).toEqual(expect.arrayContaining(['packed:1', 'cut:1']));

    await service.startOrExtend({
      currentUser: admin, orderId, version: await version(orderId), idempotencyKey: key(),
      dto: { reasonId: reasons.workshop_defect, details: [{ detailId: detailIds[0], productionStatusId: stage.drawn }] },
    });
    const afterStart = await marks();
    // Round 2 gets the mark of the stage its detail entered; round 1 marks are untouched history.
    expect(afterStart).toEqual(expect.arrayContaining([...round1, 'drawn:2']));
    expect(afterStart.filter((m) => m.endsWith(':1'))).toEqual(round1);

    await service.falsePositive({
      currentUser: admin, orderId, roundNo: 2, version: await version(orderId), idempotencyKey: key(), dto: {},
    });
    // The cancelled round leaves no order marks (restored details re-entering «Упакован» must not mark round 2);
    // round 1 marks are exactly as before.
    expect(await marks()).toEqual(round1);
    expect(Number((await pool.query('SELECT production_round FROM orders WHERE order_id = $1', [orderId])).rows[0].production_round)).toBe(1);
    const closed = (await pool.query(
      "SELECT metadata_json FROM audit_log WHERE related_order_id = $1 AND event = 'order.rework_closed'", [orderId],
    )).rows[0].metadata_json;
    expect(closed.removedStageMarks.map((m: { productionStatusId: number }) => m.productionStatusId)).toEqual([stage.packed]);
    const history = (await pool.query(
      `SELECT action, automatic FROM production_stage_mark_history
        WHERE order_id = $1 AND production_status_id = $2 ORDER BY history_id`, [orderId, stage.packed],
    )).rows.map((r) => `${r.action}:${r.automatic}`);
    expect(history.slice(-2)).toEqual(['insert:true', 'delete:false']);
    // The mark history keeps the round of every mark, also after it was removed.
    const historyRounds = (await pool.query(
      `SELECT action, round_no FROM production_stage_mark_history WHERE order_id = $1 ORDER BY history_id`, [orderId],
    )).rows.map((r) => `${r.action}:${r.round_no}`);
    expect(historyRounds).toEqual(expect.arrayContaining(['insert:2', 'delete:2', 'insert:1']));
    // Each removed mark has its own audit row, found by its production event (normalized link), and an outbox event.
    const removedId = closed.removedStageMarks[0].productionEventId;
    const deactivated = (await pool.query(
      `SELECT event, user_id, status_code, stage_code, metadata_json FROM audit_log
        WHERE related_order_id = $1 AND related_production_event_id = $2`, [orderId, removedId],
    )).rows.filter((r) => r.event === 'production.stage_deactivate');
    expect(deactivated).toHaveLength(1);
    expect(deactivated[0]).toMatchObject({
      user_id: String(userId), status_code: 'packed', stage_code: 'packed',
      metadata_json: { origin: 'order_rework_false_positive', roundNo: 2, productionEventId: removedId },
    });
    const stageOutbox = (await pool.query(
      "SELECT payload_json FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'production.stage_deactivated' AND payload_json->>'origin' = 'order_rework_false_positive'",
      [String(orderId)],
    )).rows;
    expect(stageOutbox.map((r) => [r.payload_json.productionEventId, r.payload_json.roundNo])).toEqual([[removedId, 2]]);
    // The automation's own audit carries the round too.
    const automated = (await pool.query(
      "SELECT metadata_json FROM audit_log WHERE related_order_id = $1 AND event = 'production_stage_mark.auto_activate' ORDER BY created_at",
      [orderId],
    )).rows.map((r) => r.metadata_json.roundNo);
    expect(automated).toEqual(expect.arrayContaining([1, 2]));
  });
});
