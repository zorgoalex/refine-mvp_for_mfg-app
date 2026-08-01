import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { OrderDeadlineSyncPort } from '../../orders/application/order-transaction.types';
import type { DeadlineInstanceDto } from '../dto/deadline-instance.dto';
import type { DeadlineStatus } from '../domain/deadline-status';
import { getCompletionDeadlineStatus } from '../domain/deadline-status';
import type { DeadlineEntityType } from '../domain/deadline-validation';
import { PgDeadlineRepository, mapDeadline, type DeadlineRow as DeadlineFullRow } from './pg-deadline-repository';
import { PgOutboxPort } from './pg-outbox-port';

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
    await this.database.transaction(async (tx) => {
      await this.syncOrderDeadlinesInTransaction(tx, input, true);
    });
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

    await this.syncFinalOrderDeadline(tx, input.orderId, input.currentUser, input.requestId);
    await this.syncStageDeadlines(tx, input.orderId, input.currentUser, input.requestId);
  }

  private async syncFinalOrderDeadline(
    tx: TransactionClient,
    orderId: number,
    currentUser: CurrentUser,
    requestId: string | undefined,
  ): Promise<void> {
    const result = await tx.query<OrderDeadlineSourceRow>(
      `
      SELECT order_id, client_id, manager_id, planned_completion_date, completion_date, delete_flag
      FROM orders
      WHERE order_id = $1 AND order_kind = 'production_order'
      LIMIT 1
      `,
      [orderId],
    );
    const order = result.rows[0];

    if (!order || order.delete_flag) {
      return;
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
    },
  ): Promise<DeadlineInstanceDto> {
    if (existing) {
      await tx.query(
        `
        UPDATE deadline_instances
        SET status = 'superseded',
            updated_by_user_id = $2,
            updated_at = now()
        WHERE deadline_id = $1
        `,
        [existing.deadline_id, Number(input.currentUser.id)],
      );
    }

    const inserted = await tx.query<DeadlineFullRow>(
      `
      INSERT INTO deadline_instances (
        entity_type, entity_id, order_id, order_workshop_id, client_id,
        responsible_user_id, deadline_at, status, source, metadata_json,
        created_by_user_id, updated_by_user_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, 'active', 'recalculated', $8::jsonb, $9, $9)
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
        Number(input.currentUser.id),
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
        actorUserId: input.currentUser.id,
        requestId: input.requestId,
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
          metadata_json = $3::jsonb,
          updated_by_user_id = $4,
          updated_at = now()
      WHERE deadline_id = $1
      RETURNING *
      `,
      [
        deadlineId,
        input.responsibleUserId,
        JSON.stringify(input.metadata),
        Number(input.currentUser.id),
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
      [deadline.deadlineId, status, completedAt, Number(currentUser.id)],
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
      payload: { source: 'orders.sync', completedAt, actorUserId: currentUser.id, requestId },
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
      [deadlineId, Number(currentUser.id)],
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
      payload: { source: 'orders.sync', ...payload, actorUserId: currentUser.id },
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
