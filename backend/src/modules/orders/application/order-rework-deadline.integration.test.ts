import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { OrderDto } from '../dto/order.dto';
import { PgOrderDeadlineSync } from '../../deadlines/adapters/pg-order-deadline-sync';
import { PgDeadlineDefaultScheduleRepository } from '../../deadlines/adapters/pg-deadline-default-schedule-repository';
import { almatyToday, suggestReworkPlannedCompletion } from '../domain/order-rework-deadline';
import { OrderReworkService } from './order-rework.service';
import { PgOrderSnapshot } from '../adapters/pg-order-snapshot';
import type { OrderSnapshotDto } from '../dto/order-snapshot.dto';
import { OrderReworkDeadlineSweeper } from './order-rework-deadline-sweeper.service';
import { ORDER_FINAL_DEADLINE_SYSTEM_ACTOR } from '../../deadlines/domain/order-final-deadline';

// «Переделка» 1.1 — round deadline and final-deadline reconciliation on real PostgreSQL (plan
// 2026-10-27-order-rework-deadlines-plan v7, §9). Gated on REWORK_INTEGRATION_DATABASE_URL (scratch copy of the stage
// DB with migrations 274–276 and 281, MDF engine legacy). Own `E2E-Тест` fixtures; the stage schedule is restored.
const databaseUrl = process.env.REWORK_INTEGRATION_DATABASE_URL;

interface FinalRow { deadline_id: string; status: string; at: string; metadata_json: Record<string, unknown> | null }

describe.skipIf(!databaseUrl)('«Переделка» 1.1 — round deadline (real PostgreSQL)', () => {
  let pool: Pool;
  let service: OrderReworkService;
  let bare: OrderReworkService; // no reconcile port: the after-commit step is driven explicitly
  let admin: CurrentUser;
  let userId: number;
  let otherUserId: number;
  let clientId: number;
  let projectId: number;
  let engineMode: string | null = null;
  let hasMdfEngine = false;
  let savedSchedule: { durations: unknown[]; reserve: number } | null = null;
  const tag = randomUUID().slice(0, 8);
  const orderIds: number[] = [];
  const importProjectIds: number[] = [];
  const importSource = `e2e-rework-deadline-${tag}`;
  const status: Record<string, number> = {};
  const stage: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  const today = almatyToday();

  const addDays = (date: string, days: number) => {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  };

  function database(): DatabaseService {
    return {
      async transaction<T>(handler: (tx: TransactionClient) => Promise<T>, options: { isolation?: string } = {}): Promise<T> {
        const client: PoolClient = await pool.connect();
        try {
          await client.query('BEGIN');
          if (options.isolation) await client.query(`SET TRANSACTION ISOLATION LEVEL ${options.isolation.toUpperCase()}`);
          const tx = { raw: client, query: (text: string, params: readonly unknown[] = []) => client.query(text, [...params]) } as never;
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

  const sync = () => new PgOrderDeadlineSync(database());
  const reconcile = (orderId: number) => sync().syncOrderDeadlinesAfterSave({ orderId, currentUser: { id: String(userId) }, eventType: 'ORDER_UPDATED', requestId: `e2e-${tag}` });
  const key = () => `e2e-rework-deadline-${randomUUID()}`;
  // As orders.module wires it: final deadline only, as the given actor.
  const finalOnly = ({ orderId, actorUserId, requestId, context }: { orderId: number; actorUserId: string; requestId: string; context?: { correlationId?: string | null; initiatorUserId?: string | null } }) =>
    sync().reconcileOrderFinalDeadline({ orderId, currentUser: { id: actorUserId }, requestId, context });
  const outboxCount = async (orderId: number) => Number((await pool.query(
    "SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_type = 'order' AND aggregate_id = $1", [String(orderId)],
  )).rows[0].n);
  const sweeperFor = () => new OrderReworkDeadlineSweeper({
    database: database(),
    enabled: () => true,
    reconcile: ({ orderId, requestId, context }) => sync().reconcileOrderFinalDeadline({
      orderId, currentUser: { id: ORDER_FINAL_DEADLINE_SYSTEM_ACTOR }, requestId, context,
    }),
  });
  const sweeperOn = (db: DatabaseService) => new OrderReworkDeadlineSweeper({
    database: db,
    enabled: () => true,
    reconcile: ({ orderId, requestId, context }) => sync().reconcileOrderFinalDeadline({
      orderId, currentUser: { id: ORDER_FINAL_DEADLINE_SYSTEM_ACTOR }, requestId, context,
    }),
  });
  const version = async (orderId: number) => Number((await pool.query('SELECT version FROM orders WHERE order_id = $1', [orderId])).rows[0].version);
  const orderDates = async (orderId: number) => (await pool.query(
    'SELECT planned_completion_date::text AS planned, completion_date::text AS completion FROM orders WHERE order_id = $1', [orderId],
  )).rows[0] as { planned: string | null; completion: string | null };
  const finals = async (orderId: number) => (await pool.query(
    `SELECT deadline_id, status, (deadline_at AT TIME ZONE 'UTC')::date::text AS at, metadata_json FROM deadline_instances
      WHERE entity_type = 'order' AND entity_id = $1 ORDER BY created_at, deadline_id`, [String(orderId)],
  )).rows as FinalRow[];
  const active = async (orderId: number) => (await finals(orderId)).filter((row) => row.status === 'active' || row.status === 'paused');
  const roundRow = async (orderId: number, roundNo: number) => (await pool.query(
    `SELECT planned_completion_date::text AS planned, planned_completion_source AS source,
            suggested_planned_completion_date::text AS suggested, from_planned_completion_date::text AS from_planned,
            from_completion_date::text AS from_completion, deadline_sync_requested_at AS mark
       FROM order_production_rounds WHERE order_id = $1 AND round_no = $2`, [orderId, roundNo],
  )).rows[0];

  async function createOrder(statusCode: string, detailStage: string, planned: string | null, detailCount = 2): Promise<{ orderId: number; detailIds: number[] }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('erp.pse_writer', 'backend', true)");
      const refs = (await client.query(
        `SELECT (SELECT min(milling_type_id) FROM milling_types) AS milling, (SELECT min(edge_type_id) FROM edge_types) AS edge,
                (SELECT min(sheet_material_type_id) FROM sheet_material_types) AS sheet, (SELECT min(payment_status_id) FROM payment_statuses) AS payment`,
      )).rows[0];
      const orderId = Number((await client.query(
        `INSERT INTO orders (order_name, client_id, project_id, order_status_id, payment_status_id, created_by, manager_id, planned_completion_date, order_date)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7::date, $8::date) RETURNING order_id`,
        [`E2E-Тест срок переделки ${tag} ${orderIds.length}`, clientId, projectId, status[statusCode], refs.payment, userId, planned, addDays(today, -30)],
      )).rows[0].order_id);
      const detailIds: number[] = [];
      for (let n = 1; n <= detailCount; n += 1) {
        detailIds.push(Number((await client.query(
          `INSERT INTO order_details (order_id, detail_number, height, width, area, milling_type_id, edge_type_id, created_by, sheet_material_type_id, production_status_id)
           VALUES ($1, $2, 100, 200, 0.02, $3, $4, $5, $6, $7) RETURNING detail_id`,
          [orderId, n, refs.milling, refs.edge, userId, refs.sheet, stage[detailStage]],
        )).rows[0].detail_id));
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

  /** Order with a final deadline: active (planned date only) or completed (also a manual completion date). */
  async function orderWithDeadline(statusCode: string, completed: boolean): Promise<{ orderId: number; detailIds: number[] }> {
    const order = await createOrder(statusCode, 'packed', addDays(today, -10));
    await reconcile(order.orderId);
    if (completed) {
      await pool.query('UPDATE orders SET completion_date = $2::date WHERE order_id = $1', [order.orderId, addDays(today, -5)]);
      await reconcile(order.orderId);
    }
    return order;
  }

  const start = (orderId: number, detailId: number, planned: string | null | undefined, svc = service, extra: Record<string, unknown> = {}) =>
    version(orderId).then((v) => svc.startOrExtend({
      currentUser: admin, orderId, version: v, idempotencyKey: key(),
      dto: { reasonId: reasons.workshop_defect, details: [{ detailId, productionStatusId: stage.drawn }], ...(planned === undefined ? {} : { plannedCompletionDate: planned }), ...extra } as never,
    }));
  const extend = (orderId: number, detailId: number, planned: string | null) => version(orderId).then((v) => service.startOrExtend({
    currentUser: admin, orderId, version: v, idempotencyKey: key(),
    dto: { details: [{ detailId, productionStatusId: stage.drawn }], plannedCompletionDate: planned } as never,
  }));
  const falsePositive = (orderId: number, roundNo: number, svc = service) => version(orderId).then((v) => svc.falsePositive({
    currentUser: admin, orderId, roundNo, version: v, idempotencyKey: key(), dto: {},
  }));
  async function setStatus(orderId: number, code: string) {
    await pool.query('UPDATE orders SET order_status_id = $2, version = version + 1 WHERE order_id = $1', [orderId, status[code]]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 6 });
    // main has no MDF engine (no mdf_engine_state): nothing to pin then.
    hasMdfEngine = Boolean((await pool.query("SELECT to_regclass('public.mdf_engine_state') IS NOT NULL AS present")).rows[0]?.present);
    engineMode = hasMdfEngine ? (await pool.query('SELECT mode FROM mdf_engine_state WHERE singleton')).rows[0]?.mode ?? null : null;
    if (engineMode) await pool.query("UPDATE mdf_engine_state SET mode = 'legacy' WHERE singleton");
    for (const row of (await pool.query('SELECT order_status_code, order_status_id FROM order_statuses')).rows) status[row.order_status_code] = Number(row.order_status_id);
    for (const row of (await pool.query('SELECT production_status_code, production_status_id FROM production_statuses')).rows) stage[row.production_status_code] = Number(row.production_status_id);
    for (const row of (await pool.query('SELECT code, order_rework_reason_id FROM order_rework_reasons')).rows) reasons[row.code] = Number(row.order_rework_reason_id);
    userId = Number((await pool.query(
      "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, 'x') RETURNING user_id",
      [`e2e_rework_deadline_${tag}`, `e2e_rework_deadline_${tag}@example.invalid`],
    )).rows[0].user_id);
    otherUserId = Number((await pool.query(
      "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, 'x') RETURNING user_id",
      [`e2e_rework_deadline_other_${tag}`, `e2e_rework_deadline_other_${tag}@example.invalid`],
    )).rows[0].user_id);
    clientId = Number((await pool.query('INSERT INTO clients (client_name, created_by) VALUES ($1, $2) RETURNING client_id', [`E2E-Тест клиент срок ${tag}`, userId])).rows[0].client_id);
    projectId = Number((await pool.query(
      'INSERT INTO projects (code, name, client_id, created_by) VALUES ($1, $2, $3, $4) RETURNING project_id',
      [`E2E-D-${tag}`, `E2E-Тест группа срок ${tag}`, clientId, userId],
    )).rows[0].project_id);
    admin = { id: String(userId), username: `e2e_rework_deadline_${tag}`, role: 'admin', roleId: 1, permissions: getPermissionsForRole('admin') };
    // Schedule: every active stage 1 day, reserve 2 (restored afterwards).
    savedSchedule = {
      durations: (await pool.query('SELECT * FROM deadline_default_stage_durations')).rows,
      reserve: Number((await pool.query('SELECT reserve_days FROM deadline_default_schedule_config WHERE config_id = 1')).rows[0]?.reserve_days ?? 0),
    };
    await pool.query('DELETE FROM deadline_default_stage_durations');
    await pool.query(
      `INSERT INTO deadline_default_stage_durations (production_status_id, position, duration_days, parallel_with_previous)
       SELECT production_status_id, row_number() OVER (ORDER BY sort_order, production_status_id), 1, false
         FROM production_statuses WHERE is_active = true`,
    );
    await pool.query('UPDATE deadline_default_schedule_config SET reserve_days = 2 WHERE config_id = 1');
    const ports = {
      database: database(),
      isEnabled: () => true,
      readOrder: async () => ({}) as OrderDto,
      loadDeadlineSchedule: (client: TransactionClient) => new PgDeadlineDefaultScheduleRepository(database()).getSchedule(client),
    };
    service = new OrderReworkService({ ...ports, reconcileOrderDeadline: finalOnly });
    bare = new OrderReworkService(ports);
  });

  afterAll(async () => {
    if (!pool) return;
    // Every step runs even if an earlier one failed; the errors are reported together at the end. The shared
    // settings (MDF mode, «Схема этапов и сроки») are restored first, in one transaction.
    const errors: unknown[] = [];
    const step = async (work: () => Promise<unknown>) => { try { await work(); } catch (error) { errors.push(error); } };
    try {
      await step(async () => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          if (engineMode) await client.query('UPDATE mdf_engine_state SET mode = $1 WHERE singleton', [engineMode]);
          if (savedSchedule) {
            await client.query('DELETE FROM deadline_default_stage_durations');
            for (const row of savedSchedule.durations as Array<Record<string, unknown>>) {
              await client.query(
                `INSERT INTO deadline_default_stage_durations (production_status_id, position, duration_days, parallel_with_previous)
                 VALUES ($1, $2, $3, $4)`, [row.production_status_id, row.position, row.duration_days, row.parallel_with_previous],
              );
            }
            await client.query('UPDATE deadline_default_schedule_config SET reserve_days = $1 WHERE config_id = 1', [savedSchedule.reserve]);
          }
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      });
      for (const orderId of orderIds) {
        await step(async () => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query('DELETE FROM audit_log_related_entity WHERE audit_id IN (SELECT audit_id FROM audit_log WHERE related_order_id = $1)', [orderId]);
            await client.query('DELETE FROM audit_log WHERE related_order_id = $1', [orderId]);
            await client.query("DELETE FROM outbox_events WHERE aggregate_type = 'order' AND aggregate_id = $1", [String(orderId)]);
            await client.query("DELETE FROM command_idempotency_keys WHERE entity_type = 'order' AND entity_id = $1", [String(orderId)]);
            await client.query('DELETE FROM realtime_event_log WHERE order_id = $1', [orderId]);
            await client.query('DELETE FROM order_workshops WHERE order_id = $1', [orderId]);
            await client.query('SET LOCAL session_replication_role = replica');
            await client.query('DELETE FROM mdf_board_history_state WHERE order_id = $1', [orderId]);
            await client.query('DELETE FROM mdf_board_history_coverage WHERE order_id = $1', [orderId]);
            await client.query('DELETE FROM mdf_board_history_events WHERE order_id = $1', [orderId]);
            await client.query('SET LOCAL session_replication_role = origin');
            await client.query('DELETE FROM orders WHERE order_id = $1', [orderId]);
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        });
      }
      await step(() => pool.query('DELETE FROM order_import_entity_map WHERE source_instance_id LIKE $1', [`${importSource}%`]));
      await step(() => pool.query('DELETE FROM order_import_runs WHERE source_instance_id LIKE $1', [`${importSource}%`]));
      for (const importProject of importProjectIds) {
        await step(async () => {
          await pool.query("DELETE FROM audit_log_related_entity WHERE audit_id IN (SELECT audit_id FROM audit_log WHERE entity_type = 'project' AND entity_id = $1)", [String(importProject)]);
          await pool.query("DELETE FROM audit_log WHERE entity_type = 'project' AND entity_id = $1", [String(importProject)]);
          await pool.query("DELETE FROM outbox_events WHERE aggregate_type = 'project' AND aggregate_id = $1", [String(importProject)]);
          await pool.query('DELETE FROM projects WHERE project_id = $1', [importProject]);
        });
      }
      if (projectId) await step(() => pool.query('DELETE FROM projects WHERE project_id = $1', [projectId]));
      if (clientId) await step(() => pool.query('DELETE FROM clients WHERE client_id = $1', [clientId]));
      for (const id of [userId, otherUserId]) {
        if (!id) continue;
        await step(async () => {
          await pool.query('DELETE FROM audit_log WHERE user_id = $1', [id]);
          await pool.query('DELETE FROM users WHERE user_id = $1', [id]);
        });
      }
      const residue = await pool.query('SELECT count(*)::int AS n FROM orders WHERE order_name LIKE $1', [`E2E-Тест срок переделки ${tag}%`]);
      expect(residue.rows[0].n).toBe(0);
      if (savedSchedule) {
        const durations = await pool.query('SELECT count(*)::int AS n FROM deadline_default_stage_durations');
        expect(durations.rows[0].n).toBe(savedSchedule.durations.length);
      }
      if (errors.length > 0) throw new AggregateError(errors, 'rework deadline fixtures cleanup failed');
    } finally {
      await pool.end();
    }
  }, 120_000);

  it('start after readiness: deadline by the schedule, completion cleared, previous values kept, completed D0 stays history', async () => {
    const order = await orderWithDeadline('legacy_6', true);
    const [d0] = await finals(order.orderId);
    expect(d0.status).toMatch(/^completed_/);
    const schedule = await new PgDeadlineDefaultScheduleRepository(database()).getSchedule();
    const expected = suggestReworkPlannedCompletion({ schedule, returnStageIds: [stage.drawn], startDate: today });
    expect(expected.suggestedDate).not.toBeNull();
    const suggestion = await service.suggestDeadline(admin, order.orderId, [{ detailId: order.detailIds[0], productionStatusId: stage.drawn }]);
    expect(suggestion).toMatchObject({ suggestedDate: expected.suggestedDate, required: true, scheduleConfigured: true });

    await start(order.orderId, order.detailIds[0], expected.suggestedDate);
    expect(await orderDates(order.orderId)).toEqual({ planned: expected.suggestedDate, completion: null });
    expect(await roundRow(order.orderId, 2)).toMatchObject({
      planned: expected.suggestedDate, source: 'schedule', suggested: expected.suggestedDate,
      from_planned: addDays(today, -10), from_completion: addDays(today, -5), mark: null,
    });
    const rows = await finals(order.orderId);
    expect(rows[0]).toMatchObject({ deadline_id: d0.deadline_id, status: d0.status });
    expect(await active(order.orderId)).toEqual([expect.objectContaining({ at: expected.suggestedDate, metadata_json: expect.objectContaining({ reworkRoundNo: 2, previousDeadlineId: d0.deadline_id }) })]);
    const audit = (await pool.query("SELECT diff_json, metadata_json FROM audit_log WHERE related_order_id = $1 AND event = 'order.rework_started'", [order.orderId])).rows[0];
    expect(audit.diff_json.plannedCompletionDate).toEqual({ before: addDays(today, -10), after: expected.suggestedDate });
    expect(audit.diff_json.completionDate).toEqual({ before: addDays(today, -5), after: null });
    expect(audit.metadata_json).toMatchObject({ plannedCompletionSource: 'schedule', suggestedPlannedCompletionDate: expected.suggestedDate });
    const outbox = (await pool.query(
      "SELECT payload_json FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'order.planned_completion_date_changed'", [String(order.orderId)],
    )).rows;
    expect(outbox.map((r) => r.payload_json.plannedCompletionDateAfter)).toEqual([expected.suggestedDate]);
  });

  it('validation: required for «Вернуть в переделку», not in the past; the date is part of the idempotency request', async () => {
    const order = await orderWithDeadline('legacy_6', false);
    await expect(start(order.orderId, order.detailIds[0], undefined)).rejects.toMatchObject({ statusCode: 422, code: 'ORDER_REWORK_PLANNED_COMPLETION_REQUIRED' });
    await expect(start(order.orderId, order.detailIds[0], addDays(today, -1))).rejects.toMatchObject({ statusCode: 422, code: 'ORDER_REWORK_PLANNED_COMPLETION_IN_PAST' });
    const v = await version(order.orderId);
    const idempotencyKey = key();
    const body = (date: string) => ({ reasonId: reasons.workshop_defect, plannedCompletionDate: date, details: [{ detailId: order.detailIds[0], productionStatusId: stage.drawn }] });
    const first = await service.startOrExtend({ currentUser: admin, orderId: order.orderId, version: v, idempotencyKey, dto: body(addDays(today, 7)) as never });
    await expect(service.startOrExtend({ currentUser: admin, orderId: order.orderId, version: v, idempotencyKey, dto: body(addDays(today, 8)) as never }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    const replay = await service.startOrExtend({ currentUser: admin, orderId: order.orderId, version: v, idempotencyKey, dto: body(addDays(today, 7)) as never });
    expect(replay).toMatchObject({ roundNo: first.roundNo, version: first.version });
    expect((await pool.query("SELECT count(*)::int n FROM audit_log WHERE related_order_id = $1 AND event = 'order.rework_started'", [order.orderId])).rows[0].n).toBe(1);
    expect((await roundRow(order.orderId, 2)).source).toBe('manual');
  });

  it('adding details moves the round deadline only later', async () => {
    const order = await orderWithDeadline('legacy_6', false);
    await start(order.orderId, order.detailIds[0], addDays(today, 7));
    await extend(order.orderId, order.detailIds[1], addDays(today, 3));
    expect((await orderDates(order.orderId)).planned).toBe(addDays(today, 7));
    const order2 = await orderWithDeadline('legacy_6', false);
    await start(order2.orderId, order2.detailIds[0], addDays(today, 7));
    await extend(order2.orderId, order2.detailIds[1], addDays(today, 12));
    expect((await orderDates(order2.orderId)).planned).toBe(addDays(today, 12));
    expect(await active(order2.orderId)).toEqual([expect.objectContaining({ at: addDays(today, 12), metadata_json: expect.objectContaining({ reworkRoundNo: 2 }) })]);
  });

  it('«Это не переделка»: (a) untouched → both dates back, round instances cancelled, D0 current again', async () => {
    const order = await orderWithDeadline('legacy_6', true);
    const [d0] = await finals(order.orderId);
    await start(order.orderId, order.detailIds[0], addDays(today, 7));
    await falsePositive(order.orderId, 2);
    expect(await orderDates(order.orderId)).toEqual({ planned: addDays(today, -10), completion: addDays(today, -5) });
    expect(await active(order.orderId)).toEqual([]);
    const rows = await finals(order.orderId);
    expect(rows.find((r) => r.deadline_id === d0.deadline_id)?.status).toBe(d0.status);
    expect(rows.filter((r) => r.metadata_json?.reworkRoundNo === 2).every((r) => r.status === 'cancelled')).toBe(true);
    const audit = (await pool.query("SELECT metadata_json FROM audit_log WHERE related_order_id = $1 AND event = 'order.rework_closed'", [order.orderId])).rows[0];
    expect(audit.metadata_json.deadlineRestore).toEqual({ plannedCompletionDate: 'restored', completionDate: 'restored' });
  });

  it('«Это не переделка»: (b) a manual completion date set after the start is kept; (c) a manually changed deadline is kept', async () => {
    const b = await orderWithDeadline('legacy_6', true);
    await start(b.orderId, b.detailIds[0], addDays(today, 7));
    await pool.query('UPDATE orders SET completion_date = $2::date WHERE order_id = $1', [b.orderId, today]);
    await falsePositive(b.orderId, 2);
    expect(await orderDates(b.orderId)).toEqual({ planned: addDays(today, -10), completion: today });

    const c = await orderWithDeadline('legacy_6', true);
    await start(c.orderId, c.detailIds[0], addDays(today, 7));
    await pool.query('UPDATE orders SET planned_completion_date = $2::date WHERE order_id = $1', [c.orderId, addDays(today, 20)]);
    await falsePositive(c.orderId, 2);
    expect(await orderDates(c.orderId)).toEqual({ planned: addDays(today, 20), completion: addDays(today, -5) });
    const audit = (await pool.query("SELECT metadata_json FROM audit_log WHERE related_order_id = $1 AND event = 'order.rework_closed'", [c.orderId])).rows[0];
    expect(audit.metadata_json.deadlineRestore).toEqual({ plannedCompletionDate: 'kept', completionDate: 'restored' });
  });

  it('R5: D0 completed → round 2 → ready → round 3 → «Это не переделка» of round 3: exactly one active on the round-2 date', async () => {
    const order = await orderWithDeadline('legacy_6', true);
    await start(order.orderId, order.detailIds[0], addDays(today, 7));
    await setStatus(order.orderId, 'legacy_6'); // closes round 2 (ready); completion_date stays NULL
    expect(await active(order.orderId)).toHaveLength(1);
    await start(order.orderId, order.detailIds[1], addDays(today, 14));
    expect(await active(order.orderId)).toEqual([expect.objectContaining({ at: addDays(today, 14), metadata_json: expect.objectContaining({ reworkRoundNo: 3 }) })]);
    await falsePositive(order.orderId, 3);
    expect((await orderDates(order.orderId)).planned).toBe(addDays(today, 7));
    expect(await active(order.orderId)).toEqual([expect.objectContaining({ at: addDays(today, 7), metadata_json: expect.objectContaining({ reworkRoundNo: 2 }) })]);
    const before = (await finals(order.orderId)).length;
    await reconcile(order.orderId);
    expect((await finals(order.orderId)).length).toBe(before); // repeat: no new instance
  });

  it('R6: active P → start → deadline cleared by hand → «Это не переделка» → repeat: no active, no error', async () => {
    const order = await orderWithDeadline('legacy_6', false);
    await start(order.orderId, order.detailIds[0], addDays(today, 7));
    await pool.query('UPDATE orders SET planned_completion_date = NULL WHERE order_id = $1', [order.orderId]);
    await falsePositive(order.orderId, 2);
    await reconcile(order.orderId);
    expect((await orderDates(order.orderId)).planned).toBeNull();
    expect(await active(order.orderId)).toEqual([]);
    expect((await roundRow(order.orderId, 2)).mark).toBeNull();
  });

  it('expired round instance: a later deadline starts a new active instance with the round tag; the same date changes nothing', async () => {
    const order = await orderWithDeadline('legacy_6', false);
    await start(order.orderId, order.detailIds[0], addDays(today, 7));
    const [round] = await active(order.orderId);
    await pool.query("UPDATE deadline_instances SET status = 'expired', expired_at = now() WHERE deadline_id = $1", [round.deadline_id]);
    await reconcile(order.orderId);
    expect(await active(order.orderId)).toEqual([]);
    await extend(order.orderId, order.detailIds[1], addDays(today, 10));
    expect(await active(order.orderId)).toEqual([expect.objectContaining({ at: addDays(today, 10), metadata_json: expect.objectContaining({ reworkRoundNo: 2 }) })]);
  });

  it('metadata of the round instance survives a save with the same date (merge), so the cancellation still finds it', async () => {
    const order = await orderWithDeadline('legacy_6', true);
    await start(order.orderId, order.detailIds[0], addDays(today, 7));
    await reconcile(order.orderId); // same date → responsibility update path
    expect((await active(order.orderId))[0].metadata_json).toMatchObject({ reworkRoundNo: 2, label: 'Финальный дедлайн заказа' });
    await falsePositive(order.orderId, 2);
    expect(await active(order.orderId)).toEqual([]);
  });

  it('a failed after-commit reconciliation leaves the mark; the background pass reconciles and clears it', async () => {
    const order = await orderWithDeadline('legacy_6', true);
    await start(order.orderId, order.detailIds[0], addDays(today, 7), bare);
    expect((await roundRow(order.orderId, 2)).mark).not.toBeNull();
    expect(await active(order.orderId)).toEqual([]);
    const sweeper = sweeperFor();
    expect(await sweeper.sweep(new Date())).toBe(0); // within the grace period
    expect(await sweeper.sweep(new Date(Date.now() + 60_000))).toBeGreaterThanOrEqual(1);
    expect((await roundRow(order.orderId, 2)).mark).toBeNull();
    expect(await active(order.orderId)).toHaveLength(1);
  });

  it('manual repair: deadlines.manage + update scope; a visible order outside the update scope is refused without changes', async () => {
    const order = await orderWithDeadline('legacy_6', true);
    await start(order.orderId, order.detailIds[0], addDays(today, 7), bare);
    const operator: CurrentUser = { ...admin, role: 'operator', roleId: 3, permissions: [...getPermissionsForRole('operator'), 'deadlines.manage'] };
    const operatorOther: CurrentUser = { ...operator, id: String(otherUserId), username: `e2e_rework_deadline_other_${tag}` };
    const before = await finals(order.orderId);
    await expect(service.reconcileDeadlineManually(operatorOther, order.orderId, `e2e-${tag}`)).rejects.toMatchObject({ statusCode: 403 });
    expect(await finals(order.orderId)).toEqual(before);
    expect((await pool.query("SELECT count(*)::int n FROM audit_log WHERE related_order_id = $1 AND event = 'order.final_deadline_reconcile_denied'", [order.orderId])).rows[0].n).toBe(1);
    await service.reconcileDeadlineManually(admin, order.orderId, `e2e-${tag}`);
    expect(await active(order.orderId)).toHaveLength(1);
  });

  it('the reconciliation never holds the order row: it waits for a deadline row locked elsewhere while the order stays lockable', async () => {
    const order = await orderWithDeadline('legacy_6', false);
    await start(order.orderId, order.detailIds[0], addDays(today, 7));
    const [current] = await active(order.orderId);
    const holder = await pool.connect();
    const probe = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM deadline_instances WHERE deadline_id = $1 FOR UPDATE', [current.deadline_id]);
      await pool.query('UPDATE orders SET planned_completion_date = $2::date WHERE order_id = $1', [order.orderId, addDays(today, 9)]);
      const pending = reconcile(order.orderId);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await probe.query('BEGIN');
      await probe.query('SET LOCAL lock_timeout = 1000');
      await expect(probe.query('SELECT 1 FROM orders WHERE order_id = $1 FOR UPDATE', [order.orderId])).resolves.toBeDefined();
      await probe.query('ROLLBACK');
      await holder.query('COMMIT');
      await pending;
      expect(await active(order.orderId)).toEqual([expect.objectContaining({ at: addDays(today, 9) })]);
    } finally {
      holder.release();
      probe.release();
    }
  });

  it('orders without rounds keep the old final-deadline behaviour', async () => {
    const order = await createOrder('legacy_4', 'cut', addDays(today, 5));
    await reconcile(order.orderId);
    await reconcile(order.orderId);
    expect(await active(order.orderId)).toEqual([expect.objectContaining({ at: addDays(today, 5) })]);
    expect((await finals(order.orderId))).toHaveLength(1);
  });

  it('R1.3: «Переделка в производстве» without a date → a date when adding details → «Это не переделка» restores the original date', async () => {
    const order = await createOrder('legacy_4', 'cut', addDays(today, 4));
    await reconcile(order.orderId);
    await start(order.orderId, order.detailIds[0], undefined);
    expect(await roundRow(order.orderId, 2)).toMatchObject({ planned: null, from_planned: addDays(today, 4) });
    await extend(order.orderId, order.detailIds[1], addDays(today, 9));
    expect((await orderDates(order.orderId)).planned).toBe(addDays(today, 9));
    await falsePositive(order.orderId, 2);
    expect((await orderDates(order.orderId)).planned).toBe(addDays(today, 4));
    expect(await active(order.orderId)).toEqual([expect.objectContaining({ at: addDays(today, 4) })]);
  });

  it('R1.5: an open round without its own date does not take over the final deadline on an order save', async () => {
    const order = await createOrder('legacy_4', 'cut', addDays(today, 4));
    await reconcile(order.orderId);
    const [d0] = await active(order.orderId);
    await start(order.orderId, order.detailIds[0], undefined);
    await pool.query('UPDATE orders SET planned_completion_date = $2::date WHERE order_id = $1', [order.orderId, addDays(today, 6)]);
    await reconcile(order.orderId); // an ordinary save of the order
    const [current] = await active(order.orderId);
    expect(current.at).toBe(addDays(today, 6));
    expect(current.metadata_json?.reworkRoundNo).toBeUndefined();
    expect((await finals(order.orderId)).find((row) => row.deadline_id === d0.deadline_id)?.status).toBe('superseded');
    await falsePositive(order.orderId, 2); // the round set no date: the order deadline stays as saved
    expect(await active(order.orderId)).toEqual([expect.objectContaining({ at: addDays(today, 6) })]);
  });

  it('R1.1: a mark newer than the snapshot is not cleared (the reconciliation acted on the older state)', async () => {
    const order = await orderWithDeadline('legacy_6', true);
    await start(order.orderId, order.detailIds[0], addDays(today, 7), bare);
    let injected = false;
    const racing = {
      ...database(),
      transaction: (handler: (tx: TransactionClient) => Promise<unknown>, options?: unknown) => database().transaction(async (tx) => handler({
        ...tx,
        query: async (text: string, params: readonly unknown[] = []) => {
          const result = await tx.query(text, params as unknown[]);
          if (!injected && /FROM orders o\s+WHERE o\.order_id = \$1 AND o\.order_kind/.test(text)) {
            injected = true;
            const v = await version(order.orderId);
            await bare.startOrExtend({ currentUser: admin, orderId: order.orderId, version: v, idempotencyKey: key(),
              dto: { details: [{ detailId: order.detailIds[1], productionStatusId: stage.drawn }], plannedCompletionDate: addDays(today, 12) } as never });
          }
          return result;
        },
      } as never), options as never),
    } as unknown as DatabaseService;
    await new PgOrderDeadlineSync(racing).reconcileOrderFinalDeadline({ orderId: order.orderId, currentUser: { id: String(userId) }, requestId: `e2e-${tag}` });
    expect(injected).toBe(true);
    expect(await active(order.orderId)).toEqual([expect.objectContaining({ at: addDays(today, 7) })]); // the snapshot's state
    expect((await roundRow(order.orderId, 2)).mark).not.toBeNull(); // the extend's mark survives
    await sweeperFor().sweep(new Date(Date.now() + 60_000));
    expect(await active(order.orderId)).toEqual([expect.objectContaining({ at: addDays(today, 12), metadata_json: expect.objectContaining({ reworkRoundNo: 2 }) })]);
    expect((await roundRow(order.orderId, 2)).mark).toBeNull();
  });

  it('R1.2: the round reconciliation never waits for a stage deadline held by the deadline worker', async () => {
    const order = await orderWithDeadline('legacy_6', true);
    await pool.query(
      `INSERT INTO order_workshops (order_id, workshop_id, production_status_id, planned_completion_date, created_by)
       VALUES ($1, (SELECT min(workshop_id) FROM workshops), $2, $3::date, $4)`,
      [order.orderId, stage.drawn, addDays(today, 3), userId],
    );
    await reconcile(order.orderId); // creates the stage deadline
    const stageRow = (await pool.query("SELECT deadline_id FROM deadline_instances WHERE order_id = $1 AND entity_type = 'order_stage' AND status = 'active'", [order.orderId])).rows[0];
    expect(stageRow).toBeDefined();
    const worker = await pool.connect();
    try {
      await worker.query('BEGIN');
      await worker.query('SELECT 1 FROM deadline_instances WHERE deadline_id = $1 FOR UPDATE', [stageRow.deadline_id]);
      const started = start(order.orderId, order.detailIds[0], addDays(today, 7)); // command + after-commit reconcile
      const outcome = await Promise.race([started.then(() => 'done'), new Promise((resolve) => setTimeout(() => resolve('blocked'), 5000))]);
      expect(outcome).toBe('done');
      expect(await active(order.orderId)).toEqual(expect.arrayContaining([expect.objectContaining({ at: addDays(today, 7) })]));
      expect((await roundRow(order.orderId, 2)).mark).toBeNull();
    } finally {
      await worker.query('ROLLBACK');
      worker.release();
    }
    await pool.query('DELETE FROM order_workshops WHERE order_id = $1', [order.orderId]);
  });

  it('R1.4: a replayed command and a repeated repair add no outbox rows and no deadline events', async () => {
    const order = await orderWithDeadline('legacy_6', true);
    const v = await version(order.orderId);
    const idempotencyKey = key();
    const body = { reasonId: reasons.workshop_defect, plannedCompletionDate: addDays(today, 7), details: [{ detailId: order.detailIds[0], productionStatusId: stage.drawn }] };
    await service.startOrExtend({ currentUser: admin, orderId: order.orderId, version: v, idempotencyKey, dto: body as never });
    const events = async () => Number((await pool.query('SELECT count(*)::int AS n FROM deadline_events WHERE order_id = $1', [order.orderId])).rows[0].n);
    const [outboxBefore, eventsBefore] = [await outboxCount(order.orderId), await events()];
    await service.startOrExtend({ currentUser: admin, orderId: order.orderId, version: v, idempotencyKey, dto: body as never });
    await service.reconcileDeadlineManually(admin, order.orderId, `e2e-${tag}-1`);
    await service.reconcileDeadlineManually(admin, order.orderId, `e2e-${tag}-2`);
    expect(await outboxCount(order.orderId)).toBe(outboxBefore);
    expect(await events()).toBe(eventsBefore);
  });

  it('R1.7: the background pass writes as the system; initiator and correlation are the command that set the mark', async () => {
    const order = await orderWithDeadline('legacy_6', true);
    await start(order.orderId, order.detailIds[0], addDays(today, 7)); // user A (admin), reconciled
    const other: CurrentUser = { ...admin, id: String(otherUserId), username: `e2e_rework_deadline_other_${tag}` };
    const v = await version(order.orderId);
    await bare.startOrExtend({ currentUser: other, orderId: order.orderId, version: v, idempotencyKey: key(), requestId: `e2e-extend-${tag}`,
      dto: { details: [{ detailId: order.detailIds[1], productionStatusId: stage.drawn }], plannedCompletionDate: addDays(today, 10) } as never });
    expect(await roundRow(order.orderId, 2)).toMatchObject({ planned: addDays(today, 10) });
    await sweeperFor().sweep(new Date(Date.now() + 60_000));
    const [current] = await active(order.orderId);
    expect(current.at).toBe(addDays(today, 10));
    const row = (await pool.query('SELECT created_by_user_id FROM deadline_instances WHERE deadline_id = $1', [current.deadline_id])).rows[0];
    expect(row.created_by_user_id).toBeNull();
    const event = (await pool.query("SELECT payload_json FROM deadline_events WHERE deadline_id = $1 AND event_type = 'DEADLINE_UPDATED'", [current.deadline_id])).rows[0];
    expect(event.payload_json).toMatchObject({ actorUserId: null, actor: ORDER_FINAL_DEADLINE_SYSTEM_ACTOR, initiatorUserId: String(otherUserId), correlationId: `e2e-extend-${tag}` });
    const audit = (await pool.query("SELECT user_id, metadata_json FROM audit_log WHERE entity_type = 'deadline' AND entity_id = $1", [current.deadline_id])).rows[0];
    expect(audit.user_id).toBeNull();
    expect(audit.metadata_json).toMatchObject({ actor: ORDER_FINAL_DEADLINE_SYSTEM_ACTOR, initiatorUserId: String(otherUserId), correlationId: `e2e-extend-${tag}` });
  });

  it('R1.8: a date change by a round command is also an `orders.update` fact in the order history', async () => {
    const order = await orderWithDeadline('legacy_6', true);
    await start(order.orderId, order.detailIds[0], addDays(today, 7));
    const audit = (await pool.query("SELECT diff_json, metadata_json FROM audit_log WHERE related_order_id = $1 AND event = 'orders.update'", [order.orderId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].diff_json).toMatchObject({
      plannedCompletionDate: { before: addDays(today, -10), after: addDays(today, 7) },
      completionDate: { before: addDays(today, -5), after: null },
    });
    expect(audit[0].metadata_json).toMatchObject({ origin: 'order_rework', roundNo: 2 });
    await falsePositive(order.orderId, 2);
    expect((await pool.query("SELECT count(*)::int n FROM audit_log WHERE related_order_id = $1 AND event = 'orders.update'", [order.orderId])).rows[0].n).toBe(2);
  });

  it('R2.3: a command committing between the queue read and the snapshot is attributed to itself; outbox carries it', async () => {
    const order = await orderWithDeadline('legacy_6', true);
    await start(order.orderId, order.detailIds[0], addDays(today, 7), bare); // admin's mark (request A)
    const other: CurrentUser = { ...admin, id: String(otherUserId), username: `e2e_rework_deadline_other_${tag}` };
    let injected = false;
    const racing = {
      ...database(),
      query: async (text: string, params: readonly unknown[] = []) => {
        const result = await pool.query(text, [...params]);
        if (!injected && text.includes('FROM order_production_rounds r')) {
          injected = true; // the queue was read with A's mark; now B extends (its own reconciliation failed)
          const v = await version(order.orderId);
          await bare.startOrExtend({ currentUser: other, orderId: order.orderId, version: v, idempotencyKey: key(), requestId: `e2e-race-b-${tag}`,
            dto: { details: [{ detailId: order.detailIds[1], productionStatusId: stage.drawn }], plannedCompletionDate: addDays(today, 11) } as never });
        }
        return result;
      },
    } as unknown as DatabaseService;
    expect(await sweeperOn(racing).sweep(new Date(Date.now() + 60_000))).toBe(1);
    expect(injected).toBe(true);
    const [current] = await active(order.orderId);
    expect(current.at).toBe(addDays(today, 11));
    const event = (await pool.query("SELECT payload_json FROM deadline_events WHERE deadline_id = $1", [current.deadline_id])).rows[0];
    expect(event.payload_json).toMatchObject({ actor: ORDER_FINAL_DEADLINE_SYSTEM_ACTOR, initiatorUserId: String(otherUserId), correlationId: `e2e-race-b-${tag}` });
    const outbox = (await pool.query(
      "SELECT payload_json FROM outbox_events WHERE aggregate_type = 'deadline' AND aggregate_id = $1", [current.deadline_id],
    )).rows;
    expect(outbox[0].payload_json).toMatchObject({ actorUserId: null, actor: ORDER_FINAL_DEADLINE_SYSTEM_ACTOR, initiatorUserId: String(otherUserId), correlationId: `e2e-race-b-${tag}` });
    expect((await roundRow(order.orderId, 2)).mark).toBeNull();
  });

  it('R2.2: a deleted order is not in the queue, and any reconciliation clears its marks', async () => {
    const order = await orderWithDeadline('legacy_6', true);
    await start(order.orderId, order.detailIds[0], addDays(today, 7), bare);
    await pool.query('UPDATE orders SET delete_flag = true WHERE order_id = $1', [order.orderId]);
    const queued = (await pool.query(
      `SELECT count(*)::int AS n FROM order_production_rounds r JOIN orders o ON o.order_id = r.order_id AND COALESCE(o.delete_flag, false) = false
        WHERE r.order_id = $1 AND r.deadline_sync_requested_at IS NOT NULL`, [order.orderId],
    )).rows[0].n;
    expect(queued).toBe(0);
    await sync().reconcileOrderFinalDeadline({ orderId: order.orderId, currentUser: { id: ORDER_FINAL_DEADLINE_SYSTEM_ACTOR }, requestId: `e2e-${tag}` });
    expect((await roundRow(order.orderId, 2)).mark).toBeNull();
    await pool.query('UPDATE orders SET delete_flag = false WHERE order_id = $1', [order.orderId]);
  });

  it('R1.2 (port review): export/import keeps the round deadline chain — «Это не переделка» after import restores round 2', async () => {
    const order = await orderWithDeadline('legacy_6', true);
    await start(order.orderId, order.detailIds[0], addDays(today, 7));
    await setStatus(order.orderId, 'legacy_6'); // round 2 closed by readiness, its deadline stays current
    await start(order.orderId, order.detailIds[1], addDays(today, 14)); // round 3 supersedes it
    const snapshots = new PgOrderSnapshot(database());
    const exported = JSON.parse((await snapshots.exportOrderSnapshot({ orderId: order.orderId, currentUser: admin, requestId: key() })).content) as OrderSnapshotDto;
    exported.source.sourceInstanceId = `${importSource}-${randomUUID()}`;
    exported.source.payloadHash = '';
    exported.data.order.orderName = `E2E-Тест срок переделки ${tag} импорт`;
    const imported = await snapshots.importOrderSnapshot({ snapshot: exported, currentUser: admin, requestId: key() });
    orderIds.push(imported.orderId);
    const project = (await pool.query('SELECT project_id FROM orders WHERE order_id = $1', [imported.orderId])).rows[0];
    if (project && Number(project.project_id) !== projectId) importProjectIds.push(Number(project.project_id));
    const rows = await finals(imported.orderId);
    const ids = new Set(rows.map((row) => row.deadline_id));
    for (const row of rows) {
      const previous = row.metadata_json?.previousDeadlineId;
      if (previous != null) expect(ids.has(String(previous))).toBe(true); // local ids only
    }
    await falsePositive(imported.orderId, 3);
    expect(await active(imported.orderId)).toEqual([expect.objectContaining({ at: addDays(today, 7), metadata_json: expect.objectContaining({ reworkRoundNo: 2 }) })]);
  });

  it('R2.1 (port review): an import whose round deadline names a predecessor outside the snapshot keeps the round tag', async () => {
    const order = await orderWithDeadline('legacy_6', true);
    await start(order.orderId, order.detailIds[0], addDays(today, 7));
    const snapshots = new PgOrderSnapshot(database());
    const exported = JSON.parse((await snapshots.exportOrderSnapshot({ orderId: order.orderId, currentUser: admin, requestId: key() })).content) as OrderSnapshotDto;
    // Drop D0 (the predecessor) from the snapshot: the round instance's previousDeadlineId points outside it.
    const round = exported.data.deadlineInstances.find((row) => (row.metadata_json as Record<string, unknown> | null)?.reworkRoundNo === 2)!;
    const previous = (round.metadata_json as Record<string, unknown>).previousDeadlineId as string;
    exported.data.deadlineInstances = exported.data.deadlineInstances.filter((row) => row.deadline_id !== previous);
    exported.data.deadlineEvents = exported.data.deadlineEvents.filter((row) => row.deadline_id !== previous);
    exported.source.sourceInstanceId = `${importSource}-${randomUUID()}`;
    exported.source.payloadHash = '';
    exported.data.order.orderName = `E2E-Тест срок переделки ${tag} импорт-внешний`;
    const imported = await snapshots.importOrderSnapshot({ snapshot: exported, currentUser: admin, requestId: key() });
    orderIds.push(imported.orderId);
    const project = (await pool.query('SELECT project_id FROM orders WHERE order_id = $1', [imported.orderId])).rows[0];
    if (project && Number(project.project_id) !== projectId) importProjectIds.push(Number(project.project_id));
    const [current] = await active(imported.orderId);
    expect(current.metadata_json).toMatchObject({ reworkRoundNo: 2, previousDeadlineId: null, label: 'Финальный дедлайн заказа' });
    await falsePositive(imported.orderId, 2);
    expect((await finals(imported.orderId)).filter((row) => row.metadata_json?.reworkRoundNo === 2).every((row) => row.status === 'cancelled')).toBe(true);
  });

  async function importCopy(orderId: number, label: string): Promise<number> {
    const snapshots = new PgOrderSnapshot(database());
    const exported = JSON.parse((await snapshots.exportOrderSnapshot({ orderId, currentUser: admin, requestId: key() })).content) as OrderSnapshotDto;
    exported.source.sourceInstanceId = `${importSource}-${randomUUID()}`;
    exported.source.payloadHash = '';
    exported.data.order.orderName = `E2E-Тест срок переделки ${tag} ${label}`;
    const imported = await snapshots.importOrderSnapshot({ snapshot: exported, currentUser: admin, requestId: key() });
    orderIds.push(imported.orderId);
    const project = (await pool.query('SELECT project_id FROM orders WHERE order_id = $1', [imported.orderId])).rows[0];
    if (project && Number(project.project_id) !== projectId) importProjectIds.push(Number(project.project_id));
    return imported.orderId;
  }

  it('R4.1 (port review): an import after «Это не переделка» keeps exactly one active deadline; repeated reconciliations add nothing', async () => {
    const order = await orderWithDeadline('legacy_6', false); // active D0
    await start(order.orderId, order.detailIds[0], addDays(today, 7));
    await falsePositive(order.orderId, 2); // D0 superseded, D0′ restored active
    expect(await active(order.orderId)).toHaveLength(1);
    const copy = await importCopy(order.orderId, 'импорт-после-отмены');
    await sync().reconcileOrderFinalDeadline({ orderId: copy, currentUser: { id: ORDER_FINAL_DEADLINE_SYSTEM_ACTOR }, requestId: key() });
    const events = async () => Number((await pool.query('SELECT count(*)::int AS n FROM deadline_events WHERE order_id = $1', [copy])).rows[0].n);
    const afterFirst = await events();
    await sync().reconcileOrderFinalDeadline({ orderId: copy, currentUser: { id: ORDER_FINAL_DEADLINE_SYSTEM_ACTOR }, requestId: key() });
    await reconcile(copy);
    expect(await active(copy)).toHaveLength(1);
    expect(await events()).toBe(afterFirst);
  });

  it('R4.2 (port review): an import made before the reconciliation ran asks for one; the background pass sets the deadline', async () => {
    const order = await orderWithDeadline('legacy_6', true);
    await start(order.orderId, order.detailIds[0], addDays(today, 9), bare); // reconciliation never ran in the source
    expect(await active(order.orderId)).toEqual([]);
    const copy = await importCopy(order.orderId, 'импорт-до-сверки');
    expect((await roundRow(copy, 2)).mark).not.toBeNull();
    await sweeperFor().sweep(new Date(Date.now() + 60_000));
    expect(await active(copy)).toEqual([expect.objectContaining({ at: addDays(today, 9), metadata_json: expect.objectContaining({ reworkRoundNo: 2 }) })]);
    expect((await roundRow(copy, 2)).mark).toBeNull();
  });
});
