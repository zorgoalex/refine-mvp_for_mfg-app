import type { DatabaseClient } from '../../../database/database.types';
import type {
  DeadlineTargetRef,
  DeadlineTargetResolverPort,
  DeadlineTargetState,
} from '../application/deadline.types';
import type { DeadlineActionType } from '../domain/deadline-actions';

interface OrderTargetRow {
  order_id: string | number;
  client_id: string | number | null;
  manager_id: string | number | null;
  completion_date: string | Date | null;
  delete_flag: boolean;
}

interface WorkshopTargetRow {
  order_workshop_id: string | number;
  order_id: string | number;
  workshop_id: string | number;
  workshop_name: string | null;
  production_status_id: string | number | null;
  responsible_employee_id: string | number | null;
  responsible_user_id: string | number | null;
  manager_id: string | number | null;
  completed_date: string | Date | null;
  delete_flag: boolean;
}

export class PgDeadlineTargetResolver implements DeadlineTargetResolverPort {
  constructor(private readonly database: DatabaseClient) {}

  async resolveTargetState(input: DeadlineTargetRef): Promise<DeadlineTargetState> {
    if (input.entityType === 'order') {
      return this.resolveOrder(input);
    }

    if (input.entityType === 'order_stage') {
      return this.resolveOrderStage(input);
    }

    if (input.entityType === 'client_action' && input.orderId) {
      return this.resolveClientAction(input);
    }

    return {
      isCompleted: false,
      completedAt: null,
      responsibleUserIds: [],
      auditContext: {
        entityType: input.entityType,
        entityId: input.entityId,
        unresolved: true,
      },
    };
  }

  async canApplyAction(input: {
    actionType: DeadlineActionType;
    target: DeadlineTargetRef;
  }): Promise<boolean> {
    if (input.actionType === 'change_order_status') {
      return false;
    }

    const target = await this.resolveTargetState(input.target);
    if (input.actionType === 'change_production_status') {
      return !target.auditContext.unresolved && Boolean(target.auditContext.orderId ?? input.target.orderId);
    }

    return !target.auditContext.unresolved;
  }

  private async resolveOrder(input: DeadlineTargetRef): Promise<DeadlineTargetState> {
    const orderId = input.orderId ?? Number(input.entityId);
    const result = await this.database.query<OrderTargetRow>(
      `
      SELECT order_id, client_id, manager_id, completion_date, delete_flag
      FROM orders
      WHERE order_id = $1
      LIMIT 1
      `,
      [orderId],
    );
    const row = result.rows[0];

    if (!row || row.delete_flag) {
      return unresolved(input);
    }

    const managerUserId = toNullableNumber(row.manager_id);

    return {
      isCompleted: row.completion_date !== null,
      completedAt: toNullableIso(row.completion_date),
      responsibleUserIds: compactNumbers([managerUserId]),
      notificationRecipients: {
        assigneeUserId: managerUserId,
        managerUserId,
        departmentHeadUserId: managerUserId,
      },
      auditContext: {
        entityType: 'order',
        orderId: Number(row.order_id),
        clientId: toNullableNumber(row.client_id),
      },
    };
  }

  private async resolveOrderStage(input: DeadlineTargetRef): Promise<DeadlineTargetState> {
    const workshopId = input.orderWorkshopId ?? Number(input.entityId);
    const result = await this.database.query<WorkshopTargetRow>(
      `
      SELECT ow.order_workshop_id, ow.order_id, ow.workshop_id, w.workshop_name,
             ow.production_status_id, ow.responsible_employee_id,
             u.user_id AS responsible_user_id, o.manager_id, ow.completed_date, ow.delete_flag
      FROM order_workshops ow
      JOIN orders o ON o.order_id = ow.order_id
      LEFT JOIN workshops w ON w.workshop_id = ow.workshop_id
      LEFT JOIN users u ON u.employee_id = ow.responsible_employee_id AND u.is_active = true
      WHERE ow.order_workshop_id = $1
      LIMIT 1
      `,
      [workshopId],
    );
    const row = result.rows[0];

    if (!row || row.delete_flag) {
      return unresolved(input);
    }

    const assigneeUserId = toNullableNumber(row.responsible_user_id);
    const managerUserId = toNullableNumber(row.manager_id);

    return {
      isCompleted: row.completed_date !== null,
      completedAt: toNullableIso(row.completed_date),
      responsibleUserIds: compactNumbers([assigneeUserId, managerUserId]),
      notificationRecipients: {
        assigneeUserId,
        managerUserId,
        departmentHeadUserId: managerUserId,
      },
      auditContext: {
        entityType: 'order_stage',
        orderId: Number(row.order_id),
        orderWorkshopId: Number(row.order_workshop_id),
        workshopId: Number(row.workshop_id),
        workshopName: row.workshop_name,
        productionStatusId: toNullableNumber(row.production_status_id),
      },
    };
  }

  private async resolveClientAction(input: DeadlineTargetRef): Promise<DeadlineTargetState> {
    const orderState = await this.resolveOrder({
      entityType: 'order',
      entityId: String(input.orderId),
      orderId: input.orderId,
    });

    return {
      ...orderState,
      isCompleted: false,
      completedAt: null,
      auditContext: {
        ...orderState.auditContext,
        entityType: 'client_action',
        entityId: input.entityId,
      },
    };
  }
}

function unresolved(input: DeadlineTargetRef): DeadlineTargetState {
  return {
    isCompleted: false,
    completedAt: null,
    responsibleUserIds: [],
    auditContext: {
      entityType: input.entityType,
      entityId: input.entityId,
      orderId: input.orderId ?? null,
      orderWorkshopId: input.orderWorkshopId ?? null,
      unresolved: true,
    },
  };
}

function compactNumbers(values: Array<string | number | null | undefined>): number[] {
  return [...new Set(values.map(toNullableNumber).filter((value): value is number => value !== null))];
}

function toNullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNullableIso(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
