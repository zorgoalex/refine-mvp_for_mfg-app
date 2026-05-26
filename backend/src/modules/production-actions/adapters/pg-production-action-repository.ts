import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { OrderAccessPolicy } from '../../../permissions/policies/order-access.policy';
import type {
  ActivateProductionStageCommand,
  ActivateDetailProductionStageCommand,
  ChangeOrderStatusCommand,
  ChangeOrderStatusFromDeadlineCommand,
  ChangeOrderStatusFromDeadlineResult,
  ChangePaymentStatusCommand,
  ChangeProductionStatusCommand,
  DeactivateProductionStageCommand,
  MoveCalendarDateCommand,
  ProductionActionRepositoryPort,
} from '../application/production-action.types';
import type { ProductionActionResponseDto } from '../dto/production-action.dto';
import {
  ProductionActionIdempotencyFailedError,
  ProductionActionIdempotencyInProgressError,
  ProductionActionIdempotencyKeyReusedError,
  ProductionActionOrderDetailNotFoundError,
  ProductionActionOrderNotFoundError,
  ProductionActionStatusNotFoundError,
  ProductionActionVersionConflictError,
} from '../errors/production-action.errors';

const SOURCE = 'backend-production-command';

interface LockedOrderRow extends QueryResultRow {
  order_id: string | number;
  client_id: string | number | null;
  order_date: string | Date;
  planned_completion_date: string | Date | null;
  order_status_id: string | number;
  payment_status_id: string | number;
  production_status_id: string | number | null;
  production_status_from_details_enabled: boolean | string | number | null;
  version: string | number;
  created_by: string | number | null;
  manager_id: string | number | null;
}

interface OrderStatusRow extends QueryResultRow {
  order_status_id: string | number;
  order_status_name: string;
}

interface PaymentStatusRow extends QueryResultRow {
  payment_status_id: string | number;
  payment_status_name: string;
}

interface ProductionStatusRow extends QueryResultRow {
  production_status_id: string | number;
  production_status_name: string;
  production_status_code: string;
}

interface ProductionEventRow extends QueryResultRow {
  event_id: string | number;
}

interface VersionRow extends QueryResultRow {
  version: string | number;
}

interface AuditRow extends QueryResultRow {
  audit_id: string;
}

interface IdempotencyRow extends QueryResultRow {
  idempotency_key: string;
  request_hash: string;
  response_json: ProductionActionResponseDto | string | null;
  status: 'processing' | 'completed' | 'failed';
}

interface DetailProductionStatusRow extends QueryResultRow {
  detail_id: string | number;
  production_status_id: string | number | null;
}

interface DetailProductionStatusSnapshot {
  detailIds: number[];
  statusDistribution: Record<string, number>;
}

interface LockedOrder {
  orderId: number;
  clientId: number | null;
  orderDate: string;
  plannedCompletionDate: string | null;
  orderStatusId: number;
  paymentStatusId: number;
  productionStatusId: number | null;
  productionStatusFromDetailsEnabled: boolean;
  version: number;
  createdByUserId: string | null;
  managerUserId: string | null;
}

interface LockedOrderDetailRow extends QueryResultRow {
  detail_id: string | number;
  order_id: string | number;
  client_id: string | number | null;
  production_status_id: string | number | null;
  production_status_from_details_enabled: boolean | string | number | null;
  version: string | number;
  created_by: string | number | null;
  manager_id: string | number | null;
}

interface LockedOrderDetail {
  detailId: number;
  order: LockedOrder;
}

type CommandName =
  | 'orders.calendar_move'
  | 'orders.status_change'
  | 'orders.payment_status_change'
  | 'orders.production_status_change'
  | 'production.stage_activate'
  | 'production.stage_deactivate'
  | 'production.detail_stage_activate';

export class PgProductionActionRepository implements ProductionActionRepositoryPort {
  private readonly orderAccessPolicy = new OrderAccessPolicy();

  constructor(private readonly database: DatabaseService) {}

  moveCalendarDate(command: MoveCalendarDateCommand): Promise<ProductionActionResponseDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);

      const requestId = requestIdOrFallback(command.requestId);
      const idempotency = await reconcileIdempotency(tx, {
        idempotencyKey: command.dto.idempotencyKey,
        commandName: 'orders.calendar_move',
        currentUser: command.currentUser,
        entityType: 'order',
        entityId: String(command.orderId),
        requestShape: {
          actorUserId: command.currentUser.id,
          commandName: 'orders.calendar_move',
          orderId: command.orderId,
          plannedCompletionDate: command.dto.plannedCompletionDate,
          version: command.dto.version,
        },
      });
      if (idempotency.completedResponse) {
        return idempotency.completedResponse;
      }

      const order = await loadOrderForUpdate(tx, command.orderId);
      await this.assertOrderScope(command.currentUser, order, ['orders.update', 'calendar.view'], requestId);
      assertVersion(order, command.dto.version);
      assertPlannedDateAllowed(order, command.dto.plannedCompletionDate);

      if (order.plannedCompletionDate === command.dto.plannedCompletionDate) {
        const response = {
          order: {
            orderId: order.orderId,
            plannedCompletionDate: order.plannedCompletionDate,
            version: order.version,
          },
          requestId,
        };
        await completeIdempotency(tx, command.dto.idempotencyKey, response);
        return response;
      }

      const nextVersion = await updateCalendarDate(
        tx,
        order.orderId,
        command.dto.plannedCompletionDate,
      );
      const auditId = await writeAudit(tx, {
        event: 'orders.calendar_move',
        currentUser: command.currentUser,
        requestId,
        order,
        source: SOURCE,
        beforeJson: {
          plannedCompletionDate: order.plannedCompletionDate,
          version: order.version,
        },
        afterJson: {
          plannedCompletionDate: command.dto.plannedCompletionDate,
          version: nextVersion,
        },
        diffJson: {
          plannedCompletionDate: {
            before: order.plannedCompletionDate,
            after: command.dto.plannedCompletionDate,
          },
        },
        metadataJson: {
          source: SOURCE,
          orderId: order.orderId,
          clientId: order.clientId,
          action: 'move',
          requestId,
        },
      });

      await enqueueOutbox(tx, {
        eventType: 'order.calendar_moved',
        aggregateType: 'order',
        aggregateId: String(order.orderId),
        idempotencyKey: command.dto.idempotencyKey,
        payload: {
          eventType: 'order.calendar_moved',
          actorUserId: command.currentUser.id,
          requestId,
          entityType: 'order',
          entityId: String(order.orderId),
          orderId: order.orderId,
          clientId: order.clientId,
          action: 'move',
          scope: { source: 'calendar' },
          idempotencyKey: command.dto.idempotencyKey,
        },
      });
      await enqueueOutbox(tx, {
        eventType: 'deadline.order_sync_requested',
        aggregateType: 'order',
        aggregateId: String(order.orderId),
        idempotencyKey: `${command.dto.idempotencyKey}:deadline-sync`,
        payload: {
          eventType: 'deadline.order_sync_requested',
          actorUserId: command.currentUser.id,
          requestId,
          entityType: 'order',
          entityId: String(order.orderId),
          orderId: order.orderId,
          clientId: order.clientId,
          action: 'deadline_sync',
          scope: { source: 'calendar' },
          idempotencyKey: `${command.dto.idempotencyKey}:deadline-sync`,
        },
      });

      const response = {
        order: {
          orderId: order.orderId,
          plannedCompletionDate: command.dto.plannedCompletionDate,
          version: nextVersion,
        },
        auditId,
        requestId,
      };
      await completeIdempotency(tx, command.dto.idempotencyKey, response);
      return response;
    });
  }

  changeOrderStatus(command: ChangeOrderStatusCommand): Promise<ProductionActionResponseDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);

      const requestId = requestIdOrFallback(command.requestId);
      const idempotency = await reconcileIdempotency(tx, {
        idempotencyKey: command.dto.idempotencyKey,
        commandName: 'orders.status_change',
        currentUser: command.currentUser,
        entityType: 'order',
        entityId: String(command.orderId),
        requestShape: {
          actorUserId: command.currentUser.id,
          commandName: 'orders.status_change',
          orderId: command.orderId,
          orderStatusId: command.dto.orderStatusId,
          version: command.dto.version,
        },
      });
      if (idempotency.completedResponse) {
        return idempotency.completedResponse;
      }

      const order = await loadOrderForUpdate(tx, command.orderId);
      await this.assertOrderScope(command.currentUser, order, [
        'orders.update',
        'orders.change_status',
      ], requestId);
      const status = await loadOrderStatus(tx, command.dto.orderStatusId);
      assertVersion(order, command.dto.version);

      if (order.orderStatusId === command.dto.orderStatusId) {
        const response = {
          order: {
            orderId: order.orderId,
            orderStatusId: order.orderStatusId,
            version: order.version,
          },
          requestId,
        };
        await completeIdempotency(tx, command.dto.idempotencyKey, response);
        return response;
      }

      const nextVersion = await updateOrderStatus(tx, order.orderId, status.orderStatusId);
      const auditId = await writeAudit(tx, {
        event: 'orders.status_change',
        currentUser: command.currentUser,
        requestId,
        order,
        source: SOURCE,
        statusField: 'orderStatus',
        statusId: status.orderStatusId,
        statusName: status.orderStatusName,
        beforeJson: {
          orderStatusId: order.orderStatusId,
          version: order.version,
        },
        afterJson: {
          orderStatusId: status.orderStatusId,
          orderStatusName: status.orderStatusName,
          version: nextVersion,
        },
        diffJson: {
          orderStatusId: {
            before: order.orderStatusId,
            after: status.orderStatusId,
          },
        },
        metadataJson: {
          source: SOURCE,
          orderId: order.orderId,
          clientId: order.clientId,
          orderStatusId: status.orderStatusId,
          orderStatusName: status.orderStatusName,
          action: 'order_status_change',
          statusField: 'orderStatus',
          requestId,
        },
      });

      await enqueueOutbox(tx, {
        eventType: 'order.status_changed',
        aggregateType: 'order',
        aggregateId: String(order.orderId),
        idempotencyKey: command.dto.idempotencyKey,
        payload: {
          eventType: 'order.status_changed',
          actorUserId: command.currentUser.id,
          requestId,
          entityType: 'order',
          entityId: String(order.orderId),
          orderId: order.orderId,
          clientId: order.clientId,
          orderStatusId: status.orderStatusId,
          action: 'order_status_change',
          scope: { source: 'calendar|order-header' },
          idempotencyKey: command.dto.idempotencyKey,
        },
      });

      const response = {
        order: {
          orderId: order.orderId,
          orderStatusId: status.orderStatusId,
          version: nextVersion,
        },
        auditId,
        requestId,
      };
      await completeIdempotency(tx, command.dto.idempotencyKey, response);
      return response;
    });
  }

  changeOrderStatusFromDeadline(
    command: ChangeOrderStatusFromDeadlineCommand,
  ): Promise<ChangeOrderStatusFromDeadlineResult> {
    return this.database.transaction((tx) => changeOrderStatusFromDeadlineInTransaction(tx, command));
  }

  changePaymentStatus(command: ChangePaymentStatusCommand): Promise<ProductionActionResponseDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);

      const requestId = requestIdOrFallback(command.requestId);
      const idempotency = await reconcileIdempotency(tx, {
        idempotencyKey: command.dto.idempotencyKey,
        commandName: 'orders.payment_status_change',
        currentUser: command.currentUser,
        entityType: 'order',
        entityId: String(command.orderId),
        requestShape: {
          actorUserId: command.currentUser.id,
          commandName: 'orders.payment_status_change',
          orderId: command.orderId,
          paymentStatusId: command.dto.paymentStatusId,
          version: command.dto.version,
        },
      });
      if (idempotency.completedResponse) {
        return idempotency.completedResponse;
      }

      const order = await loadOrderForUpdate(tx, command.orderId);
      await this.assertOrderScope(command.currentUser, order, ['orders.update', 'payments.update'], requestId);
      const status = await loadPaymentStatus(tx, command.dto.paymentStatusId);
      assertVersion(order, command.dto.version);

      if (order.paymentStatusId === command.dto.paymentStatusId) {
        const response = {
          order: {
            orderId: order.orderId,
            paymentStatusId: order.paymentStatusId,
            version: order.version,
          },
          requestId,
        };
        await completeIdempotency(tx, command.dto.idempotencyKey, response);
        return response;
      }

      const nextVersion = await updatePaymentStatus(tx, order.orderId, status.paymentStatusId);
      const auditId = await writeAudit(tx, {
        event: 'orders.payment_status_change',
        currentUser: command.currentUser,
        requestId,
        order,
        source: SOURCE,
        statusField: 'paymentStatus',
        statusId: status.paymentStatusId,
        statusName: status.paymentStatusName,
        beforeJson: {
          paymentStatusId: order.paymentStatusId,
          version: order.version,
        },
        afterJson: {
          paymentStatusId: status.paymentStatusId,
          paymentStatusName: status.paymentStatusName,
          version: nextVersion,
        },
        diffJson: {
          paymentStatusId: {
            before: order.paymentStatusId,
            after: status.paymentStatusId,
          },
        },
        metadataJson: {
          source: SOURCE,
          orderId: order.orderId,
          clientId: order.clientId,
          paymentStatusId: status.paymentStatusId,
          paymentStatusName: status.paymentStatusName,
          action: 'payment_status_change',
          statusField: 'paymentStatus',
          requestId,
        },
      });

      await enqueueOutbox(tx, {
        eventType: 'order.payment_status_changed',
        aggregateType: 'order',
        aggregateId: String(order.orderId),
        idempotencyKey: command.dto.idempotencyKey,
        payload: {
          eventType: 'order.payment_status_changed',
          actorUserId: command.currentUser.id,
          requestId,
          entityType: 'order',
          entityId: String(order.orderId),
          orderId: order.orderId,
          clientId: order.clientId,
          paymentStatusId: status.paymentStatusId,
          action: 'payment_status_change',
          scope: { source: 'order-header' },
          idempotencyKey: command.dto.idempotencyKey,
        },
      });

      const response = {
        order: {
          orderId: order.orderId,
          paymentStatusId: status.paymentStatusId,
          version: nextVersion,
        },
        auditId,
        requestId,
      };
      await completeIdempotency(tx, command.dto.idempotencyKey, response);
      return response;
    });
  }

  changeProductionStatus(
    command: ChangeProductionStatusCommand,
  ): Promise<ProductionActionResponseDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);

      const requestId = requestIdOrFallback(command.requestId);
      const idempotency = await reconcileIdempotency(tx, {
        idempotencyKey: command.dto.idempotencyKey,
        commandName: 'orders.production_status_change',
        currentUser: command.currentUser,
        entityType: 'order',
        entityId: String(command.orderId),
        requestShape: {
          actorUserId: command.currentUser.id,
          commandName: 'orders.production_status_change',
          orderId: command.orderId,
          productionStatusId: command.dto.productionStatusId,
          version: command.dto.version,
        },
      });
      if (idempotency.completedResponse) {
        return idempotency.completedResponse;
      }

      const order = await loadOrderForUpdate(tx, command.orderId);
      await this.assertOrderScope(command.currentUser, order, [
        'orders.update',
        'orders.change_production_status',
      ], requestId);
      const status = await loadProductionStatus(tx, command.dto.productionStatusId);
      assertVersion(order, command.dto.version);

      if (
        order.productionStatusId === status.productionStatusId &&
        !order.productionStatusFromDetailsEnabled
      ) {
        const response = {
          order: {
            orderId: order.orderId,
            productionStatusId: order.productionStatusId ?? undefined,
            version: order.version,
          },
          requestId,
        };
        await completeIdempotency(tx, command.dto.idempotencyKey, response);
        return response;
      }

      const beforeDetails = await loadDetailProductionStatusSnapshot(tx, order.orderId);
      // Manual-mode detail sync is handled by the existing DB trigger on this order update;
      // the after snapshot captures the trigger result.
      const nextVersion = await updateProductionStatus(
        tx,
        order.orderId,
        status.productionStatusId,
      );
      const afterDetails = await loadDetailProductionStatusSnapshot(tx, order.orderId);
      const affectedDetailIds = beforeDetails.detailIds.filter((detailId) =>
        afterDetails.detailIds.includes(detailId),
      );
      const nextProductionStatusFromDetailsEnabled = false;

      const auditId = await writeAudit(tx, {
        event: 'orders.production_status_change',
        currentUser: command.currentUser,
        requestId,
        order,
        source: SOURCE,
        statusField: 'productionCurrentStatus',
        statusId: status.productionStatusId,
        statusName: status.productionStatusName,
        statusCode: status.productionStatusCode,
        beforeJson: {
          productionStatusId: order.productionStatusId,
          productionStatusFromDetailsEnabled: order.productionStatusFromDetailsEnabled,
          version: order.version,
          detailStatusDistribution: beforeDetails.statusDistribution,
        },
        afterJson: {
          productionStatusId: status.productionStatusId,
          productionStatusName: status.productionStatusName,
          productionStatusCode: status.productionStatusCode,
          productionStatusFromDetailsEnabled: nextProductionStatusFromDetailsEnabled,
          version: nextVersion,
          detailStatusDistribution: afterDetails.statusDistribution,
        },
        diffJson: {
          productionStatusId: {
            before: order.productionStatusId,
            after: status.productionStatusId,
          },
          productionStatusFromDetailsEnabled: {
            before: order.productionStatusFromDetailsEnabled,
            after: nextProductionStatusFromDetailsEnabled,
          },
          affectedDetailIds,
          affectedDetailCount: affectedDetailIds.length,
          beforeStatusDistribution: beforeDetails.statusDistribution,
          afterStatusDistribution: afterDetails.statusDistribution,
        },
        metadataJson: {
          source: SOURCE,
          orderId: order.orderId,
          clientId: order.clientId,
          productionStatusId: status.productionStatusId,
          productionStatusCode: status.productionStatusCode,
          productionStatusName: status.productionStatusName,
          productionStatusFromDetailsEnabled: nextProductionStatusFromDetailsEnabled,
          previousProductionStatusFromDetailsEnabled: order.productionStatusFromDetailsEnabled,
          affectedDetailIds,
          affectedDetailCount: affectedDetailIds.length,
          beforeStatusDistribution: beforeDetails.statusDistribution,
          afterStatusDistribution: afterDetails.statusDistribution,
          action: 'production_status_change',
          statusField: 'productionCurrentStatus',
          requestId,
        },
      });

      await enqueueOutbox(tx, {
        eventType: 'order.production_status_changed',
        aggregateType: 'order',
        aggregateId: String(order.orderId),
        idempotencyKey: command.dto.idempotencyKey,
        payload: {
          eventType: 'order.production_status_changed',
          actorUserId: command.currentUser.id,
          requestId,
          entityType: 'order',
          entityId: String(order.orderId),
          orderId: order.orderId,
          clientId: order.clientId,
          productionStatusId: status.productionStatusId,
          productionStatusCode: status.productionStatusCode,
          productionStatusFromDetailsEnabled: nextProductionStatusFromDetailsEnabled,
          affectedDetailIds,
          affectedDetailCount: affectedDetailIds.length,
          action: 'production_status_change',
          scope: { source: 'order-header' },
          idempotencyKey: command.dto.idempotencyKey,
        },
      });

      const response = {
        order: {
          orderId: order.orderId,
          productionStatusId: status.productionStatusId,
          version: nextVersion,
        },
        auditId,
        requestId,
      };
      await completeIdempotency(tx, command.dto.idempotencyKey, response);
      return response;
    });
  }

  activateProductionStage(
    command: ActivateProductionStageCommand,
  ): Promise<ProductionActionResponseDto> {
    return this.setProductionStageState(command, true);
  }

  deactivateProductionStage(
    command: DeactivateProductionStageCommand,
  ): Promise<ProductionActionResponseDto> {
    return this.setProductionStageState(command, false);
  }

  activateDetailProductionStage(
    command: ActivateDetailProductionStageCommand,
  ): Promise<ProductionActionResponseDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);

      const requestId = requestIdOrFallback(command.requestId);
      const idempotency = await reconcileIdempotency(tx, {
        idempotencyKey: command.dto.idempotencyKey,
        commandName: 'production.detail_stage_activate',
        currentUser: command.currentUser,
        entityType: 'order_detail',
        entityId: String(command.detailId),
        requestShape: {
          actorUserId: command.currentUser.id,
          commandName: 'production.detail_stage_activate',
          detailId: command.detailId,
          productionStatusId: command.productionStatusId,
          note: command.dto.note ?? null,
        },
      });
      if (idempotency.completedResponse) {
        return idempotency.completedResponse;
      }

      const detail = await loadOrderDetailForUpdate(tx, command.detailId);
      await this.assertOrderScope(command.currentUser, detail.order, [
        'orders.update',
        'orders.change_production_status',
      ], requestId);
      const productionStatus = await loadProductionStatus(tx, command.productionStatusId);

      const existingEventId = await findDetailProductionEventId(
        tx,
        detail.detailId,
        productionStatus.productionStatusId,
      );
      if (existingEventId !== null) {
        const response = {
          order: {
            orderId: detail.order.orderId,
            version: detail.order.version,
          },
          event: {
            productionEventId: existingEventId,
            productionStatusId: productionStatus.productionStatusId,
            active: true,
          },
          requestId,
        };
        await completeIdempotency(tx, command.dto.idempotencyKey, response);
        return response;
      }

      const productionEventId = await insertDetailProductionEvent(tx, {
        detailId: detail.detailId,
        productionStatusId: productionStatus.productionStatusId,
        note: command.dto.note ?? null,
        currentUser: command.currentUser,
        requestId,
      });
      const auditId = await writeAudit(tx, {
        event: 'production.detail_stage_activate',
        currentUser: command.currentUser,
        requestId,
        order: detail.order,
        entityType: 'order_detail',
        entityId: String(detail.detailId),
        source: SOURCE,
        relatedProductionEventId: productionEventId,
        stageCode: productionStatus.productionStatusCode,
        statusField: 'productionDetailStage',
        statusId: productionStatus.productionStatusId,
        statusName: productionStatus.productionStatusName,
        statusCode: productionStatus.productionStatusCode,
        beforeJson: {
          active: false,
        },
        afterJson: {
          active: true,
          detailId: detail.detailId,
          productionEventId,
          productionStatusId: productionStatus.productionStatusId,
          productionStatusCode: productionStatus.productionStatusCode,
        },
        diffJson: {
          active: {
            before: false,
            after: true,
          },
        },
        metadataJson: {
          source: SOURCE,
          orderId: detail.order.orderId,
          clientId: detail.order.clientId,
          detailId: detail.detailId,
          productionEventId,
          productionStatusId: productionStatus.productionStatusId,
          productionStatusCode: productionStatus.productionStatusCode,
          productionStatusName: productionStatus.productionStatusName,
          action: 'activate',
          statusField: 'productionDetailStage',
          requestId,
        },
      });

      await enqueueOutbox(tx, {
        eventType: 'production.detail_stage_activated',
        aggregateType: 'order_detail',
        aggregateId: String(detail.detailId),
        idempotencyKey: command.dto.idempotencyKey,
        payload: {
          eventType: 'production.detail_stage_activated',
          actorUserId: command.currentUser.id,
          requestId,
          entityType: 'order_detail',
          entityId: String(detail.detailId),
          orderId: detail.order.orderId,
          clientId: detail.order.clientId,
          detailId: detail.detailId,
          productionEventId,
          productionStatusId: productionStatus.productionStatusId,
          productionStatusCode: productionStatus.productionStatusCode,
          action: 'activate',
          scope: { source: 'order-detail' },
          idempotencyKey: command.dto.idempotencyKey,
        },
      });

      const response = {
        order: {
          orderId: detail.order.orderId,
          version: detail.order.version,
        },
        event: {
          productionEventId,
          productionStatusId: productionStatus.productionStatusId,
          active: true,
        },
        auditId,
        requestId,
      };
      await completeIdempotency(tx, command.dto.idempotencyKey, response);
      return response;
    });
  }

  private setProductionStageState(
    command: ActivateProductionStageCommand | DeactivateProductionStageCommand,
    active: boolean,
  ): Promise<ProductionActionResponseDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);

      const requestId = requestIdOrFallback(command.requestId);
      const commandName: CommandName = active
        ? 'production.stage_activate'
        : 'production.stage_deactivate';
      const idempotency = await reconcileIdempotency(tx, {
        idempotencyKey: command.dto.idempotencyKey,
        commandName,
        currentUser: command.currentUser,
        entityType: 'order',
        entityId: String(command.orderId),
        requestShape: {
          actorUserId: command.currentUser.id,
          commandName,
          orderId: command.orderId,
          productionStatusId: command.productionStatusId,
          version: command.dto.version,
          active,
        },
      });
      if (idempotency.completedResponse) {
        return idempotency.completedResponse;
      }

      const order = await loadOrderForUpdate(tx, command.orderId);
      await this.assertOrderScope(command.currentUser, order, [
        'orders.update',
        'orders.change_production_status',
      ], requestId);
      const productionStatus = await loadProductionStatus(tx, command.productionStatusId);
      assertVersion(order, command.dto.version);

      const existingEventId = await findProductionEventId(
        tx,
        order.orderId,
        productionStatus.productionStatusId,
      );
      if ((active && existingEventId !== null) || (!active && existingEventId === null)) {
        const response = {
          order: {
            orderId: order.orderId,
            version: order.version,
          },
          event: {
            ...(existingEventId === null ? {} : { productionEventId: existingEventId }),
            productionStatusId: productionStatus.productionStatusId,
            active,
          },
          requestId,
        };
        await completeIdempotency(tx, command.dto.idempotencyKey, response);
        return response;
      }

      const productionEventId = active
        ? await insertProductionEvent(tx, {
            orderId: order.orderId,
            productionStatusId: productionStatus.productionStatusId,
            currentUser: command.currentUser,
            requestId,
          })
        : existingEventId;

      if (!active && existingEventId !== null) {
        await deleteProductionEvent(tx, existingEventId);
      }

      const nextVersion = await incrementOrderVersion(tx, order.orderId);
      const auditId = await writeAudit(tx, {
        event: active ? 'production.stage_activate' : 'production.stage_deactivate',
        currentUser: command.currentUser,
        requestId,
        order,
        source: SOURCE,
        relatedProductionEventId: productionEventId,
        stageCode: productionStatus.productionStatusCode,
        statusField: 'productionStage',
        statusId: productionStatus.productionStatusId,
        statusName: productionStatus.productionStatusName,
        statusCode: productionStatus.productionStatusCode,
        beforeJson: {
          active: !active,
          version: order.version,
        },
        afterJson: {
          active,
          productionEventId,
          productionStatusId: productionStatus.productionStatusId,
          productionStatusCode: productionStatus.productionStatusCode,
          version: nextVersion,
        },
        diffJson: {
          active: {
            before: !active,
            after: active,
          },
        },
        metadataJson: {
          source: SOURCE,
          orderId: order.orderId,
          clientId: order.clientId,
          productionEventId,
          productionStatusId: productionStatus.productionStatusId,
          productionStatusCode: productionStatus.productionStatusCode,
          action: active ? 'activate' : 'deactivate',
          statusField: 'productionStage',
          requestId,
        },
      });

      await enqueueOutbox(tx, {
        eventType: active ? 'production.stage_activated' : 'production.stage_deactivated',
        aggregateType: 'order',
        aggregateId: String(order.orderId),
        idempotencyKey: command.dto.idempotencyKey,
        payload: {
          eventType: active ? 'production.stage_activated' : 'production.stage_deactivated',
          actorUserId: command.currentUser.id,
          requestId,
          entityType: 'order',
          entityId: String(order.orderId),
          orderId: order.orderId,
          clientId: order.clientId,
          productionEventId,
          productionStatusId: productionStatus.productionStatusId,
          productionStatusCode: productionStatus.productionStatusCode,
          action: active ? 'activate' : 'deactivate',
          scope: { source: 'calendar|order-header' },
          idempotencyKey: command.dto.idempotencyKey,
        },
      });

      const response = {
        order: {
          orderId: order.orderId,
          version: nextVersion,
        },
        event: {
          ...(productionEventId === null ? {} : { productionEventId }),
          productionStatusId: productionStatus.productionStatusId,
          active,
        },
        auditId,
        requestId,
      };
      await completeIdempotency(tx, command.dto.idempotencyKey, response);
      return response;
    });
  }

  private async assertOrderScope(
    currentUser: CurrentUser,
    order: LockedOrder,
    requiredPermissions: readonly string[],
    requestId: string,
  ): Promise<void> {
    const allowed = this.orderAccessPolicy.canUpdate(currentUser, {
      orderId: order.orderId,
      createdByUserId: order.createdByUserId,
      managerUserId: order.managerUserId,
    });

    if (!allowed) {
      await writeDeniedActionAudit(this.database, {
        currentUser,
        requestId,
        order,
        requiredPermissions,
      });
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions,
      });
    }
  }
}

async function writeDeniedActionAudit(
  database: DatabaseService,
  input: {
    currentUser: CurrentUser;
    requestId: string;
    order: LockedOrder;
    requiredPermissions: readonly string[];
  },
): Promise<void> {
  await database.query(
    `
    INSERT INTO audit_log (
      event, entity_type, entity_id, user_id, request_id, source,
      related_order_id, related_client_id, related_production_event_id,
      status_field, status_id, status_name, status_code, stage_code,
      before_json, after_json, diff_json, metadata_json
    )
    VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9,
      $10, $11, $12, $13, $14,
      $15::jsonb, $16::jsonb, $17::jsonb, $18::jsonb
    )
    `,
    [
      'production.action_denied',
      'order',
      String(input.order.orderId),
      input.currentUser.id,
      input.requestId,
      SOURCE,
      input.order.orderId,
      input.order.clientId,
      null,
      null,
      null,
      null,
      null,
      null,
      JSON.stringify({}),
      JSON.stringify({}),
      JSON.stringify({}),
      JSON.stringify({
        source: SOURCE,
        denied: true,
        reason: 'order_scope_denied',
        requiredPermissions: input.requiredPermissions,
      }),
    ],
  );
}

export async function changeOrderStatusFromDeadlineInTransaction(
  tx: TransactionClient,
  command: ChangeOrderStatusFromDeadlineCommand,
): Promise<ChangeOrderStatusFromDeadlineResult> {
  const requestId = requestIdOrFallback(command.requestId);
  const ruleConfigSnapshot = command.ruleConfigSnapshot as { snapshotHash?: unknown };
  const snapshotHash =
    typeof ruleConfigSnapshot.snapshotHash === 'string' ? ruleConfigSnapshot.snapshotHash : null;
  const idempotency = await reconcileIdempotency(tx, {
    idempotencyKey: command.idempotencyKey,
    commandName: 'orders.status_change',
    actorUserId: null,
    entityType: 'order',
    entityId: String(command.orderId),
    requestShape: {
      actorUserId: null,
      actorLabel: command.systemActor.actorLabel,
      commandName: 'orders.status_change',
      source: command.source,
      orderId: command.orderId,
      orderStatusId: command.targetOrderStatusId,
      deadlineId: command.deadlineId,
      deadlineEventId: command.deadlineEventId,
      actionRuleId: command.actionRuleId,
      ruleVersionId: command.ruleVersionId ?? null,
      snapshotHash,
    },
  });
  if (idempotency.completedResponse) {
    return mapDeadlineStoredResponse(idempotency.completedResponse);
  }

  const order = await loadOrderForUpdate(tx, command.orderId);
  const status = await loadOrderStatus(tx, command.targetOrderStatusId);

  const deadlineMetadata = {
    source: command.source,
    systemActor: command.systemActor,
    orderId: order.orderId,
    clientId: order.clientId,
    deadlineId: command.deadlineId,
    deadlineEventId: command.deadlineEventId,
    actionRuleId: command.actionRuleId,
    ruleVersionId: command.ruleVersionId ?? null,
    snapshotHash,
    ruleConfigSnapshot: command.ruleConfigSnapshot,
    idempotencyKey: command.idempotencyKey,
    requestId,
    occurredAt: command.occurredAt,
  };

  if (order.orderStatusId === status.orderStatusId) {
    const response = {
      order: {
        orderId: order.orderId,
        orderStatusId: order.orderStatusId,
        version: order.version,
      },
      requestId,
    };
    await completeDeadlineIdempotency(tx, command.idempotencyKey, {
      status: 'skipped',
      skipReason: 'same_status',
      response,
    });
    return { status: 'skipped', skipReason: 'same_status', response };
  }

  const nextVersion = await updateOrderStatus(tx, order.orderId, status.orderStatusId);
  const auditId = await writeAudit(tx, {
    event: 'orders.status_change',
    actorUserId: null,
    requestId,
    order,
    source: command.source,
    statusField: 'orderStatus',
    statusId: status.orderStatusId,
    statusName: status.orderStatusName,
    beforeJson: {
      orderStatusId: order.orderStatusId,
      version: order.version,
      deadlineId: command.deadlineId,
      deadlineEventId: command.deadlineEventId,
      actionRuleId: command.actionRuleId,
      snapshotHash,
    },
    afterJson: {
      orderStatusId: status.orderStatusId,
      orderStatusName: status.orderStatusName,
      version: nextVersion,
      deadlineId: command.deadlineId,
      deadlineEventId: command.deadlineEventId,
      actionRuleId: command.actionRuleId,
      snapshotHash,
    },
    diffJson: {
      orderStatusId: {
        before: order.orderStatusId,
        after: status.orderStatusId,
      },
    },
    metadataJson: {
      ...deadlineMetadata,
      orderStatusId: status.orderStatusId,
      orderStatusName: status.orderStatusName,
      previousOrderStatusId: order.orderStatusId,
      action: 'order_status_change',
      statusField: 'orderStatus',
    },
  });

  await enqueueOutbox(tx, {
    eventType: 'order.status_changed',
    aggregateType: 'order',
    aggregateId: String(order.orderId),
    idempotencyKey: command.idempotencyKey,
    payload: {
      ...deadlineMetadata,
      eventType: 'order.status_changed',
      actorUserId: null,
      entityType: 'order',
      entityId: String(order.orderId),
      orderStatusId: status.orderStatusId,
      previousOrderStatusId: order.orderStatusId,
      action: 'order_status_change',
      scope: { source: command.source },
    },
  });

  const response = {
    order: {
      orderId: order.orderId,
      orderStatusId: status.orderStatusId,
      version: nextVersion,
    },
    auditId,
    requestId,
  };
  await completeDeadlineIdempotency(tx, command.idempotencyKey, {
    status: 'executed',
    response,
  });
  return { status: 'executed', response };
}

async function setSessionUser(tx: TransactionClient, userId: string): Promise<void> {
  await tx.query('SELECT set_session_user($1)', [userId]);
}

async function reconcileIdempotency(
  tx: TransactionClient,
  input: {
    idempotencyKey: string;
    commandName: CommandName;
    currentUser?: CurrentUser;
    actorUserId?: number | null;
    entityType: string;
    entityId: string;
    requestShape: Record<string, unknown>;
  },
): Promise<{ completedResponse?: ProductionActionResponseDto }> {
  const requestHash = hashRequest(input.requestShape);
  const inserted = await tx.query<IdempotencyRow>(
    `
    INSERT INTO command_idempotency_keys (
      idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status
    )
    VALUES ($1, $2, $3, $4, $5, $6, 'processing')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING idempotency_key, request_hash, response_json, status
    `,
    [
      input.idempotencyKey,
      input.commandName,
      input.actorUserId ?? (input.currentUser ? Number(input.currentUser.id) : null),
      input.entityType,
      input.entityId,
      requestHash,
    ],
  );

  if (inserted.rows[0]) {
    return {};
  }

  const existing = await tx.query<IdempotencyRow>(
    `
    SELECT idempotency_key, request_hash, response_json, status
    FROM command_idempotency_keys
    WHERE idempotency_key = $1
    FOR UPDATE
    `,
    [input.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) {
    throw new ProductionActionIdempotencyInProgressError(input.idempotencyKey);
  }
  if (row.request_hash !== requestHash) {
    throw new ProductionActionIdempotencyKeyReusedError(input.idempotencyKey);
  }
  if (row.status === 'completed' && row.response_json) {
    return { completedResponse: parseStoredResponse(row.response_json) };
  }
  if (row.status === 'failed') {
    throw new ProductionActionIdempotencyFailedError(input.idempotencyKey);
  }

  throw new ProductionActionIdempotencyInProgressError(input.idempotencyKey);
}

async function completeIdempotency(
  tx: TransactionClient,
  idempotencyKey: string,
  response: ProductionActionResponseDto,
): Promise<void> {
  await tx.query(
    `
    UPDATE command_idempotency_keys
    SET status = 'completed',
        response_json = $2::jsonb,
        completed_at = now()
    WHERE idempotency_key = $1
    `,
    [idempotencyKey, JSON.stringify(response)],
  );
}

async function completeDeadlineIdempotency(
  tx: TransactionClient,
  idempotencyKey: string,
  result: ChangeOrderStatusFromDeadlineResult,
): Promise<void> {
  await completeIdempotency(tx, idempotencyKey, {
    ...result.response,
    deadlineActionStatus: result.status,
    deadlineSkipReason: result.skipReason ?? null,
  } as ProductionActionResponseDto);
}

function mapDeadlineStoredResponse(
  response: ProductionActionResponseDto,
): ChangeOrderStatusFromDeadlineResult {
  const stored = response as ProductionActionResponseDto & {
    deadlineActionStatus?: unknown;
    deadlineSkipReason?: unknown;
  };
  const {
    deadlineActionStatus: _deadlineActionStatus,
    deadlineSkipReason: _deadlineSkipReason,
    ...productionResponse
  } = stored;

  if (stored.deadlineActionStatus === 'skipped') {
    return {
      status: 'skipped',
      skipReason:
        typeof stored.deadlineSkipReason === 'string' ? stored.deadlineSkipReason : 'same_status',
      response: productionResponse,
    };
  }

  return {
    status: 'executed',
    response: productionResponse,
  };
}

async function loadOrderForUpdate(tx: TransactionClient, orderId: number): Promise<LockedOrder> {
  const result = await tx.query<LockedOrderRow>(
    `
    SELECT
      order_id, client_id, order_date, planned_completion_date, order_status_id, payment_status_id,
      production_status_id, production_status_from_details_enabled, version, created_by, manager_id
    FROM orders
    WHERE order_id = $1 AND delete_flag = false
    FOR UPDATE
    `,
    [orderId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ProductionActionOrderNotFoundError(orderId);
  }

  return {
    orderId: toNumber(row.order_id),
    clientId: toNullableNumber(row.client_id),
    orderDate: toDateOnly(row.order_date) ?? '',
    plannedCompletionDate: toDateOnly(row.planned_completion_date),
    orderStatusId: toNumber(row.order_status_id),
    paymentStatusId: toNumber(row.payment_status_id),
    productionStatusId: toNullableNumber(row.production_status_id),
    productionStatusFromDetailsEnabled: toBoolean(row.production_status_from_details_enabled, true),
    version: toNumber(row.version),
    createdByUserId: toNullableString(row.created_by),
    managerUserId: toNullableString(row.manager_id),
  };
}

async function loadOrderDetailForUpdate(
  tx: TransactionClient,
  detailId: number,
): Promise<LockedOrderDetail> {
  const result = await tx.query<LockedOrderDetailRow>(
    `
    SELECT
      od.detail_id,
      o.order_id,
      o.client_id,
      o.production_status_id,
      o.production_status_from_details_enabled,
      o.version,
      o.created_by,
      o.manager_id
    FROM order_details od
    JOIN orders o ON o.order_id = od.order_id
    WHERE od.detail_id = $1 AND COALESCE(od.delete_flag, false) = false AND o.delete_flag = false
    FOR UPDATE
    `,
    [detailId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ProductionActionOrderDetailNotFoundError(detailId);
  }

  return {
    detailId: toNumber(row.detail_id),
    order: {
      orderId: toNumber(row.order_id),
      clientId: toNullableNumber(row.client_id),
      orderDate: '',
      plannedCompletionDate: null,
      orderStatusId: 0,
      paymentStatusId: 0,
      productionStatusId: toNullableNumber(row.production_status_id),
      productionStatusFromDetailsEnabled: toBoolean(row.production_status_from_details_enabled, true),
      version: toNumber(row.version),
      createdByUserId: toNullableString(row.created_by),
      managerUserId: toNullableString(row.manager_id),
    },
  };
}

async function loadOrderStatus(
  tx: TransactionClient,
  orderStatusId: number,
): Promise<{ orderStatusId: number; orderStatusName: string }> {
  const result = await tx.query<OrderStatusRow>(
    `
    SELECT order_status_id, order_status_name
    FROM order_statuses
    WHERE order_status_id = $1 AND is_active = true
    LIMIT 1
    `,
    [orderStatusId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ProductionActionStatusNotFoundError('order_status', orderStatusId);
  }

  return {
    orderStatusId: toNumber(row.order_status_id),
    orderStatusName: row.order_status_name,
  };
}

async function loadPaymentStatus(
  tx: TransactionClient,
  paymentStatusId: number,
): Promise<{ paymentStatusId: number; paymentStatusName: string }> {
  const result = await tx.query<PaymentStatusRow>(
    `
    SELECT payment_status_id, payment_status_name
    FROM payment_statuses
    WHERE payment_status_id = $1 AND is_active = true
    LIMIT 1
    `,
    [paymentStatusId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ProductionActionStatusNotFoundError('payment_status', paymentStatusId);
  }

  return {
    paymentStatusId: toNumber(row.payment_status_id),
    paymentStatusName: row.payment_status_name,
  };
}

async function loadProductionStatus(
  tx: TransactionClient,
  productionStatusId: number,
): Promise<{
  productionStatusId: number;
  productionStatusName: string;
  productionStatusCode: string;
}> {
  const result = await tx.query<ProductionStatusRow>(
    `
    SELECT production_status_id, production_status_name, production_status_code
    FROM production_statuses
    WHERE production_status_id = $1 AND is_active = true
    LIMIT 1
    `,
    [productionStatusId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ProductionActionStatusNotFoundError('production_status', productionStatusId);
  }

  return {
    productionStatusId: toNumber(row.production_status_id),
    productionStatusName: row.production_status_name,
    productionStatusCode: row.production_status_code,
  };
}

function assertVersion(order: LockedOrder, expectedVersion: number): void {
  if (order.version !== expectedVersion) {
    throw new ProductionActionVersionConflictError(
      order.orderId,
      expectedVersion,
      order.version,
    );
  }
}

function assertPlannedDateAllowed(order: LockedOrder, plannedCompletionDate: string | null): void {
  if (plannedCompletionDate && order.orderDate && plannedCompletionDate < order.orderDate) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Calendar date is before order date', {
      errors: [
        {
          field: 'plannedCompletionDate',
          message: 'plannedCompletionDate cannot be before orderDate',
        },
      ],
      orderDate: order.orderDate,
      plannedCompletionDate,
    });
  }
}

async function updateCalendarDate(
  tx: TransactionClient,
  orderId: number,
  plannedCompletionDate: string | null,
): Promise<number> {
  const result = await tx.query<VersionRow>(
    `
    UPDATE orders
    SET planned_completion_date = $2,
        version = version + 1
    WHERE order_id = $1
    RETURNING version
    `,
    [orderId, plannedCompletionDate],
  );

  return toNumber(result.rows[0].version);
}

async function updateOrderStatus(
  tx: TransactionClient,
  orderId: number,
  orderStatusId: number,
): Promise<number> {
  const result = await tx.query<VersionRow>(
    `
    UPDATE orders
    SET order_status_id = $2,
        version = version + 1
    WHERE order_id = $1
    RETURNING version
    `,
    [orderId, orderStatusId],
  );

  return toNumber(result.rows[0].version);
}

async function updatePaymentStatus(
  tx: TransactionClient,
  orderId: number,
  paymentStatusId: number,
): Promise<number> {
  const result = await tx.query<VersionRow>(
    `
    UPDATE orders
    SET payment_status_id = $2,
        version = version + 1
    WHERE order_id = $1
    RETURNING version
    `,
    [orderId, paymentStatusId],
  );

  return toNumber(result.rows[0].version);
}

async function loadDetailProductionStatusSnapshot(
  tx: TransactionClient,
  orderId: number,
): Promise<DetailProductionStatusSnapshot> {
  const result = await tx.query<DetailProductionStatusRow>(
    `
    SELECT detail_id, production_status_id
    FROM order_details
    WHERE order_id = $1 AND COALESCE(delete_flag, false) = false
    ORDER BY detail_id
    FOR UPDATE
    `,
    [orderId],
  );

  const detailIds: number[] = [];
  const statusDistribution: Record<string, number> = {};
  for (const row of result.rows) {
    detailIds.push(toNumber(row.detail_id));
    const key = row.production_status_id === null ? 'null' : String(row.production_status_id);
    statusDistribution[key] = (statusDistribution[key] ?? 0) + 1;
  }

  return { detailIds, statusDistribution };
}

async function updateProductionStatus(
  tx: TransactionClient,
  orderId: number,
  productionStatusId: number,
): Promise<number> {
  const result = await tx.query<VersionRow>(
    `
    UPDATE orders
    SET production_status_id = $2,
        production_status_from_details_enabled = false,
        version = version + 1
    WHERE order_id = $1
    RETURNING version
    `,
    [orderId, productionStatusId],
  );

  return toNumber(result.rows[0].version);
}

async function incrementOrderVersion(tx: TransactionClient, orderId: number): Promise<number> {
  const result = await tx.query<VersionRow>(
    `
    UPDATE orders
    SET version = version + 1
    WHERE order_id = $1
    RETURNING version
    `,
    [orderId],
  );

  return toNumber(result.rows[0].version);
}

async function findProductionEventId(
  tx: TransactionClient,
  orderId: number,
  productionStatusId: number,
): Promise<number | null> {
  const result = await tx.query<ProductionEventRow>(
    `
    SELECT event_id
    FROM production_status_events
    WHERE order_id = $1 AND production_status_id = $2
    FOR UPDATE
    `,
    [orderId, productionStatusId],
  );

  return result.rows[0] ? toNumber(result.rows[0].event_id) : null;
}

async function findDetailProductionEventId(
  tx: TransactionClient,
  detailId: number,
  productionStatusId: number,
): Promise<number | null> {
  const result = await tx.query<ProductionEventRow>(
    `
    SELECT event_id
    FROM production_status_events
    WHERE detail_id = $1 AND production_status_id = $2
    FOR UPDATE
    `,
    [detailId, productionStatusId],
  );

  return result.rows[0] ? toNumber(result.rows[0].event_id) : null;
}

async function insertProductionEvent(
  tx: TransactionClient,
  input: {
    orderId: number;
    productionStatusId: number;
    currentUser: CurrentUser;
    requestId: string;
  },
): Promise<number> {
  const result = await tx.query<ProductionEventRow>(
    `
    INSERT INTO production_status_events (
      order_id, detail_id, production_status_id, event_by, note, payload
    )
    VALUES ($1, NULL, $2, $3, NULL, $4::jsonb)
    ON CONFLICT (order_id, production_status_id) WHERE order_id IS NOT NULL
    DO UPDATE SET payload = production_status_events.payload
    RETURNING event_id
    `,
    [
      input.orderId,
      input.productionStatusId,
      Number(input.currentUser.id),
      JSON.stringify({
        source: SOURCE,
        requestId: input.requestId,
      }),
    ],
  );

  return toNumber(result.rows[0].event_id);
}

async function insertDetailProductionEvent(
  tx: TransactionClient,
  input: {
    detailId: number;
    productionStatusId: number;
    note: string | null;
    currentUser: CurrentUser;
    requestId: string;
  },
): Promise<number> {
  const result = await tx.query<ProductionEventRow>(
    `
    INSERT INTO production_status_events (
      order_id, detail_id, production_status_id, event_by, note, payload
    )
    VALUES (NULL, $1, $2, $3, $4, $5::jsonb)
    ON CONFLICT (detail_id, production_status_id) WHERE detail_id IS NOT NULL
    DO UPDATE SET payload = production_status_events.payload
    RETURNING event_id
    `,
    [
      input.detailId,
      input.productionStatusId,
      Number(input.currentUser.id),
      input.note,
      JSON.stringify({
        source: SOURCE,
        requestId: input.requestId,
      }),
    ],
  );

  return toNumber(result.rows[0].event_id);
}

async function deleteProductionEvent(tx: TransactionClient, eventId: number): Promise<void> {
  await tx.query('DELETE FROM production_status_events WHERE event_id = $1', [eventId]);
}

async function writeAudit(
  tx: TransactionClient,
  input: {
    event: CommandName;
    currentUser?: CurrentUser;
    actorUserId?: string | number | null;
    requestId: string;
    order: LockedOrder;
    entityType?: string;
    entityId?: string;
    source: string;
    relatedProductionEventId?: number | null;
    statusField?: string;
    statusId?: number;
    statusName?: string;
    statusCode?: string;
    stageCode?: string;
    beforeJson: Record<string, unknown>;
    afterJson: Record<string, unknown>;
    diffJson: Record<string, unknown>;
    metadataJson: Record<string, unknown>;
  },
): Promise<string> {
  const result = await tx.query<AuditRow>(
    `
    INSERT INTO audit_log (
      event, entity_type, entity_id, user_id, request_id, source,
      related_order_id, related_client_id, related_production_event_id,
      status_field, status_id, status_name, status_code, stage_code,
      before_json, after_json, diff_json, metadata_json
    )
    VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9,
      $10, $11, $12, $13, $14,
      $15::jsonb, $16::jsonb, $17::jsonb, $18::jsonb
    )
    RETURNING audit_id
    `,
    [
      input.event,
      input.entityType ?? 'order',
      input.entityId ?? String(input.order.orderId),
      input.actorUserId ?? input.currentUser?.id ?? null,
      input.requestId,
      input.source,
      input.order.orderId,
      input.order.clientId,
      input.relatedProductionEventId ?? null,
      input.statusField ?? null,
      input.statusId ?? null,
      input.statusName ?? null,
      input.statusCode ?? null,
      input.stageCode ?? null,
      JSON.stringify(input.beforeJson),
      JSON.stringify(input.afterJson),
      JSON.stringify(input.diffJson),
      JSON.stringify(input.metadataJson),
    ],
  );

  return result.rows[0].audit_id;
}

async function enqueueOutbox(
  tx: TransactionClient,
  input: {
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `
    INSERT INTO outbox_events (
      event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
    )
    VALUES ($1, $2, $3, $4::jsonb, $5)
    ON CONFLICT (idempotency_key) DO NOTHING
    `,
    [
      input.eventType,
      input.aggregateType,
      input.aggregateId,
      JSON.stringify(input.payload),
      input.idempotencyKey,
    ],
  );
}

function requestIdOrFallback(requestId: string | undefined): string {
  return requestId || 'production-action-command';
}

function hashRequest(value: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`;
}

function parseStoredResponse(
  responseJson: ProductionActionResponseDto | string,
): ProductionActionResponseDto {
  return typeof responseJson === 'string'
    ? (JSON.parse(responseJson) as ProductionActionResponseDto)
    : responseJson;
}

function toNumber(value: string | number): number {
  return Number(value);
}

function toNullableNumber(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function toBoolean(value: boolean | string | number | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return value === 'true' || value === 't' || value === '1';
}

function toNullableString(value: string | number | null): string | null {
  return value === null ? null : String(value);
}

function toDateOnly(value: string | Date | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
