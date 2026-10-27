import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser as AuthenticatedUser } from '../../../permissions/current-user';
// Deadline initialization needs an executor ID, not a fabricated login role.
type CurrentUser = Pick<AuthenticatedUser, 'id'> & Partial<Omit<AuthenticatedUser, 'id'>>;
import type { OrderDeadlineSyncPort } from '../../orders/application/order-transaction.types';
import type { DeadlineInstanceDto } from '../dto/deadline-instance.dto';
import type { DeadlineStatus } from '../domain/deadline-status';
import { getCompletionDeadlineStatus } from '../domain/deadline-status';
import type { DeadlineEntityType } from '../domain/deadline-validation';
import { PgDeadlineRepository, mapDeadline, type DeadlineRow as DeadlineFullRow } from './pg-deadline-repository';
import { PgOutboxPort } from './pg-outbox-port';

/** Correlation of a final-deadline reconciliation with the request that asked for it (event payloads). */
export interface FinalDeadlineReconcileContext {
  correlationId?: string | null;
  initiatorUserId?: string | null;
  /**
   * Background pass: initiator and correlation are those of the newest «sync requested» mark in the SAME snapshot
   * the reconciliation acts on (a command committing after the queue was read is attributed to itself).
   */
  fromSnapshotMarks?: boolean;
}

interface OrderDeadlineSourceRow {
  order_id: string | number;
  client_id: string | number | null;
  manager_id: string | number | null;
  planned_completion_date: string | Date | null;
  completion_date: string | Date | null;
  delete_flag: boolean;
}

interface WorkshopDeadlineSourceRow {
  order_workshop_id: string | number;
  order_id: string | number;
  workshop_id: string | number;
  workshop_name: string | null;
  production_status_id: string | number | null;
  planned_completion_date: string | Date | null;
  completed_date: string | Date | null;
  responsible_employee_id: string | number | null;
  responsible_user_id: string | number | null;
  manager_id: string | number | null;
  delete_flag: boolean;
}

interface DeadlineRow {
  deadline_id: string;
  entity_id?: string;
  deadline_at: string | Date;
  status: DeadlineStatus;
}

export class PgOrderDeadlineSync implements OrderDeadlineSyncPort {
  constructor(private readonly database: DatabaseService) {}

  async syncOrderDeadlinesAfterSave(input: {
    orderId: number;
    currentUser: CurrentUser;
    eventType: 'ORDER_CREATED' | 'ORDER_UPDATED';
    requestId?: string;
  }): Promise<void> {
    const seen = await this.database.transaction((tx) => this.syncAll(tx, input, true));
    await this.database.transaction((tx) => clearReworkSyncMarks(tx, input.orderId, seen));
  }

  /**
   * «Переделка» 1.1 §6.3: only the order's final deadline (round commands after commit, the background pass, the
   * repair command). No order-save event and no stage deadlines: deadline events are written only on a change.
   * The «sync requested» marks seen in the snapshot are cleared afterwards in their own short transaction.
   */
  async reconcileOrderFinalDeadline(input: {
    orderId: number;
    currentUser: CurrentUser;
    requestId?: string;
    context?: FinalDeadlineReconcileContext;
  }): Promise<void> {
    const seen = await this.database.transaction((tx) =>
      this.syncFinalOrderDeadline(tx, input.orderId, input.currentUser, input.requestId, input.context ?? {}),
    );
    await this.database.transaction((tx) => clearReworkSyncMarks(tx, input.orderId, seen));
  }

  async syncOrderDeadlinesInTransaction(
    tx: TransactionClient,
    input: {
      orderId: number;
      currentUser: CurrentUser;
      eventType: 'ORDER_CREATED' | 'ORDER_UPDATED';
      requestId?: string;
    },
    emitOrderEvent: boolean,
  ): Promise<void> {
    const seen = await this.syncAll(tx, input, emitOrderEvent);
    // The caller's transaction: the round rows are touched last, after every deadline row (no reverse wait).
    await clearReworkSyncMarks(tx, input.orderId, seen);
  }

  private async syncAll(
    tx: TransactionClient,
    input: {
      orderId: number;
      currentUser: CurrentUser;
      eventType: 'ORDER_CREATED' | 'ORDER_UPDATED';
      requestId?: string;
    },
    emitOrderEvent: boolean,
  ): Promise<string[]> {
    if (emitOrderEvent) {
      const outbox = new PgOutboxPort(tx);
      await outbox.enqueue({
        eventType: input.eventType,
        aggregateType: 'order',
        aggregateId: String(input.orderId),
        payload: {
          orderId: input.orderId,
          actorUserId: input.currentUser.id,
          requestId: input.requestId ?? null,
          source: 'orders.transaction',
        },
      });
    }

    const seen = await this.syncFinalOrderDeadline(tx, input.orderId, input.currentUser, input.requestId, {});
    await this.syncStageDeadlines(tx, input.orderId, input.currentUser, input.requestId);
    return seen;
  }

  /** Returns the «sync requested» marks of the snapshot the reconciliation acted on (to clear after it). */
  private async syncFinalOrderDeadline(
    tx: TransactionClient,
    orderId: number,
    currentUser: CurrentUser,
    requestId: string | undefined,
    context: FinalDeadlineReconcileContext,
  ): Promise<string[]> {
    // Serializes final-deadline reconciliations of one order (never the order row: the deadline worker locks
    // deadlines first and then may wait for the order — plan 1.1 §6.3). State is read after the lock, as ONE
    // statement: the order dates and its rounds (with their marks) come from the same snapshot.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('order-final-deadline', $1::bigint))", [orderId]);
    const order = await loadOrderDeadlineSnapshot(tx, orderId);

    if (!order) {
      return [];
    }
    const marks = order.rounds.map((round) => round.deadline_sync_requested_at).filter((at): at is string => at != null);
    if (order.delete_flag) {
      // Nothing to reconcile for a deleted order: its marks are done (they must not block the background queue).
      return marks;
    }

    const rounds = order.rounds;
    if (rounds.length > 0) {
      await this.reconcileReworkFinalDeadline(tx, order, rounds, currentUser, requestId, snapshotContext(context, rounds));
      return marks;
    }

    await this.syncOneDeadline(tx, {
      entityType: 'order',
      entityId: String(orderId),
      orderId,
      orderWorkshopId: null,
      clientId: toNullableNumber(order.client_id),
      responsibleUserId: toNullableNumber(order.manager_id),
      plannedCompletionDate: order.planned_completion_date,
      completedDate: order.completion_date,
      metadata: { label: 'Финальный дедлайн заказа' },
      currentUser,
      requestId,
    });
    return [];
  }

  /**
   * «Переделка» 1.1 (plan 2026-10-27-order-rework-deadlines-plan v7, §6.3): the final deadline of an order with
   * production rounds, reconciled from the current state. The current instance is the newest one that is not
   * superseded/cancelled (with or without a round tag); at most one active/paused instance exists.
   */
  private async reconcileReworkFinalDeadline(
    tx: TransactionClient,
    order: OrderDeadlineSourceRow,
    rounds: ReworkRoundRow[],
    currentUser: CurrentUser,
    requestId: string | undefined,
    context: FinalDeadlineReconcileContext,
  ): Promise<void> {
    const orderId = Number(order.order_id);
    const plannedAt = toDeadlineAt(order.planned_completion_date);
    const completedAt = toCompletionAt(order.completion_date);
    const base = {
      entityType: 'order' as const,
      entityId: String(orderId),
      orderId,
      orderWorkshopId: null,
      clientId: toNullableNumber(order.client_id),
      responsibleUserId: toNullableNumber(order.manager_id),
      currentUser,
      requestId,
      eventContext: eventContext(context),
    };
    const label = { label: 'Финальный дедлайн заказа' };
    const instances = await loadFinalDeadlineInstances(tx, orderId);
    const roundOf = (row: FinalDeadlineRow) => toNullableNumber((row.metadata_json?.reworkRoundNo ?? null) as number | null);

    // a. False-positive rounds, newest first: cancel their instances, then restore the immediate predecessor.
    const falsePositive = rounds.filter((round) => round.close_reason === 'false_positive').sort((a, b) => b.round_no - a.round_no);
    for (const round of falsePositive) {
      const chain = instances.filter((row) => roundOf(row) === round.round_no).sort(byCreatedAt);
      for (const row of chain) {
        if (row.status === 'active' || row.status === 'paused' || row.status === 'expired') {
          await this.cancelDeadline(tx, row.deadline_id, currentUser, { reason: 'rework_false_positive', reworkRoundNo: round.round_no, requestId, ...base.eventContext });
          row.status = 'cancelled';
        }
      }
      const predecessorId = chain[0]?.metadata_json?.previousDeadlineId;
      const predecessor = instances.find((row) => row.deadline_id === predecessorId);
      // A predecessor the round superseded (was active/paused) is restored on the current order date — but only if
      // there is a date (a manually cleared date is kept: nothing active then). Completed/expired: it is current again.
      if (predecessor && predecessor.status === 'superseded' && plannedAt) {
        const restored = await this.replaceDeadlineIfNeeded(tx, null, plannedAt, {
          ...base, metadata: { ...label, ...(predecessor.metadata_json ?? {}) },
        }, { idempotencyKey: `order:${orderId}:rework-round:${round.round_no}:fp-restore`, supersedeExisting: false });
        upsertInstance(instances, restored);
      }
    }

    const current = currentFinalInstance(instances);
    const open = rounds.find((round) => round.closed_at === null);

    // b. Only a round that set its own deadline owns the final deadline (an open round without a date: c).
    if (open && open.planned_completion_date != null && plannedAt) {
      const tag = { reworkRoundNo: open.round_no };
      const cancelledInRound = instances.filter((row) => roundOf(row) === open.round_no && row.status === 'cancelled').length;
      const startKey = `order:${orderId}:rework-round:${open.round_no}:start:${cancelledInRound}`;
      if (current && roundOf(current) === open.round_no) {
        await this.followDate(tx, current, plannedAt, completedAt, { ...base, metadata: { ...label, ...(current.metadata_json ?? {}) } });
        return;
      }
      if (current && (current.status === 'completed_on_time' || current.status === 'completed_late') && completedAt) {
        return; // the order is marked completed manually — nothing to reopen
      }
      // Not this round's instance: a new tagged instance (supersedes an active/paused current — one active only;
      // completed/expired stay history: «reopening»).
      const supersede = Boolean(current && (current.status === 'active' || current.status === 'paused'));
      const created = await this.replaceDeadlineIfNeeded(tx, supersede ? current : null, plannedAt, {
        ...base, metadata: { ...label, ...tag, previousDeadlineId: current?.deadline_id ?? null },
      }, { idempotencyKey: startKey, supersedeExisting: supersede });
      if (completedAt && created.status === 'active') await this.completeDeadline(tx, created, completedAt, currentUser, requestId, base.eventContext);
      return;
    }

    // c. No open round (or an open round without a date): the ordinary rules on the current instance.
    if (!plannedAt) {
      if (current && (current.status === 'active' || current.status === 'paused')) {
        await this.cancelDeadline(tx, current.deadline_id, currentUser, { reason: 'planned_completion_date_removed', requestId, ...base.eventContext });
      }
      return;
    }
    if (!current) {
      const created = await this.replaceDeadlineIfNeeded(tx, null, plannedAt, { ...base, metadata: label });
      if (completedAt && created.status === 'active') await this.completeDeadline(tx, created, completedAt, currentUser, requestId, base.eventContext);
      return;
    }
    await this.followDate(tx, current, plannedAt, completedAt, { ...base, metadata: { ...label, ...(current.metadata_json ?? {}) } });
  }

  /** The current instance follows the order date: same date → responsibility; new date → replacement (tags kept). */
  private async followDate(
    tx: TransactionClient,
    current: FinalDeadlineRow,
    plannedAt: string,
    completedAt: string | null,
    input: Parameters<PgOrderDeadlineSync['replaceDeadlineIfNeeded']>[3],
  ): Promise<void> {
    if (current.status === 'completed_on_time' || current.status === 'completed_late') return;
    if (current.status === 'expired') {
      // Expiry is a fact: the same date changes nothing; a new date starts a new active instance (tags kept).
      if (toIso(current.deadline_at) === plannedAt) return;
      const created = await this.replaceDeadlineIfNeeded(tx, null, plannedAt, input, { supersedeExisting: false });
      if (completedAt) await this.completeDeadline(tx, created, completedAt, input.currentUser, input.requestId, input.eventContext);
      return;
    }
    const deadline = toIso(current.deadline_at) === plannedAt
      ? await this.updateDeadlineResponsibility(tx, current.deadline_id, input)
      : await this.replaceDeadlineIfNeeded(tx, current, plannedAt, input);
    if (completedAt && deadline.status === 'active') {
      await this.completeDeadline(tx, deadline, completedAt, input.currentUser, input.requestId, input.eventContext);
    }
  }

  private async syncStageDeadlines(
    tx: TransactionClient,
    orderId: number,
    currentUser: CurrentUser,
    requestId: string | undefined,
  ): Promise<void> {
    const result = await tx.query<WorkshopDeadlineSourceRow>(
      `
      SELECT ow.order_workshop_id, ow.order_id, ow.workshop_id, w.workshop_name,
             ow.production_status_id, ow.planned_completion_date, ow.completed_date,
             ow.responsible_employee_id, u.user_id AS responsible_user_id,
             o.manager_id, ow.delete_flag
      FROM order_workshops ow
      JOIN orders o ON o.order_id = ow.order_id
      LEFT JOIN workshops w ON w.workshop_id = ow.workshop_id
      LEFT JOIN users u ON u.employee_id = ow.responsible_employee_id AND u.is_active = true
      WHERE ow.order_id = $1 AND o.order_kind = 'production_order'
      ORDER BY ow.order_workshop_id ASC
      `,
      [orderId],
    );
    const activeWorkshopIds = new Set<number>();

    for (const workshop of result.rows) {
      const workshopId = Number(workshop.order_workshop_id);

      if (workshop.delete_flag) {
        continue;
      }

      activeWorkshopIds.add(workshopId);
      await this.syncOneDeadline(tx, {
        entityType: 'order_stage',
        entityId: String(workshopId),
        orderId,
        orderWorkshopId: workshopId,
        clientId: null,
        responsibleUserId:
          toNullableNumber(workshop.responsible_user_id) ?? toNullableNumber(workshop.manager_id),
        plannedCompletionDate: workshop.planned_completion_date,
        completedDate: workshop.completed_date,
        metadata: {
          label: 'Дедлайн этапа производства',
          stageName: workshop.workshop_name,
          workshopId: toNullableNumber(workshop.workshop_id),
          productionStatusId: toNullableNumber(workshop.production_status_id),
        },
        currentUser,
        requestId,
      });
    }

    await this.cancelRemovedStageDeadlines(tx, orderId, activeWorkshopIds, currentUser, requestId);
  }

  private async syncOneDeadline(
    tx: TransactionClient,
    input: {
      entityType: DeadlineEntityType;
      entityId: string;
      orderId: number;
      orderWorkshopId: number | null;
      clientId: number | null;
      responsibleUserId: number | null;
      plannedCompletionDate: string | Date | null;
      completedDate: string | Date | null;
      metadata: Record<string, unknown>;
      currentUser: CurrentUser;
      requestId?: string;
    },
  ): Promise<void> {
    const existing = await findCurrentDeadline(tx, input.entityType, input.entityId);
    const plannedAt = toDeadlineAt(input.plannedCompletionDate);

    if (!plannedAt) {
      if (existing && (existing.status === 'active' || existing.status === 'paused')) {
        await this.cancelDeadline(tx, existing.deadline_id, input.currentUser, {
          reason: 'planned_completion_date_removed',
          requestId: input.requestId,
        });
      }
      return;
    }

    if (
      existing &&
      (existing.status === 'completed_on_time' || existing.status === 'completed_late')
    ) {
      return;
    }

    const deadline =
      existing && toIso(existing.deadline_at) === plannedAt
        ? await this.updateDeadlineResponsibility(tx, existing.deadline_id, input)
        : await this.replaceDeadlineIfNeeded(tx, existing, plannedAt, input);

    const completedAt = toCompletionAt(input.completedDate);
    if (completedAt && deadline.status === 'active') {
      await this.completeDeadline(tx, deadline, completedAt, input.currentUser, input.requestId);
    }
  }

  private async replaceDeadlineIfNeeded(
    tx: TransactionClient,
    existing: DeadlineRow | null,
    deadlineAt: string,
    input: {
      entityType: DeadlineEntityType;
      entityId: string;
      orderId: number;
      orderWorkshopId: number | null;
      clientId: number | null;
      responsibleUserId: number | null;
      metadata: Record<string, unknown>;
      currentUser: CurrentUser;
      requestId?: string;
      /** Extra event payload (actor kind, initiator, correlation) of a final-deadline reconciliation. */
      eventContext?: Record<string, unknown>;
    },
    options: { idempotencyKey?: string; supersedeExisting?: boolean } = {},
  ): Promise<DeadlineInstanceDto> {
    if (options.idempotencyKey) {
      // Repeat of the same reconciliation step: the instance exists already — no new instance, no events.
      const same = await tx.query<DeadlineFullRow>(
        'SELECT * FROM deadline_instances WHERE idempotency_key = $1',
        [options.idempotencyKey],
      );
      if (same.rows[0]) return mapDeadline(same.rows[0]);
    }
    if (existing && options.supersedeExisting !== false) {
      await tx.query(
        `
        UPDATE deadline_instances
        SET status = 'superseded',
            updated_by_user_id = $2,
            updated_at = now()
        WHERE deadline_id = $1
        `,
        [existing.deadline_id, actorDbId(input.currentUser)],
      );
    }

    const inserted = await tx.query<DeadlineFullRow>(
      `
      INSERT INTO deadline_instances (
        entity_type, entity_id, order_id, order_workshop_id, client_id,
        responsible_user_id, deadline_at, status, source, metadata_json,
        created_by_user_id, updated_by_user_id, idempotency_key
      )
      -- The client is the order's at this statement (a copy; a merge of clients may have moved the order since it was read).
      VALUES ($1, $2, $3, $4, COALESCE((SELECT o.client_id FROM orders o WHERE o.order_id = $3::bigint), $5::bigint), $6, $7::timestamptz, 'active', 'recalculated', $8::jsonb, $9, $9, $10)
      RETURNING *
      `,
      [
        input.entityType,
        input.entityId,
        input.orderId,
        input.orderWorkshopId,
        input.clientId,
        input.responsibleUserId,
        deadlineAt,
        JSON.stringify(input.metadata),
        actorDbId(input.currentUser),
        options.idempotencyKey ?? null,
      ],
    );
    const deadline = mapDeadline(inserted.rows[0]);
    const eventType = existing ? 'DEADLINE_UPDATED' : 'DEADLINE_CREATED';
    await new PgDeadlineRepository(tx).createDeadlineEvent({
      deadlineId: deadline.deadlineId,
      eventType,
      severity: existing ? 'warning' : 'info',
      entityType: deadline.entityType,
      entityId: deadline.entityId,
      orderId: deadline.orderId,
      orderWorkshopId: deadline.orderWorkshopId,
      clientId: deadline.clientId,
      deadlineAt: deadline.deadlineAt,
      eventAt: new Date().toISOString(),
      payload: {
        source: 'orders.sync',
        previousDeadlineId: existing?.deadline_id ?? null,
        ...actorPayload(input.currentUser),
        requestId: input.requestId,
        ...(input.eventContext ?? {}),
      },
    });

    return deadline;
  }

  private async updateDeadlineResponsibility(
    tx: TransactionClient,
    deadlineId: string,
    input: {
      responsibleUserId: number | null;
      metadata: Record<string, unknown>;
      currentUser: CurrentUser;
    },
  ): Promise<DeadlineInstanceDto> {
    const result = await tx.query<DeadlineFullRow>(
      `
      UPDATE deadline_instances
      SET responsible_user_id = $2,
          -- Merge: keys set elsewhere (e.g. the «Переделка» round of the instance) are never dropped.
          metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $3::jsonb,
          updated_by_user_id = $4,
          updated_at = now()
      WHERE deadline_id = $1
      RETURNING *
      `,
      [
        deadlineId,
        input.responsibleUserId,
        JSON.stringify(input.metadata),
        actorDbId(input.currentUser),
      ],
    );

    return mapDeadline(result.rows[0]);
  }

  private async completeDeadline(
    tx: TransactionClient,
    deadline: DeadlineInstanceDto,
    completedAt: string,
    currentUser: CurrentUser,
    requestId: string | undefined,
    context: Record<string, unknown> = {},
  ): Promise<void> {
    const status = getCompletionDeadlineStatus({
      deadlineAt: deadline.deadlineAt,
      completedAt,
    });
    await tx.query(
      `
      UPDATE deadline_instances
      SET status = $2,
          completed_at = $3::timestamptz,
          updated_by_user_id = $4,
          updated_at = now()
      WHERE deadline_id = $1
      `,
      [deadline.deadlineId, status, completedAt, actorDbId(currentUser)],
    );
    await new PgDeadlineRepository(tx).createDeadlineEvent({
      deadlineId: deadline.deadlineId,
      eventType:
        status === 'completed_on_time' ? 'DEADLINE_COMPLETED_ON_TIME' : 'DEADLINE_COMPLETED_LATE',
      severity: status === 'completed_on_time' ? 'info' : 'warning',
      entityType: deadline.entityType,
      entityId: deadline.entityId,
      orderId: deadline.orderId,
      orderWorkshopId: deadline.orderWorkshopId,
      clientId: deadline.clientId,
      deadlineAt: deadline.deadlineAt,
      eventAt: new Date().toISOString(),
      payload: { source: 'orders.sync', completedAt, ...actorPayload(currentUser), requestId, ...context },
    });
  }

  private async cancelDeadline(
    tx: TransactionClient,
    deadlineId: string,
    currentUser: CurrentUser,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const result = await tx.query<DeadlineFullRow>(
      `
      UPDATE deadline_instances
      SET status = 'cancelled',
          cancelled_at = now(),
          updated_by_user_id = $2,
          updated_at = now()
      WHERE deadline_id = $1
      RETURNING *
      `,
      [deadlineId, actorDbId(currentUser)],
    );
    const deadline = mapDeadline(result.rows[0]);
    await new PgDeadlineRepository(tx).createDeadlineEvent({
      deadlineId: deadline.deadlineId,
      eventType: 'DEADLINE_CANCELLED',
      severity: 'info',
      entityType: deadline.entityType,
      entityId: deadline.entityId,
      orderId: deadline.orderId,
      orderWorkshopId: deadline.orderWorkshopId,
      clientId: deadline.clientId,
      deadlineAt: deadline.deadlineAt,
      eventAt: new Date().toISOString(),
      payload: { source: 'orders.sync', ...payload, ...actorPayload(currentUser) },
    });
  }

  private async cancelRemovedStageDeadlines(
    tx: TransactionClient,
    orderId: number,
    activeWorkshopIds: Set<number>,
    currentUser: CurrentUser,
    requestId: string | undefined,
  ): Promise<void> {
    const result = await tx.query<DeadlineRow>(
      `
      SELECT deadline_id, entity_id, deadline_at, status
      FROM deadline_instances
      WHERE order_id = $1
        AND entity_type = 'order_stage'
        AND status IN ('active', 'paused')
      FOR UPDATE
      `,
      [orderId],
    );

    for (const row of result.rows) {
      const entityId = Number(row.entity_id);

      if (!Number.isFinite(entityId)) {
        continue;
      }

      if (!activeWorkshopIds.has(entityId)) {
        await this.cancelDeadline(tx, row.deadline_id, currentUser, {
          reason: 'order_workshop_removed',
          requestId,
        });
      }
    }
  }
}

interface ReworkRoundRow {
  round_no: number;
  closed_at: string | null;
  close_reason: string | null;
  /** The round's own deadline (null: the round did not set one — the order's deadline follows the ordinary rules). */
  planned_completion_date: string | null;
  /** Text (full precision): cleared by comparing in SQL, a JS Date would cut the microseconds. */
  deadline_sync_requested_at: string | null;
  /** Request id and user of the command that set the mark (281). */
  deadline_sync_request_id: string | null;
  deadline_sync_requested_by: string | null;
}

interface OrderDeadlineSnapshotRow extends OrderDeadlineSourceRow {
  rounds: ReworkRoundRow[];
}

interface FinalDeadlineRow {
  deadline_id: string;
  deadline_at: string | Date;
  status: DeadlineStatus | 'superseded' | 'cancelled' | 'expired';
  created_at: string | Date;
  metadata_json: Record<string, unknown> | null;
}

/**
 * The order and its production rounds («Переделка», 274/281) in ONE statement — one snapshot, so a round command
 * committing in between is seen either entirely (new dates and its mark) or not at all.
 */
async function loadOrderDeadlineSnapshot(tx: TransactionClient, orderId: number): Promise<OrderDeadlineSnapshotRow | null> {
  const present = await tx.query<{ present: boolean }>(
    "SELECT to_regclass('public.order_production_rounds') IS NOT NULL AS present",
  );
  const rounds = present.rows[0]?.present
    ? `COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.round_no) FROM order_production_rounds r WHERE r.order_id = o.order_id), '[]'::jsonb)`
    : `'[]'::jsonb`;
  const result = await tx.query<Omit<OrderDeadlineSnapshotRow, 'rounds'> & { rounds?: Array<Record<string, unknown>> | null }>(
    `SELECT o.order_id, o.client_id, o.manager_id, o.planned_completion_date, o.completion_date, o.delete_flag,
            ${rounds} AS rounds
       FROM orders o
      WHERE o.order_id = $1 AND o.order_kind = 'production_order'
      LIMIT 1`,
    [orderId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    ...row,
    rounds: (row.rounds ?? []).map((round) => ({
      round_no: Number(round.round_no),
      closed_at: (round.closed_at as string | null | undefined) ?? null,
      close_reason: (round.close_reason as string | null | undefined) ?? null,
      planned_completion_date: (round.planned_completion_date as string | null | undefined) ?? null,
      deadline_sync_requested_at: (round.deadline_sync_requested_at as string | null | undefined) ?? null,
      deadline_sync_request_id: (round.deadline_sync_request_id as string | null | undefined) ?? null,
      deadline_sync_requested_by: round.deadline_sync_requested_by == null ? null : String(round.deadline_sync_requested_by),
    })),
  };
}

/** Clears the marks the reconciliation acted on (≤ the newest seen); a newer mark stays for the next pass. */
async function clearReworkSyncMarks(tx: TransactionClient, orderId: number, seen: string[]): Promise<void> {
  if (seen.length === 0) return;
  await tx.query(
    `UPDATE order_production_rounds
        SET deadline_sync_requested_at = NULL, deadline_sync_request_id = NULL, deadline_sync_requested_by = NULL
      WHERE order_id = $1 AND deadline_sync_requested_at <= (SELECT max(seen) FROM unnest($2::timestamptz[]) AS seen)`,
    [orderId, seen],
  );
}

/** Deadline rows reference users: the system actor is stored as NULL. */
function actorDbId(user: CurrentUser): number | null {
  const id = Number(user.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Event payload actor: a user id, or `actorUserId: null` + the named system actor (audit rows reference users). */
function actorPayload(user: CurrentUser): Record<string, unknown> {
  return actorDbId(user) === null ? { actorUserId: null, actor: user.id } : { actorUserId: user.id };
}

/** For the background pass: initiator/correlation from the newest mark of the snapshot (none marked: as given). */
function snapshotContext(context: FinalDeadlineReconcileContext, rounds: ReworkRoundRow[]): FinalDeadlineReconcileContext {
  if (!context.fromSnapshotMarks) return context;
  const newest = rounds
    .filter((round) => round.deadline_sync_requested_at != null)
    .sort((a, b) => Date.parse(b.deadline_sync_requested_at as string) - Date.parse(a.deadline_sync_requested_at as string))[0];
  if (!newest) return context;
  return { correlationId: newest.deadline_sync_request_id, initiatorUserId: newest.deadline_sync_requested_by };
}

function eventContext(context: FinalDeadlineReconcileContext): Record<string, unknown> {
  return {
    ...(context.correlationId ? { correlationId: context.correlationId } : {}),
    ...(context.initiatorUserId ? { initiatorUserId: context.initiatorUserId } : {}),
  };
}

/** Every final-deadline instance of the order, locked (the reconciliation decides on the whole history). */
async function loadFinalDeadlineInstances(tx: TransactionClient, orderId: number): Promise<FinalDeadlineRow[]> {
  const result = await tx.query<FinalDeadlineRow>(
    `SELECT deadline_id, deadline_at, status, created_at, metadata_json
       FROM deadline_instances
      WHERE entity_type = 'order' AND entity_id = $1
      ORDER BY created_at, deadline_id
      FOR UPDATE`,
    [String(orderId)],
  );
  return result.rows;
}

function byCreatedAt(a: FinalDeadlineRow, b: FinalDeadlineRow): number {
  return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
}

/** The newest instance that is not superseded/cancelled. */
function currentFinalInstance(instances: FinalDeadlineRow[]): FinalDeadlineRow | null {
  const live = instances.filter((row) => row.status !== 'superseded' && row.status !== 'cancelled').sort(byCreatedAt);
  return live[live.length - 1] ?? null;
}

function upsertInstance(instances: FinalDeadlineRow[], deadline: DeadlineInstanceDto): void {
  if (instances.some((row) => row.deadline_id === deadline.deadlineId)) return;
  instances.push({
    deadline_id: deadline.deadlineId,
    deadline_at: deadline.deadlineAt,
    status: deadline.status as FinalDeadlineRow['status'],
    created_at: new Date().toISOString(),
    metadata_json: (deadline.metadata ?? null) as Record<string, unknown> | null,
  });
}

async function findCurrentDeadline(
  tx: TransactionClient,
  entityType: DeadlineEntityType,
  entityId: string,
): Promise<DeadlineRow | null> {
  const result = await tx.query<DeadlineRow>(
    `
    SELECT deadline_id, deadline_at, status
    FROM deadline_instances
    WHERE entity_type = $1
      AND entity_id = $2
      AND status IN ('active', 'paused', 'completed_on_time', 'completed_late')
    ORDER BY created_at DESC
    LIMIT 1
    FOR UPDATE
    `,
    [entityType, entityId],
  );

  return result.rows[0] ?? null;
}

function toDeadlineAt(value: string | Date | null): string | null {
  const date = toDateOnly(value);
  if (!date) return null;

  return new Date(`${date}T23:59:59.000Z`).toISOString();
}

function toCompletionAt(value: string | Date | null): string | null {
  const date = toDateOnly(value);
  if (!date) return null;

  return new Date(`${date}T23:59:59.000Z`).toISOString();
}

function toDateOnly(value: string | Date | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);

  return value.slice(0, 10);
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableNumber(value: string | number | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
