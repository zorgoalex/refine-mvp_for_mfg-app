import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole, type PermissionName } from '../../../permissions/permissions';
import type { MdfBoardColumnAutomationInput } from '../../status-automation/application/status-automation-runtime';
import type { StatusAutomationEvent } from '../../status-automation/application/status-automation.types';
import { OrderAccessPolicy } from '../../../permissions/policies/order-access.policy';
import { rolePolicyForUser } from '../../../permissions/policies/scope';
import type {
  ActivateProductionStageCommand,
  ActivateDetailProductionStageCommand,
  ChangeBatchDetailProductionStatusCommand,
  ChangeOrderStatusCommand,
  ChangeOrderStatusFromDeadlineCommand,
  ChangeOrderStatusFromDeadlineResult,
  ChangePaymentStatusCommand,
  ChangeProductionStatusCommand,
  ChangeProductionStatusFromDeadlineCommand,
  ChangeProductionStatusFromDeadlineResult,
  DeactivateProductionStageCommand,
  EnterManualProductionStatusCommand,
  MoveCalendarDateCommand,
  ProductionActionRepositoryPort,
  RestoreAutoProductionStatusCommand,
} from '../application/production-action.types';
import type {
  BatchDetailProductionStatusResponseDto,
  ProductionActionResponseDto,
} from '../dto/production-action.dto';
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
const AUTOMATION_SOURCE = 'backend-status-automation';
const PACKER_ALLOWED_ORDER_STATUS_NAMES = new Set(['готов к выдаче', 'выдан']);

export interface AutomationActionContext {
  actor: CurrentUser;
  requestId: string;
  ruleId: number;
  ruleName: string;
  eventType: string;
  outboxIdempotencyKey: string;
}

export interface AutomationActionResult {
  status: 'executed' | 'skipped';
  skipReason?: string;
  // audit_log id — UUID string (auditService.record); Number() на нём даёт NaN.
  auditId?: string;
}

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

interface MdfLaminatedBathAutomationRow extends QueryResultRow {
  cut_result_id: string | number;
  order_id: string | number;
}

interface ProductionStatusCascadeResult {
  beforeDetails: DetailProductionStatusSnapshot;
  afterDetails: DetailProductionStatusSnapshot;
  affectedDetailIds: number[];
  nextProductionStatusId: number | null;
  nextProductionStatusFromDetailsEnabled: true;
  nextVersion: number;
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
  | 'orders.production_status_mode_restore'
  | 'orders.production_status_mode_manual'
  | 'production.stage_activate'
  | 'production.stage_deactivate'
  | 'production.detail_stage_activate'
  | 'orders.detail_production_status_batch_change';

interface OrderScopeOptions {
  tx?: TransactionClient;
  allowAssignedProductionWorker?: boolean;
}

interface OrderAccessDecision {
  accessVia: 'owner' | 'assigned_production_worker';
  assignmentSource: 'order_workshops.responsible_employee_id' | null;
}

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
        idempotencyKey: `${command.dto.idempotencyKey}:order.calendar_moved`,
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
          outboxIdempotencyKey: `${command.dto.idempotencyKey}:order.calendar_moved`,
        },
      });
      const plannedDateOutboxIdempotencyKey =
        `${command.dto.idempotencyKey}:order.planned_completion_date_changed`;
      await enqueueOutbox(tx, {
        eventType: 'order.planned_completion_date_changed',
        aggregateType: 'order',
        aggregateId: String(order.orderId),
        idempotencyKey: plannedDateOutboxIdempotencyKey,
        payload: {
          eventType: 'order.planned_completion_date_changed',
          actorUserId: command.currentUser.id,
          requestId,
          entityType: 'order',
          entityId: String(order.orderId),
          orderId: order.orderId,
          clientId: order.clientId,
          action: 'planned_completion_date_change',
          scope: { source: 'calendar' },
          idempotencyKey: command.dto.idempotencyKey,
          outboxIdempotencyKey: plannedDateOutboxIdempotencyKey,
          plannedCompletionDateBefore: order.plannedCompletionDate,
          plannedCompletionDateAfter: command.dto.plannedCompletionDate,
          previousVersion: order.version,
          version: nextVersion,
        },
      });
      await evaluateStatusAutomationInTransaction(tx, {
        eventType: 'order.planned_completion_date_changed',
        origin: 'user',
        orderId: order.orderId,
        actor: command.currentUser,
        requestId,
        sourceIdempotencyKey: command.dto.idempotencyKey,
        plannedCompletionDateBefore: order.plannedCompletionDate,
        plannedCompletionDateAfter: command.dto.plannedCompletionDate,
      });
      const responseVersion = await readOrderVersion(tx, order.orderId);
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
          version: responseVersion,
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
      if (command.currentUser.role !== 'packer') {
        await this.assertOrderScope(command.currentUser, order, [
          'orders.update',
          'orders.change_status',
        ], requestId);
      }
      const status = await loadOrderStatus(tx, command.dto.orderStatusId);
      if (command.currentUser.role === 'packer') {
        await this.assertPackerOrderStatusTarget(
          command.currentUser,
          order,
          status,
          requestId,
        );
      }
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
          scope: { source: 'calendar|order-header|kanban' },
          idempotencyKey: command.dto.idempotencyKey,
        },
      });

      await evaluateStatusAutomationInTransaction(tx, {
        eventType: 'order.status_changed',
        origin: 'user',
        orderId: order.orderId,
        actor: command.currentUser,
        requestId,
        sourceIdempotencyKey: command.dto.idempotencyKey,
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

  changeProductionStatusFromDeadline(
    command: ChangeProductionStatusFromDeadlineCommand,
  ): Promise<ChangeProductionStatusFromDeadlineResult> {
    return this.database.transaction((tx) => changeProductionStatusFromDeadlineInTransaction(tx, command));
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
      await this.assertOrderScope(command.currentUser, order, [
        'orders.update',
        'payments.update',
        'orders.view_financials',
      ], requestId);
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
      const access = await this.assertOrderScope(command.currentUser, order, [
        'orders.update',
        'orders.change_production_status',
      ], requestId, { tx, allowAssignedProductionWorker: true });
      const status = await loadProductionStatus(tx, command.dto.productionStatusId);
      assertVersion(order, command.dto.version);

      const cascade = await cascadeProductionStatusToDetails(tx, order, status.productionStatusId);
      if (!cascade) {
        const response = {
          order: {
            orderId: order.orderId,
            productionStatusId: order.productionStatusId ?? undefined,
            productionStatusFromDetailsEnabled: true,
            version: order.version,
          },
          requestId,
        };
        await completeIdempotency(tx, command.dto.idempotencyKey, response);
        return response;
      }

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
          detailStatusDistribution: cascade.beforeDetails.statusDistribution,
        },
        afterJson: {
          productionStatusId: cascade.nextProductionStatusId,
          productionStatusName: status.productionStatusName,
          productionStatusCode: status.productionStatusCode,
          productionStatusFromDetailsEnabled: cascade.nextProductionStatusFromDetailsEnabled,
          version: cascade.nextVersion,
          detailStatusDistribution: cascade.afterDetails.statusDistribution,
        },
        diffJson: {
          productionStatusId: {
            before: order.productionStatusId,
            after: cascade.nextProductionStatusId,
          },
          productionStatusFromDetailsEnabled: {
            before: order.productionStatusFromDetailsEnabled,
            after: cascade.nextProductionStatusFromDetailsEnabled,
          },
          affectedDetailIds: cascade.affectedDetailIds,
          affectedDetailCount: cascade.affectedDetailIds.length,
          beforeStatusDistribution: cascade.beforeDetails.statusDistribution,
          afterStatusDistribution: cascade.afterDetails.statusDistribution,
        },
        metadataJson: {
          source: SOURCE,
          orderId: order.orderId,
          clientId: order.clientId,
          productionStatusId: cascade.nextProductionStatusId,
          productionStatusCode: status.productionStatusCode,
          productionStatusName: status.productionStatusName,
          productionStatusFromDetailsEnabled: cascade.nextProductionStatusFromDetailsEnabled,
          previousProductionStatusFromDetailsEnabled: order.productionStatusFromDetailsEnabled,
          affectedDetailIds: cascade.affectedDetailIds,
          affectedDetailCount: cascade.affectedDetailIds.length,
          beforeStatusDistribution: cascade.beforeDetails.statusDistribution,
          afterStatusDistribution: cascade.afterDetails.statusDistribution,
          action: 'production_status_change',
          statusField: 'productionCurrentStatus',
          accessVia: access.accessVia,
          assignmentSource: access.assignmentSource,
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
          productionStatusId: cascade.nextProductionStatusId,
          productionStatusCode: status.productionStatusCode,
          productionStatusFromDetailsEnabled: cascade.nextProductionStatusFromDetailsEnabled,
          affectedDetailIds: cascade.affectedDetailIds,
          affectedDetailCount: cascade.affectedDetailIds.length,
          action: 'production_status_change',
          scope: { source: 'order-header|kanban' },
          accessVia: access.accessVia,
          assignmentSource: access.assignmentSource,
          idempotencyKey: command.dto.idempotencyKey,
        },
      });

      await evaluateStatusAutomationInTransaction(tx, {
        eventType: 'order.production_status_changed',
        origin: 'user',
        orderId: order.orderId,
        actor: command.currentUser,
        requestId,
        sourceIdempotencyKey: command.dto.idempotencyKey,
      });
      await evaluateMdfBoardLaminatedBathAutomationForDetails(tx, {
        detailIds: cascade.affectedDetailIds,
        actor: command.currentUser,
        requestId,
        sourceIdempotencyKey: command.dto.idempotencyKey,
      });

      const response = {
        order: {
          orderId: order.orderId,
          productionStatusId: cascade.nextProductionStatusId ?? undefined,
          productionStatusFromDetailsEnabled: cascade.nextProductionStatusFromDetailsEnabled,
          version: cascade.nextVersion,
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
      const access = await this.assertOrderScope(command.currentUser, detail.order, [
        'orders.update',
        'orders.change_production_status',
      ], requestId, { tx, allowAssignedProductionWorker: true });
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
          accessVia: access.accessVia,
          assignmentSource: access.assignmentSource,
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
          accessVia: access.accessVia,
          assignmentSource: access.assignmentSource,
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

  restoreAutoProductionStatus(
    command: RestoreAutoProductionStatusCommand,
  ): Promise<ProductionActionResponseDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);

      const requestId = requestIdOrFallback(command.requestId);
      const idempotency = await reconcileIdempotency(tx, {
        idempotencyKey: command.dto.idempotencyKey,
        commandName: 'orders.production_status_mode_restore',
        currentUser: command.currentUser,
        entityType: 'order',
        entityId: String(command.orderId),
        requestShape: {
          actorUserId: command.currentUser.id,
          commandName: 'orders.production_status_mode_restore',
          orderId: command.orderId,
          version: command.dto.version,
        },
      });
      if (idempotency.completedResponse) {
        return idempotency.completedResponse;
      }

      const order = await loadOrderForUpdate(tx, command.orderId);
      await this.assertOrderScope(
        command.currentUser,
        order,
        ['orders.update', 'orders.change_production_status'],
        requestId,
      );
      assertVersion(order, command.dto.version);

      // No-op branch: already in auto mode
      if (order.productionStatusFromDetailsEnabled === true) {
        const response: ProductionActionResponseDto = {
          order: {
            orderId: order.orderId,
            productionStatusId: order.productionStatusId ?? undefined,
            productionStatusFromDetailsEnabled: true,
            version: order.version,
          },
          requestId,
        };
        await completeIdempotency(tx, command.dto.idempotencyKey, response);
        return response;
      }

      const beforeDetails = await loadDetailProductionStatusMap(tx, command.orderId);
      const nextVersion = await enableAutoProductionStatus(tx, command.orderId);
      await runRecalcOrderProductionStatus(tx, command.orderId);
      const recalculatedStatusId = await loadOrderProductionStatusId(tx, command.orderId);

      let recalcStatusName: string | undefined;
      let recalcStatusCode: string | undefined;
      if (recalculatedStatusId !== null) {
        const statusInfo = await loadProductionStatus(tx, recalculatedStatusId);
        recalcStatusName = statusInfo.productionStatusName;
        recalcStatusCode = statusInfo.productionStatusCode;
      }

      const afterDetails = await loadDetailProductionStatusMap(tx, command.orderId);
      const affectedDetailIds = computeAffectedDetailIds(beforeDetails, afterDetails);
      const beforeStatusDistribution = detailMapToDistribution(beforeDetails);
      const afterStatusDistribution = detailMapToDistribution(afterDetails);

      const auditId = await writeAudit(tx, {
        event: 'orders.production_status_mode_restore',
        currentUser: command.currentUser,
        requestId,
        order,
        source: SOURCE,
        statusField: 'productionStatusMode',
        statusId: recalculatedStatusId ?? undefined,
        statusName: recalcStatusName,
        statusCode: recalcStatusCode,
        beforeJson: {
          productionStatusFromDetailsEnabled: order.productionStatusFromDetailsEnabled,
          productionStatusId: order.productionStatusId,
          version: order.version,
          detailStatusDistribution: beforeStatusDistribution,
        },
        afterJson: {
          productionStatusFromDetailsEnabled: true,
          productionStatusId: recalculatedStatusId,
          version: nextVersion,
          detailStatusDistribution: afterStatusDistribution,
        },
        diffJson: {
          productionStatusFromDetailsEnabled: {
            before: order.productionStatusFromDetailsEnabled,
            after: true,
          },
          productionStatusId: {
            before: order.productionStatusId,
            after: recalculatedStatusId,
          },
          affectedDetailIds,
          affectedDetailCount: affectedDetailIds.length,
          beforeStatusDistribution,
          afterStatusDistribution,
        },
        metadataJson: {
          source: SOURCE,
          orderId: order.orderId,
          clientId: order.clientId,
          productionStatusId: recalculatedStatusId,
          mode: 'auto',
          action: 'production_status_mode_restore',
          statusField: 'productionStatusMode',
          requestId,
        },
      });

      await enqueueOutbox(tx, {
        eventType: 'order.production_status_mode_restored',
        aggregateType: 'order',
        aggregateId: String(order.orderId),
        idempotencyKey: command.dto.idempotencyKey,
        payload: {
          eventType: 'order.production_status_mode_restored',
          actorUserId: command.currentUser.id,
          requestId,
          entityType: 'order',
          entityId: String(order.orderId),
          orderId: order.orderId,
          clientId: order.clientId,
          productionStatusId: recalculatedStatusId,
          productionStatusFromDetailsEnabled: true,
          affectedDetailIds,
          affectedDetailCount: affectedDetailIds.length,
          mode: 'auto',
          action: 'production_status_mode_restore',
          scope: { source: 'order-header' },
          idempotencyKey: command.dto.idempotencyKey,
        },
      });

      const response: ProductionActionResponseDto = {
        order: {
          orderId: order.orderId,
          productionStatusId: recalculatedStatusId ?? undefined,
          productionStatusFromDetailsEnabled: true,
          version: nextVersion,
        },
        auditId,
        requestId,
      };
      await completeIdempotency(tx, command.dto.idempotencyKey, response);
      return response;
    });
  }

  enterManualProductionStatus(
    command: EnterManualProductionStatusCommand,
  ): Promise<ProductionActionResponseDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);

      const requestId = requestIdOrFallback(command.requestId);
      const idempotency = await reconcileIdempotency(tx, {
        idempotencyKey: command.dto.idempotencyKey,
        commandName: 'orders.production_status_mode_manual',
        currentUser: command.currentUser,
        entityType: 'order',
        entityId: String(command.orderId),
        requestShape: {
          actorUserId: command.currentUser.id,
          commandName: 'orders.production_status_mode_manual',
          orderId: command.orderId,
          version: command.dto.version,
        },
      });
      if (idempotency.completedResponse) {
        return idempotency.completedResponse;
      }

      const order = await loadOrderForUpdate(tx, command.orderId);
      await this.assertOrderScope(
        command.currentUser,
        order,
        ['orders.update', 'orders.change_production_status'],
        requestId,
      );
      assertVersion(order, command.dto.version);

      // Deprecated compatibility endpoint: manual status locking was removed.
      // Keep the route/idempotency shape for old clients, but never write a durable manual lock.
      if (order.productionStatusFromDetailsEnabled === true) {
        const response: ProductionActionResponseDto = {
          order: {
            orderId: order.orderId,
            productionStatusId: order.productionStatusId ?? undefined,
            productionStatusFromDetailsEnabled: true,
            version: order.version,
          },
          requestId,
        };
        await completeIdempotency(tx, command.dto.idempotencyKey, response);
        return response;
      }

      const beforeDetails = await loadDetailProductionStatusMap(tx, command.orderId);
      const nextVersion = await enableAutoProductionStatus(tx, command.orderId);
      await runRecalcOrderProductionStatus(tx, command.orderId);
      const recalculatedStatusId = await loadOrderProductionStatusId(tx, command.orderId);
      const afterDetails = await loadDetailProductionStatusMap(tx, command.orderId);

      const affectedDetailIds = computeAffectedDetailIds(beforeDetails, afterDetails);
      const beforeStatusDistribution = detailMapToDistribution(beforeDetails);
      const afterStatusDistribution = detailMapToDistribution(afterDetails);

      let recalcStatusName: string | undefined;
      let recalcStatusCode: string | undefined;
      if (recalculatedStatusId !== null) {
        const statusInfo = await loadProductionStatus(tx, recalculatedStatusId);
        recalcStatusName = statusInfo.productionStatusName;
        recalcStatusCode = statusInfo.productionStatusCode;
      }

      const auditId = await writeAudit(tx, {
        event: 'orders.production_status_mode_restore',
        currentUser: command.currentUser,
        requestId,
        order,
        source: SOURCE,
        statusField: 'productionStatusMode',
        statusId: recalculatedStatusId ?? undefined,
        statusName: recalcStatusName,
        statusCode: recalcStatusCode,
        beforeJson: {
          productionStatusFromDetailsEnabled: order.productionStatusFromDetailsEnabled,
          productionStatusId: order.productionStatusId,
          version: order.version,
          detailStatusDistribution: beforeStatusDistribution,
        },
        afterJson: {
          productionStatusFromDetailsEnabled: true,
          productionStatusId: recalculatedStatusId,
          version: nextVersion,
          detailStatusDistribution: afterStatusDistribution,
        },
        diffJson: {
          productionStatusFromDetailsEnabled: {
            before: order.productionStatusFromDetailsEnabled,
            after: true,
          },
          productionStatusId: {
            before: order.productionStatusId,
            after: recalculatedStatusId,
          },
          affectedDetailIds,
          affectedDetailCount: affectedDetailIds.length,
          beforeStatusDistribution,
          afterStatusDistribution,
        },
        metadataJson: {
          source: SOURCE,
          orderId: order.orderId,
          clientId: order.clientId,
          productionStatusId: recalculatedStatusId,
          mode: 'auto',
          action: 'production_status_mode_restore',
          statusField: 'productionStatusMode',
          requestId,
        },
      });

      await enqueueOutbox(tx, {
        eventType: 'order.production_status_mode_restored',
        aggregateType: 'order',
        aggregateId: String(order.orderId),
        idempotencyKey: command.dto.idempotencyKey,
        payload: {
          eventType: 'order.production_status_mode_restored',
          actorUserId: command.currentUser.id,
          requestId,
          entityType: 'order',
          entityId: String(order.orderId),
          orderId: order.orderId,
          clientId: order.clientId,
          productionStatusId: recalculatedStatusId,
          productionStatusFromDetailsEnabled: true,
          affectedDetailIds,
          affectedDetailCount: affectedDetailIds.length,
          mode: 'auto',
          action: 'production_status_mode_restore',
          scope: { source: 'order-header' },
          idempotencyKey: command.dto.idempotencyKey,
        },
      });

      const response: ProductionActionResponseDto = {
        order: {
          orderId: order.orderId,
          productionStatusId: recalculatedStatusId ?? undefined,
          productionStatusFromDetailsEnabled: true,
          version: nextVersion,
        },
        auditId,
        requestId,
      };
      await completeIdempotency(tx, command.dto.idempotencyKey, response);
      return response;
    });
  }

  changeBatchDetailProductionStatus(
    command: ChangeBatchDetailProductionStatusCommand,
  ): Promise<BatchDetailProductionStatusResponseDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const requestId = requestIdOrFallback(command.requestId);

      const detailIds = Array.from(new Set(command.dto.detailIds)).sort((a, b) => a - b);

      const idempotency = await reconcileIdempotency(tx, {
        idempotencyKey: command.dto.idempotencyKey,
        commandName: 'orders.detail_production_status_batch_change',
        currentUser: command.currentUser,
        entityType: 'order',
        entityId: String(command.orderId),
        requestShape: {
          actorUserId: command.currentUser.id,
          commandName: 'orders.detail_production_status_batch_change',
          orderId: command.orderId,
          detailIds,
          productionStatusId: command.dto.productionStatusId,
          version: command.dto.version,
        },
      });
      if (idempotency.completedResponse) {
        return idempotency.completedResponse as BatchDetailProductionStatusResponseDto;
      }

      // 1. Lock the parent order row FIRST, then scope + version guard. This follows the
      //    order-before-detail lock discipline of the order-level production commands
      //    (changeProductionStatus / restoreAuto / enterManual / *FromDeadline), which all lock the
      //    order row (loadOrderForUpdate) before locking detail rows (loadDetailProductionStatusSnapshot).
      //    See "Lock ordering" note below for the residual batch<->detail-stage debt.
      const order = await loadOrderForUpdate(tx, command.orderId);
      // Additive assigned-production-worker path (parity with the sibling production commands from
      // §7.1): a worker who is responsible_employee on an order_workshops row may act even without
      // orders.update. Owner-path (manager/operator/admin) is unchanged.
      const access = await this.assertOrderScope(
        command.currentUser,
        order,
        ['orders.update', 'orders.change_production_status'],
        requestId,
        { tx, allowAssignedProductionWorker: true },
      );
      assertVersion(order, command.dto.version);

      const status = await loadProductionStatus(tx, command.dto.productionStatusId);

      // 2. Lock all live details of the order (FOR UPDATE, ascending detail_id) — AFTER the order
      //    row. Mirrors the order-level commands' loadDetailProductionStatusSnapshot lock. Serves
      //    belonging-validation (selected ⊆ live) and the before-distribution from one locked read.
      const currentDetails = await loadOrderDetailsForBatch(tx, order.orderId);
      const currentDetailIds = new Set(currentDetails.map((detail) => detail.detailId));
      const missingDetailIds = detailIds.filter((id) => !currentDetailIds.has(id));
      if (missingDetailIds.length > 0) {
        throw new ApiError(
          404,
          'ORDER_DETAIL_NOT_FOUND',
          'Часть выбранных деталей не найдена в заказе',
          { orderId: order.orderId, missingDetailIds },
        );
      }
      const beforeStatusDistribution = detailStatusDistribution(currentDetails);
      const currentById = new Map(
        currentDetails.map((detail) => [detail.detailId, detail.productionStatusId] as const),
      );
      const selectedDetailCount = detailIds.length;

      // 3. Update only the SELECTED (already-locked) details whose status actually changes
      //    (COALESCE delete_flag — legacy null rows are active). RETURNING yields the true
      //    changed-row count.
      const updated = await tx.query<{ detail_id: string | number }>(
        `
        UPDATE order_details
        SET production_status_id = $1
        WHERE order_id = $2
          AND detail_id = ANY($3::bigint[])
          AND COALESCE(delete_flag, false) = false
          AND production_status_id IS DISTINCT FROM $1
        RETURNING detail_id
        `,
        [status.productionStatusId, order.orderId, detailIds],
      );
      const changedDetailIds = updated.rows.map((row) => toNumber(row.detail_id));
      const affectedDetailCount = changedDetailIds.length;

      // 4. Detail statuses always own the derived order production status.
      await ensureProductionStatusFromDetailsEnabled(tx, order.orderId);
      await runRecalcOrderProductionStatus(tx, order.orderId);

      // 5. Bump the parent version so stale callers are rejected (recalc never bumps version).
      //    This UPDATE orders fires the existing trg_crm_sync_orders trigger, exactly as the
      //    sibling production commands already do; crm_sync_enqueue dedups pending by key.
      const bumped = await tx.query<{
        version: string | number;
        production_status_id: string | number | null;
      }>(
        `
        UPDATE orders
        SET production_status_from_details_enabled = true,
            version = version + 1,
            updated_at = now()
        WHERE order_id = $1
        RETURNING version, production_status_id
        `,
        [order.orderId],
      );
      const newVersion = toNumber(bumped.rows[0].version);
      const afterProductionStatusId =
        bumped.rows[0].production_status_id === null
          ? null
          : toNumber(bumped.rows[0].production_status_id);

      // After-distribution is computed analytically from the observed before-snapshot + this
      // command's own changes (NOT a racy second read) — distributions are command-start-relative.
      const afterStatusDistribution = projectDistributionAfterChange(
        beforeStatusDistribution,
        currentById,
        changedDetailIds,
        status.productionStatusId,
      );

      const auditId = await writeAudit(tx, {
        event: 'orders.detail_production_status_batch_change',
        currentUser: command.currentUser,
        requestId,
        order,
        source: SOURCE,
        statusField: 'productionDetailBatch',
        statusId: status.productionStatusId,
        statusName: status.productionStatusName,
        statusCode: status.productionStatusCode,
        beforeJson: {
          orderProductionStatusId: order.productionStatusId,
          productionStatusFromDetailsEnabled: order.productionStatusFromDetailsEnabled,
          orderVersion: order.version,
          detailStatusDistribution: beforeStatusDistribution,
        },
        afterJson: {
          orderProductionStatusId: afterProductionStatusId,
          productionStatusFromDetailsEnabled: true,
          orderVersion: newVersion,
          detailStatusDistribution: afterStatusDistribution,
        },
        diffJson: {
          detailIds,
          changedDetailIds,
          selectedDetailCount,
          affectedDetailCount,
          productionStatusId: status.productionStatusId,
          orderProductionStatusId: { before: order.productionStatusId, after: afterProductionStatusId },
          orderVersion: { before: order.version, after: newVersion },
          beforeStatusDistribution,
          afterStatusDistribution,
          statusDistributionBasis: 'command-start-snapshot',
        },
        metadataJson: {
          source: SOURCE,
          orderId: order.orderId,
          clientId: order.clientId,
          detailIds,
          changedDetailIds,
          selectedDetailCount,
          affectedDetailCount,
          productionStatusId: status.productionStatusId,
          productionStatusCode: status.productionStatusCode,
          productionStatusName: status.productionStatusName,
          productionStatusFromDetailsEnabled: true,
          action: 'detail_production_status_batch_change',
          statusField: 'productionDetailBatch',
          accessVia: access.accessVia,
          assignmentSource: access.assignmentSource,
          requestId,
        },
      });

      await enqueueOutbox(tx, {
        eventType: 'order.detail_production_status_batch_changed',
        aggregateType: 'order',
        aggregateId: String(order.orderId),
        idempotencyKey: command.dto.idempotencyKey,
        payload: {
          eventType: 'order.detail_production_status_batch_changed',
          actorUserId: command.currentUser.id,
          requestId,
          entityType: 'order',
          entityId: String(order.orderId),
          orderId: order.orderId,
          clientId: order.clientId,
          detailIds,
          changedDetailIds,
          selectedDetailCount,
          affectedDetailCount,
          productionStatusId: status.productionStatusId,
          productionStatusCode: status.productionStatusCode,
          productionStatusFromDetailsEnabled: true,
          orderProductionStatusId: { before: order.productionStatusId, after: afterProductionStatusId },
          orderVersion: { before: order.version, after: newVersion },
          beforeStatusDistribution,
          afterStatusDistribution,
          statusDistributionBasis: 'command-start-snapshot',
          action: 'detail_production_status_batch_change',
          accessVia: access.accessVia,
          assignmentSource: access.assignmentSource,
          idempotencyKey: command.dto.idempotencyKey,
        },
      });
      if (order.productionStatusId !== afterProductionStatusId) {
        await evaluateStatusAutomationInTransaction(tx, {
          eventType: 'order.production_status_changed',
          origin: 'user',
          orderId: order.orderId,
          actor: command.currentUser,
          requestId,
          sourceIdempotencyKey: command.dto.idempotencyKey,
        });
      }
      await evaluateMdfBoardLaminatedBathAutomationForDetails(tx, {
        detailIds: changedDetailIds,
        actor: command.currentUser,
        requestId,
        sourceIdempotencyKey: command.dto.idempotencyKey,
      });

      const response: BatchDetailProductionStatusResponseDto = {
        order: {
          orderId: order.orderId,
          productionStatusId: afterProductionStatusId ?? undefined,
          version: newVersion,
        },
        selectedDetailCount,
        affectedDetailCount,
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
      const access = await this.assertOrderScope(command.currentUser, order, [
        'orders.update',
        'orders.change_production_status',
      ], requestId, { tx, allowAssignedProductionWorker: true });
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
          accessVia: access.accessVia,
          assignmentSource: access.assignmentSource,
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
          accessVia: access.accessVia,
          assignmentSource: access.assignmentSource,
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
    options: OrderScopeOptions = {},
  ): Promise<OrderAccessDecision> {
    const ownerAllowed =
      requiredPermissions.every((permission) => currentUser.permissions.includes(permission as PermissionName)) &&
      this.orderAccessPolicy.canUpdate(currentUser, {
      orderId: order.orderId,
      createdByUserId: order.createdByUserId,
      managerUserId: order.managerUserId,
      });

    if (ownerAllowed) {
      return { accessVia: 'owner', assignmentSource: null };
    }

    // Additive path: a worker (productionTasks.update scope === 'assigned') who is the
    // responsible_employee on at least one of the order's order_workshops rows may act on
    // production status/stages. Order-level allow only; never broadens non-worker roles
    // (their productionTasks.update scope is 'all'/'none', not 'assigned').
    if (options.allowAssignedProductionWorker && options.tx) {
      const productionTaskScope = rolePolicyForUser(currentUser).productionTasks.update;
      if (
        productionTaskScope === 'assigned' &&
        currentUser.permissions.includes('orders.change_production_status')
      ) {
        const assignedUserIds = await loadOrderAssignedUserIds(options.tx, order.orderId);
        if (assignedUserIds.includes(currentUser.id)) {
          return {
            accessVia: 'assigned_production_worker',
            assignmentSource: 'order_workshops.responsible_employee_id',
          };
        }
      }
    }

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

  private async assertPackerOrderStatusTarget(
    currentUser: CurrentUser,
    order: LockedOrder,
    status: { orderStatusId: number; orderStatusName: string },
    requestId: string,
  ): Promise<void> {
    if (
      currentUser.permissions.includes('orders.view') &&
      currentUser.permissions.includes('orders.change_status') &&
      PACKER_ALLOWED_ORDER_STATUS_NAMES.has(normalizeStatusName(status.orderStatusName))
    ) {
      return;
    }

    await writeDeniedActionAudit(this.database, {
      currentUser,
      requestId,
      order,
      requiredPermissions: ['orders.view', 'orders.change_status'],
      reason: 'order_status_target_denied',
      metadata: {
        orderStatusId: status.orderStatusId,
        orderStatusName: status.orderStatusName,
        allowedOrderStatusNames: [...PACKER_ALLOWED_ORDER_STATUS_NAMES],
      },
    });
    throw new ApiError(
      403,
      'ORDER_STATUS_TARGET_DENIED',
      'Упаковщик может ставить только статусы заказа "Готов к выдаче" и "Выдан"',
      {
        orderStatusId: status.orderStatusId,
        orderStatusName: status.orderStatusName,
        allowedOrderStatusNames: [...PACKER_ALLOWED_ORDER_STATUS_NAMES],
      },
    );
  }
}

async function writeDeniedActionAudit(
  database: DatabaseService,
  input: {
    currentUser: CurrentUser;
    requestId: string;
    order: LockedOrder;
    requiredPermissions: readonly string[];
    reason?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await auditService.recordDenied(database, {
    event: 'production.action_denied',
    entityType: 'order',
    entityId: input.order.orderId,
    actorUserId: input.currentUser.id,
    actorUsername: input.currentUser.username,
    actorRole: input.currentUser.role,
    requestId: input.requestId,
    source: SOURCE,
    relatedOrderId: input.order.orderId,
    relatedClientId: input.order.clientId,
    reason: input.reason ?? 'order_scope_denied',
    requiredPermissions: input.requiredPermissions,
    metadata: input.metadata,
  });
}

function normalizeStatusName(value: string): string {
  return value.trim().toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ');
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
      expectedSourceOrderStatusId: command.expectedSourceOrderStatusId,
      orderStatusId: command.targetOrderStatusId,
      deadlineId: command.deadlineId,
      deadlineEventId: command.deadlineEventId,
      actionRuleId: command.actionRuleId,
      ruleVersionId: command.ruleVersionId ?? null,
      snapshotHash,
    },
  });
  if (idempotency.completedResponse) {
    return mapDeadlineStoredResponse(idempotency.completedResponse) as ChangeOrderStatusFromDeadlineResult;
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
    expectedSourceOrderStatusId: command.expectedSourceOrderStatusId,
  };

  if (order.orderStatusId !== command.expectedSourceOrderStatusId) {
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
      skipReason: 'stale_source_status',
      response,
    });
    return { status: 'skipped', skipReason: 'stale_source_status', response };
  }

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

export async function changeProductionStatusFromDeadlineInTransaction(
  tx: TransactionClient,
  command: ChangeProductionStatusFromDeadlineCommand,
): Promise<ChangeProductionStatusFromDeadlineResult> {
  const requestId = requestIdOrFallback(command.requestId);
  const ruleConfigSnapshot = command.ruleConfigSnapshot as { snapshotHash?: unknown };
  const snapshotHash =
    typeof ruleConfigSnapshot.snapshotHash === 'string' ? ruleConfigSnapshot.snapshotHash : null;
  const idempotency = await reconcileIdempotency(tx, {
    idempotencyKey: command.idempotencyKey,
    commandName: 'orders.production_status_change',
    actorUserId: null,
    entityType: 'order',
    entityId: String(command.orderId),
    requestShape: {
      actorUserId: null,
      actorLabel: command.systemActor.actorLabel,
      commandName: 'orders.production_status_change',
      source: command.source,
      orderId: command.orderId,
      productionStatusId: command.targetProductionStatusId,
      productionStatusScope: command.productionStatusScope,
      deadlineId: command.deadlineId,
      deadlineEventId: command.deadlineEventId,
      actionRuleId: command.actionRuleId,
      ruleVersionId: command.ruleVersionId ?? null,
      snapshotHash,
    },
  });
  if (idempotency.completedResponse) {
    return mapDeadlineStoredResponse(
      idempotency.completedResponse,
      'same_production_status',
    ) as ChangeProductionStatusFromDeadlineResult;
  }

  const order = await loadOrderForUpdate(tx, command.orderId);
  const status = await loadProductionStatus(tx, command.targetProductionStatusId);

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
    productionStatusScope: command.productionStatusScope,
  };

  const cascade = await cascadeProductionStatusToDetails(tx, order, status.productionStatusId);
  if (!cascade) {
    const response = {
      order: {
        orderId: order.orderId,
        productionStatusId: order.productionStatusId ?? undefined,
        productionStatusFromDetailsEnabled: true,
        version: order.version,
      },
      requestId,
    };
    await completeDeadlineIdempotency(tx, command.idempotencyKey, {
      status: 'skipped',
      skipReason: 'same_production_status',
      response,
    });
    return { status: 'skipped', skipReason: 'same_production_status', response };
  }

  const auditId = await writeAudit(tx, {
    event: 'orders.production_status_change',
    actorUserId: null,
    requestId,
    order,
    source: command.source,
    statusField: 'productionCurrentStatus',
    statusId: status.productionStatusId,
    statusName: status.productionStatusName,
    statusCode: status.productionStatusCode,
    beforeJson: {
      productionStatusId: order.productionStatusId,
      productionStatusFromDetailsEnabled: order.productionStatusFromDetailsEnabled,
      version: order.version,
      detailStatusDistribution: cascade.beforeDetails.statusDistribution,
      deadlineId: command.deadlineId,
      deadlineEventId: command.deadlineEventId,
      actionRuleId: command.actionRuleId,
      snapshotHash,
    },
    afterJson: {
      productionStatusId: cascade.nextProductionStatusId,
      productionStatusName: status.productionStatusName,
      productionStatusCode: status.productionStatusCode,
      productionStatusFromDetailsEnabled: cascade.nextProductionStatusFromDetailsEnabled,
      version: cascade.nextVersion,
      detailStatusDistribution: cascade.afterDetails.statusDistribution,
      deadlineId: command.deadlineId,
      deadlineEventId: command.deadlineEventId,
      actionRuleId: command.actionRuleId,
      snapshotHash,
    },
    diffJson: {
      productionStatusId: {
        before: order.productionStatusId,
        after: cascade.nextProductionStatusId,
      },
      productionStatusFromDetailsEnabled: {
        before: order.productionStatusFromDetailsEnabled,
        after: cascade.nextProductionStatusFromDetailsEnabled,
      },
      affectedDetailIds: cascade.affectedDetailIds,
      affectedDetailCount: cascade.affectedDetailIds.length,
      beforeStatusDistribution: cascade.beforeDetails.statusDistribution,
      afterStatusDistribution: cascade.afterDetails.statusDistribution,
    },
    metadataJson: {
      ...deadlineMetadata,
      productionStatusId: cascade.nextProductionStatusId,
      productionStatusCode: status.productionStatusCode,
      productionStatusName: status.productionStatusName,
      previousProductionStatusId: order.productionStatusId,
      productionStatusFromDetailsEnabled: cascade.nextProductionStatusFromDetailsEnabled,
      previousProductionStatusFromDetailsEnabled: order.productionStatusFromDetailsEnabled,
      affectedDetailIds: cascade.affectedDetailIds,
      affectedDetailCount: cascade.affectedDetailIds.length,
      beforeStatusDistribution: cascade.beforeDetails.statusDistribution,
      afterStatusDistribution: cascade.afterDetails.statusDistribution,
      action: 'production_status_change',
      statusField: 'productionCurrentStatus',
    },
  });

  await enqueueOutbox(tx, {
    eventType: 'order.production_status_changed',
    aggregateType: 'order',
    aggregateId: String(order.orderId),
    idempotencyKey: command.idempotencyKey,
    payload: {
      ...deadlineMetadata,
      eventType: 'order.production_status_changed',
      actorUserId: null,
      entityType: 'order',
      entityId: String(order.orderId),
      productionStatusId: cascade.nextProductionStatusId,
      previousProductionStatusId: order.productionStatusId,
      productionStatusCode: status.productionStatusCode,
      productionStatusFromDetailsEnabled: cascade.nextProductionStatusFromDetailsEnabled,
      affectedDetailIds: cascade.affectedDetailIds,
      affectedDetailCount: cascade.affectedDetailIds.length,
      action: 'production_status_change',
      scope: { source: command.source, productionStatusScope: command.productionStatusScope },
    },
  });
  await evaluateMdfBoardLaminatedBathAutomationForDetails(tx, {
    detailIds: cascade.affectedDetailIds,
    actor: deadlineSystemActorAsCurrentUser(command.systemActor),
    requestId,
    sourceIdempotencyKey: command.idempotencyKey,
  });

  const response = {
    order: {
      orderId: order.orderId,
      productionStatusId: cascade.nextProductionStatusId ?? undefined,
      productionStatusFromDetailsEnabled: cascade.nextProductionStatusFromDetailsEnabled,
      version: cascade.nextVersion,
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

// Idempotency is intentionally inherited from the source command: these actions execute inside
// that command's transaction and must not reserve a second reconcileIdempotency key.
export async function changeOrderStatusFromAutomationInTransaction(
  tx: TransactionClient,
  orderId: number,
  targetStatusId: number,
  ctx: AutomationActionContext,
): Promise<AutomationActionResult> {
  const order = await loadOrderForUpdate(tx, orderId);
  if (order.orderStatusId === targetStatusId) {
    return { status: 'skipped', skipReason: 'same_status' };
  }

  const status = await loadOrderStatus(tx, targetStatusId);
  const nextVersion = await updateOrderStatus(tx, order.orderId, status.orderStatusId);
  const metadata = automationMetadata(ctx, order.orderId, order.clientId, {
    orderStatusId: status.orderStatusId,
    orderStatusName: status.orderStatusName,
    action: 'automation_status_change',
    statusField: 'orderStatus',
  });
  const auditId = await writeAudit(tx, {
    event: 'orders.status_change',
    currentUser: ctx.actor,
    requestId: ctx.requestId,
    order,
    source: AUTOMATION_SOURCE,
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
    metadataJson: metadata,
  });

  await enqueueOutbox(tx, {
    eventType: 'order.status_changed',
    aggregateType: 'order',
    aggregateId: String(order.orderId),
    idempotencyKey: ctx.outboxIdempotencyKey,
    payload: {
      eventType: 'order.status_changed',
      actorUserId: ctx.actor.id,
      requestId: ctx.requestId,
      entityType: 'order',
      entityId: String(order.orderId),
      orderId: order.orderId,
      clientId: order.clientId,
      orderStatusId: status.orderStatusId,
      action: 'order_status_change',
      scope: { source: 'calendar|order-header' },
      origin: 'automation',
      idempotencyKey: ctx.outboxIdempotencyKey,
    },
  });

  return { status: 'executed', auditId };
}

// Idempotency is intentionally inherited from the source command: this action runs in its
// transaction and must not create a second reconcileIdempotency reservation.
export async function changeProductionStatusFromAutomationInTransaction(
  tx: TransactionClient,
  orderId: number,
  targetStatusId: number,
  ctx: AutomationActionContext,
): Promise<AutomationActionResult> {
  const order = await loadOrderForUpdate(tx, orderId);

  const status = await loadProductionStatus(tx, targetStatusId);
  const cascade = await cascadeProductionStatusToDetails(tx, order, status.productionStatusId);
  if (!cascade) {
    return { status: 'skipped', skipReason: 'same_status' };
  }

  const metadata = automationMetadata(ctx, order.orderId, order.clientId, {
    productionStatusId: cascade.nextProductionStatusId,
    productionStatusCode: status.productionStatusCode,
    productionStatusName: status.productionStatusName,
    productionStatusFromDetailsEnabled: cascade.nextProductionStatusFromDetailsEnabled,
    previousProductionStatusFromDetailsEnabled: order.productionStatusFromDetailsEnabled,
    affectedDetailIds: cascade.affectedDetailIds,
    affectedDetailCount: cascade.affectedDetailIds.length,
    beforeStatusDistribution: cascade.beforeDetails.statusDistribution,
    afterStatusDistribution: cascade.afterDetails.statusDistribution,
    action: 'automation_status_change',
    statusField: 'productionCurrentStatus',
  });
  const auditId = await writeAudit(tx, {
    event: 'orders.production_status_change',
    currentUser: ctx.actor,
    requestId: ctx.requestId,
    order,
    source: AUTOMATION_SOURCE,
    statusField: 'productionCurrentStatus',
    statusId: status.productionStatusId,
    statusName: status.productionStatusName,
    statusCode: status.productionStatusCode,
    beforeJson: {
      productionStatusId: order.productionStatusId,
      productionStatusFromDetailsEnabled: order.productionStatusFromDetailsEnabled,
      version: order.version,
      detailStatusDistribution: cascade.beforeDetails.statusDistribution,
    },
    afterJson: {
      productionStatusId: cascade.nextProductionStatusId,
      productionStatusName: status.productionStatusName,
      productionStatusCode: status.productionStatusCode,
      productionStatusFromDetailsEnabled: cascade.nextProductionStatusFromDetailsEnabled,
      version: cascade.nextVersion,
      detailStatusDistribution: cascade.afterDetails.statusDistribution,
    },
    diffJson: {
      productionStatusId: {
        before: order.productionStatusId,
        after: cascade.nextProductionStatusId,
      },
      productionStatusFromDetailsEnabled: {
        before: order.productionStatusFromDetailsEnabled,
        after: cascade.nextProductionStatusFromDetailsEnabled,
      },
      affectedDetailIds: cascade.affectedDetailIds,
      affectedDetailCount: cascade.affectedDetailIds.length,
      beforeStatusDistribution: cascade.beforeDetails.statusDistribution,
      afterStatusDistribution: cascade.afterDetails.statusDistribution,
    },
    metadataJson: metadata,
  });

  await enqueueOutbox(tx, {
    eventType: 'order.production_status_changed',
    aggregateType: 'order',
    aggregateId: String(order.orderId),
    idempotencyKey: ctx.outboxIdempotencyKey,
    payload: {
      eventType: 'order.production_status_changed',
      actorUserId: ctx.actor.id,
      requestId: ctx.requestId,
      entityType: 'order',
      entityId: String(order.orderId),
      orderId: order.orderId,
      clientId: order.clientId,
      productionStatusId: cascade.nextProductionStatusId,
      productionStatusCode: status.productionStatusCode,
      productionStatusFromDetailsEnabled: cascade.nextProductionStatusFromDetailsEnabled,
      affectedDetailIds: cascade.affectedDetailIds,
      affectedDetailCount: cascade.affectedDetailIds.length,
      action: 'production_status_change',
      scope: { source: 'order-header' },
      origin: 'automation',
      idempotencyKey: ctx.outboxIdempotencyKey,
    },
  });
  await evaluateMdfBoardLaminatedBathAutomationForDetails(tx, {
    detailIds: cascade.affectedDetailIds,
    actor: ctx.actor,
    requestId: ctx.requestId,
    sourceIdempotencyKey: ctx.outboxIdempotencyKey,
  });

  return { status: 'executed', auditId };
}

// Idempotency is intentionally inherited from the source command: this action runs in its
// transaction and must not create a second reconcileIdempotency reservation.
export async function changeDetailsProductionStatusFromAutomationInTransaction(
  tx: TransactionClient,
  orderId: number,
  targetStatusId: number,
  ctx: AutomationActionContext,
): Promise<AutomationActionResult> {
  const order = await loadOrderForUpdate(tx, orderId);
  const currentDetails = await loadOrderDetailsForBatch(tx, order.orderId);
  if (currentDetails.length === 0) {
    return { status: 'skipped', skipReason: 'no_details' };
  }
  // Все живые детали уже в целевом статусе → no-op без version-бампа/audit/outbox
  // (тот же same-status контракт, что у order-level automation-действий).
  if (currentDetails.every((detail) => detail.productionStatusId === targetStatusId)) {
    return { status: 'skipped', skipReason: 'same_status' };
  }

  const status = await loadProductionStatus(tx, targetStatusId);
  const detailIds = currentDetails.map((detail) => detail.detailId);
  const beforeStatusDistribution = detailStatusDistribution(currentDetails);
  const currentById = new Map(
    currentDetails.map((detail) => [detail.detailId, detail.productionStatusId] as const),
  );
  const updated = await tx.query<{ detail_id: string | number }>(
    `
    UPDATE order_details
    SET production_status_id = $1
    WHERE order_id = $2
      AND detail_id = ANY($3::bigint[])
      AND COALESCE(delete_flag, false) = false
      AND production_status_id IS DISTINCT FROM $1
    RETURNING detail_id
    `,
    [status.productionStatusId, order.orderId, detailIds],
  );
  const changedDetailIds = updated.rows.map((row) => toNumber(row.detail_id));
  const affectedDetailCount = changedDetailIds.length;

  await ensureProductionStatusFromDetailsEnabled(tx, order.orderId);
  await runRecalcOrderProductionStatus(tx, order.orderId);

  const bumped = await tx.query<{
    version: string | number;
    production_status_id: string | number | null;
  }>(
    `
    UPDATE orders
    SET production_status_from_details_enabled = true,
        version = version + 1,
        updated_at = now()
    WHERE order_id = $1
    RETURNING version, production_status_id
    `,
    [order.orderId],
  );
  const newVersion = toNumber(bumped.rows[0].version);
  const afterProductionStatusId =
    bumped.rows[0].production_status_id === null
      ? null
      : toNumber(bumped.rows[0].production_status_id);
  const afterStatusDistribution = projectDistributionAfterChange(
    beforeStatusDistribution,
    currentById,
    changedDetailIds,
    status.productionStatusId,
  );
  const metadata = automationMetadata(ctx, order.orderId, order.clientId, {
    detailIds,
    changedDetailIds,
    selectedDetailCount: detailIds.length,
    affectedDetailCount,
    productionStatusId: status.productionStatusId,
    productionStatusCode: status.productionStatusCode,
    productionStatusName: status.productionStatusName,
    productionStatusFromDetailsEnabled: true,
    action: 'automation_status_change',
    statusField: 'productionDetailBatch',
  });
  const auditId = await writeAudit(tx, {
    event: 'orders.detail_production_status_batch_change',
    currentUser: ctx.actor,
    requestId: ctx.requestId,
    order,
    source: AUTOMATION_SOURCE,
    statusField: 'productionDetailBatch',
    statusId: status.productionStatusId,
    statusName: status.productionStatusName,
    statusCode: status.productionStatusCode,
    beforeJson: {
      orderProductionStatusId: order.productionStatusId,
      productionStatusFromDetailsEnabled: order.productionStatusFromDetailsEnabled,
      orderVersion: order.version,
      detailStatusDistribution: beforeStatusDistribution,
    },
    afterJson: {
      orderProductionStatusId: afterProductionStatusId,
      productionStatusFromDetailsEnabled: true,
      orderVersion: newVersion,
      detailStatusDistribution: afterStatusDistribution,
    },
    diffJson: {
      detailIds,
      changedDetailIds,
      selectedDetailCount: detailIds.length,
      affectedDetailCount,
      productionStatusId: status.productionStatusId,
      orderProductionStatusId: {
        before: order.productionStatusId,
        after: afterProductionStatusId,
      },
      orderVersion: { before: order.version, after: newVersion },
      beforeStatusDistribution,
      afterStatusDistribution,
      statusDistributionBasis: 'command-start-snapshot',
    },
    metadataJson: metadata,
  });

  await enqueueOutbox(tx, {
    eventType: 'order.detail_production_status_batch_changed',
    aggregateType: 'order',
    aggregateId: String(order.orderId),
    idempotencyKey: ctx.outboxIdempotencyKey,
    payload: {
      eventType: 'order.detail_production_status_batch_changed',
      actorUserId: ctx.actor.id,
      requestId: ctx.requestId,
      entityType: 'order',
      entityId: String(order.orderId),
      orderId: order.orderId,
      clientId: order.clientId,
      detailIds,
      changedDetailIds,
      selectedDetailCount: detailIds.length,
      affectedDetailCount,
      productionStatusId: status.productionStatusId,
      productionStatusCode: status.productionStatusCode,
      productionStatusFromDetailsEnabled: true,
      orderProductionStatusId: { before: order.productionStatusId, after: afterProductionStatusId },
      orderVersion: { before: order.version, after: newVersion },
      beforeStatusDistribution,
      afterStatusDistribution,
      statusDistributionBasis: 'command-start-snapshot',
      action: 'detail_production_status_batch_change',
      origin: 'automation',
      idempotencyKey: ctx.outboxIdempotencyKey,
    },
  });
  await evaluateMdfBoardLaminatedBathAutomationForDetails(tx, {
    detailIds: changedDetailIds,
    actor: ctx.actor,
    requestId: ctx.requestId,
    sourceIdempotencyKey: ctx.outboxIdempotencyKey,
  });

  return { status: 'executed', auditId };
}

function deadlineSystemActorAsCurrentUser(
  actor: ChangeProductionStatusFromDeadlineCommand['systemActor'],
): CurrentUser {
  return {
    id: actor.actorUserId === null ? '0' : String(actor.actorUserId),
    username: actor.actorLabel,
    role: 'admin',
    roleId: 1,
    permissions: getPermissionsForRole('admin'),
  };
}

function automationMetadata(
  ctx: AutomationActionContext,
  orderId: number,
  clientId: number | null,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    source: AUTOMATION_SOURCE,
    origin: 'automation',
    orderId,
    clientId,
    ruleId: ctx.ruleId,
    ruleName: ctx.ruleName,
    eventType: ctx.eventType,
    triggerRequestId: ctx.requestId,
    ...fields,
  };
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
  result: ChangeOrderStatusFromDeadlineResult | ChangeProductionStatusFromDeadlineResult,
): Promise<void> {
  await completeIdempotency(tx, idempotencyKey, {
    ...result.response,
    deadlineActionStatus: result.status,
    deadlineSkipReason: result.skipReason ?? null,
  } as ProductionActionResponseDto);
}

function mapDeadlineStoredResponse(
  response: ProductionActionResponseDto,
  defaultSkipReason = 'same_status',
): ChangeOrderStatusFromDeadlineResult | ChangeProductionStatusFromDeadlineResult {
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
        typeof stored.deadlineSkipReason === 'string' ? stored.deadlineSkipReason : defaultSkipReason,
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

export async function loadOrderAssignedUserIds(
  tx: TransactionClient,
  orderId: number,
): Promise<string[]> {
  const result = await tx.query<{ user_id: string | number }>(
    `
    SELECT DISTINCT u.user_id
    FROM order_workshops ow
    JOIN users u ON u.employee_id = ow.responsible_employee_id
    WHERE ow.order_id = $1
      AND ow.delete_flag = false
      AND ow.responsible_employee_id IS NOT NULL
      AND u.is_active = true
    ORDER BY u.user_id
    `,
    [orderId],
  );
  return result.rows.map((row) => String(row.user_id));
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

async function readOrderVersion(tx: TransactionClient, orderId: number): Promise<number> {
  const result = await tx.query<VersionRow>(
    'SELECT version FROM orders WHERE order_id = $1',
    [orderId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ProductionActionOrderNotFoundError(orderId);
  }
  return toNumber(row.version);
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

async function cascadeProductionStatusToDetails(
  tx: TransactionClient,
  order: LockedOrder,
  productionStatusId: number,
): Promise<ProductionStatusCascadeResult | null> {
  const beforeDetails = await loadDetailProductionStatusSnapshot(tx, order.orderId);
  const allActiveDetailsAlreadyTarget =
    beforeDetails.detailIds.length === 0 ||
    beforeDetails.statusDistribution[String(productionStatusId)] === beforeDetails.detailIds.length;

  if (
    order.productionStatusId === productionStatusId &&
    allActiveDetailsAlreadyTarget &&
    order.productionStatusFromDetailsEnabled
  ) {
    return null;
  }

  await ensureProductionStatusFromDetailsEnabled(tx, order.orderId);

  const updated = await tx.query<{ detail_id: string | number }>(
    `
    UPDATE order_details
    SET production_status_id = $2,
        updated_at = now()
    WHERE order_id = $1
      AND COALESCE(delete_flag, false) = false
      AND production_status_id IS DISTINCT FROM $2
    RETURNING detail_id
    `,
    [order.orderId, productionStatusId],
  );

  if (beforeDetails.detailIds.length > 0) {
    await runRecalcOrderProductionStatus(tx, order.orderId);
  }

  const bumped = await bumpOrderProductionStatusCascadeVersion(
    tx,
    order.orderId,
    beforeDetails.detailIds.length === 0,
    productionStatusId,
  );
  const afterDetails = await loadDetailProductionStatusSnapshot(tx, order.orderId);

  return {
    beforeDetails,
    afterDetails,
    affectedDetailIds: updated.rows.map((row) => toNumber(row.detail_id)),
    nextProductionStatusId: bumped.productionStatusId,
    nextProductionStatusFromDetailsEnabled: true,
    nextVersion: bumped.version,
  };
}

async function enableAutoProductionStatus(tx: TransactionClient, orderId: number): Promise<number> {
  const result = await tx.query<VersionRow>(
    `
    UPDATE orders
    SET production_status_from_details_enabled = true,
        version = version + 1
    WHERE order_id = $1
    RETURNING version
    `,
    [orderId],
  );

  return toNumber(result.rows[0].version);
}

async function ensureProductionStatusFromDetailsEnabled(
  tx: TransactionClient,
  orderId: number,
): Promise<void> {
  await tx.query(
    `
    UPDATE orders
    SET production_status_from_details_enabled = true
    WHERE order_id = $1
      AND production_status_from_details_enabled IS DISTINCT FROM true
    `,
    [orderId],
  );
}

async function bumpOrderProductionStatusCascadeVersion(
  tx: TransactionClient,
  orderId: number,
  forceProductionStatus: boolean,
  productionStatusId: number,
): Promise<{ version: number; productionStatusId: number | null }> {
  const result = await tx.query<{
    version: string | number;
    production_status_id: string | number | null;
  }>(
    `
    UPDATE orders
    SET production_status_id = CASE WHEN $2 THEN $3 ELSE production_status_id END,
        production_status_from_details_enabled = true,
        version = version + 1,
        updated_at = now()
    WHERE order_id = $1
    RETURNING version, production_status_id
    `,
    [orderId, forceProductionStatus, productionStatusId],
  );
  const row = result.rows[0];
  return {
    version: toNumber(row.version),
    productionStatusId:
      row.production_status_id === null ? null : toNumber(row.production_status_id),
  };
}

async function runRecalcOrderProductionStatus(tx: TransactionClient, orderId: number): Promise<void> {
  await tx.query('SELECT recalc_order_production_status($1)', [orderId]);
}

// Locks all live details of the order FOR UPDATE in ascending detail_id order. Called AFTER the
// parent order row is locked, so the batch follows the same order-before-detail lock discipline as
// the order-level production commands (changeProductionStatus / restoreAuto / enterManual /
// *FromDeadline, which all loadOrderForUpdate then loadDetailProductionStatusSnapshot FOR UPDATE).
//
// Lock-ordering debt: the detail-stage command (activate/deactivateDetailProductionStage) locks in
// the OPPOSITE order (detail-before-order, via its `order_details JOIN orders ... FOR UPDATE`). A
// concurrent batch (or any order-level command) and detail-stage on the SAME order can therefore
// deadlock — Postgres aborts one with 40P01, and this command's idempotencyKey makes a retry safe.
// This is a PRE-EXISTING family-wide inconsistency (changeProductionStatus<->detail-stage already
// cycles the same way); the batch adds no new deadlock class. Unifying the whole family onto one
// lock order is deferred to a follow-up (see docs follow-up note). Ascending detail_id avoids
// batch<->batch / batch<->order-level cycles on overlapping detail sets.
async function loadOrderDetailsForBatch(
  tx: TransactionClient,
  orderId: number,
): Promise<Array<{ detailId: number; productionStatusId: number | null }>> {
  const result = await tx.query<{
    detail_id: string | number;
    production_status_id: string | number | null;
  }>(
    `
    SELECT detail_id, production_status_id
    FROM order_details
    WHERE order_id = $1
      AND COALESCE(delete_flag, false) = false
    ORDER BY detail_id
    FOR UPDATE
    `,
    [orderId],
  );
  return result.rows.map((row) => ({
    detailId: toNumber(row.detail_id),
    productionStatusId: row.production_status_id === null ? null : toNumber(row.production_status_id),
  }));
}

// Pure helper: status distribution keyed 'null' | String(id) (mirrors loadDetailProductionStatusSnapshot).
function detailStatusDistribution(
  rows: ReadonlyArray<{ productionStatusId: number | null }>,
): Record<string, number> {
  const distribution: Record<string, number> = {};
  for (const row of rows) {
    const key = row.productionStatusId === null ? 'null' : String(row.productionStatusId);
    distribution[key] = (distribution[key] ?? 0) + 1;
  }
  return distribution;
}

// Pure helper: project the after-distribution from the observed before-snapshot plus this command's
// own changes (no second DB read). For each changed detail, decrement its observed old-status bucket
// and increment the target-status bucket.
function projectDistributionAfterChange(
  before: Record<string, number>,
  currentById: ReadonlyMap<number, number | null>,
  changedDetailIds: readonly number[],
  newStatusId: number,
): Record<string, number> {
  const distribution: Record<string, number> = { ...before };
  const newKey = String(newStatusId);
  for (const id of changedDetailIds) {
    const oldStatus = currentById.get(id) ?? null;
    const oldKey = oldStatus === null ? 'null' : String(oldStatus);
    distribution[oldKey] = (distribution[oldKey] ?? 0) - 1;
    if (distribution[oldKey] <= 0) {
      delete distribution[oldKey];
    }
    distribution[newKey] = (distribution[newKey] ?? 0) + 1;
  }
  return distribution;
}

async function loadOrderProductionStatusId(
  tx: TransactionClient,
  orderId: number,
): Promise<number | null> {
  const result = await tx.query<{ production_status_id: string | number | null }>(
    'SELECT production_status_id FROM orders WHERE order_id = $1 AND delete_flag = false',
    [orderId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return toNullableNumber(row.production_status_id);
}

async function loadDetailProductionStatusMap(
  tx: TransactionClient,
  orderId: number,
): Promise<Map<number, number | null>> {
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

  const map = new Map<number, number | null>();
  for (const row of result.rows) {
    map.set(toNumber(row.detail_id), toNullableNumber(row.production_status_id));
  }
  return map;
}

function computeAffectedDetailIds(
  before: Map<number, number | null>,
  after: Map<number, number | null>,
): number[] {
  const ids: number[] = [];
  const allIds = new Set([...before.keys(), ...after.keys()]);
  for (const id of allIds) {
    if (before.get(id) !== after.get(id)) {
      ids.push(id);
    }
  }
  return ids.sort((a, b) => a - b);
}

function detailMapToDistribution(map: Map<number, number | null>): Record<string, number> {
  const distribution: Record<string, number> = {};
  for (const statusId of map.values()) {
    const key = statusId === null ? 'null' : String(statusId);
    distribution[key] = (distribution[key] ?? 0) + 1;
  }
  return distribution;
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
  return auditService.record(tx, {
    event: input.event,
    entityType: input.entityType ?? 'order',
    entityId: input.entityId ?? String(input.order.orderId),
    actorUserId: input.actorUserId ?? input.currentUser?.id ?? null,
    actorUsername: input.currentUser?.username ?? null,
    actorRole: input.currentUser?.role ?? null,
    requestId: input.requestId,
    source: input.source,
    relatedOrderId: input.order.orderId,
    relatedClientId: input.order.clientId ?? null,
    relatedProductionEventId: input.relatedProductionEventId ?? null,
    statusField: input.statusField ?? null,
    statusId: input.statusId ?? null,
    statusName: input.statusName ?? null,
    statusCode: input.statusCode ?? null,
    stageCode: input.stageCode ?? null,
    before: input.beforeJson,
    after: input.afterJson,
    diff: input.diffJson,
    metadata: input.metadataJson,
  });
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

async function evaluateMdfBoardLaminatedBathAutomationForDetails(
  tx: TransactionClient,
  input: {
    detailIds: number[];
    actor: CurrentUser;
    requestId: string;
    sourceIdempotencyKey: string;
  },
): Promise<void> {
  const detailIds = Array.from(new Set(input.detailIds.filter((detailId) => Number.isSafeInteger(detailId) && detailId > 0)))
    .sort((left, right) => left - right);
  if (detailIds.length === 0) return;

  const rows = await loadMdfLaminatedBathAutomationRows(tx, detailIds);
  const orderIdsByCutResult = new Map<number, Set<number>>();
  for (const row of rows) {
    const cutResultId = toNumber(row.cut_result_id);
    const orderId = toNumber(row.order_id);
    const orderIds = orderIdsByCutResult.get(cutResultId) ?? new Set<number>();
    orderIds.add(orderId);
    orderIdsByCutResult.set(cutResultId, orderIds);
  }

  for (const [cutResultId, orderIds] of orderIdsByCutResult) {
    await evaluateMdfBoardColumnAutomationInTransaction(tx, {
      eventType: 'mdf.board.baths_laminated',
      orderIds,
      actor: input.actor,
      requestId: input.requestId,
      sourceIdempotencyKey: `${input.sourceIdempotencyKey}:mdf-board:bath:cut-result-${cutResultId}:baths_laminated`,
    });
  }
}

async function loadMdfLaminatedBathAutomationRows(
  tx: TransactionClient,
  detailIds: number[],
): Promise<MdfLaminatedBathAutomationRow[]> {
  const result = await tx.query<MdfLaminatedBathAutomationRow>(
    `
    WITH laminated_status_threshold AS (
      SELECT COALESCE(
        MIN(ps.sort_order) FILTER (
          WHERE lower(trim(COALESCE(ps.production_status_code, ''))) = 'laminated'
        ),
        MIN(ps.sort_order) FILTER (
          WHERE lower(trim(ps.production_status_name)) = 'закатан'
        )
      ) AS sort_order
      FROM production_statuses ps
    ),
    changed_jobs AS (
      SELECT DISTINCT result.cut_job_id
      FROM cut_result_placement placement
      JOIN cut_result result
        ON result.cut_result_id = placement.cut_result_id
      WHERE placement.order_detail_id = ANY($1::bigint[])
    ),
    candidate_vacuum_results AS (
      SELECT
        result.cut_result_id,
        result.cut_job_id,
        result.result_no,
        result.revision_no,
        result.created_at AS result_created_at,
        (current_result.result_no = result.result_no) AS is_current_result
      FROM cut_result result
      JOIN changed_jobs changed
        ON changed.cut_job_id = result.cut_job_id
      JOIN cut_job job
        ON job.cut_job_id = result.cut_job_id
      LEFT JOIN cut_result current_result
        ON current_result.cut_result_id = job.current_cut_result_id
      LEFT JOIN cut_param_profiles profile
        ON profile.cut_param_profile_id = job.param_profile_id
      LEFT JOIN cut_result_archive_state archive
        ON archive.cut_job_id = result.cut_job_id
       AND archive.result_no = result.result_no
      WHERE result.snapshot_job IS NOT NULL
        AND job.status <> 'archived'
        AND COALESCE(profile.params ->> 'layout_mode', job.params ->> 'layout_mode') = 'vacuum_table'
        AND archive.archived_at IS NULL
    ),
    latest_vacuum_results AS (
      SELECT DISTINCT ON (candidate.cut_job_id)
        candidate.cut_result_id,
        candidate.cut_job_id
      FROM candidate_vacuum_results candidate
      ORDER BY
        candidate.cut_job_id,
        candidate.is_current_result DESC,
        candidate.result_created_at DESC,
        candidate.result_no DESC,
        candidate.revision_no DESC,
        candidate.cut_result_id DESC
    ),
    result_details AS (
      SELECT DISTINCT
        latest.cut_result_id,
        placement.order_id,
        placement.order_detail_id
      FROM latest_vacuum_results latest
      JOIN cut_result_placement placement
        ON placement.cut_result_id = latest.cut_result_id
      JOIN orders order_row
        ON order_row.order_id = placement.order_id
       AND COALESCE(order_row.delete_flag, false) = false
      JOIN order_details detail
        ON detail.detail_id = placement.order_detail_id
       AND COALESCE(detail.delete_flag, false) = false
    ),
    completed_quantities AS (
      SELECT
        item.match_detail_id::bigint AS order_detail_id,
        SUM(
          CASE
            WHEN NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(packet.comments_json) AS packet_comment(comment_text)
              WHERE lower(packet_comment.comment_text) LIKE ANY (
                ARRAY['%hdf%', '%хдф%', '%лдсп%', '%ldsp%', '%fanera%', '%фанера%']
              )
            )
              AND (packet.completion_status = 'completed' OR packet.thumbs_up = true)
              THEN GREATEST(item.quantity, 0)
            ELSE 0
          END
        )::integer AS completed_quantity
      FROM cnc_telegram_packets packet
      JOIN cnc_telegram_packet_items item
        ON item.packet_id = packet.packet_id
      JOIN result_details detail
        ON detail.order_detail_id = item.match_detail_id
      WHERE item.match_status = 'matched'
        AND item.match_detail_id IS NOT NULL
      GROUP BY item.match_detail_id
    ),
    detail_state AS (
      SELECT
        placement.cut_result_id,
        placement.order_id,
        placement.order_detail_id,
        COUNT(*)::integer AS quantity,
        COALESCE(completed.completed_quantity, 0)::integer AS completed_quantity,
        CASE
          WHEN detail_status.sort_order IS NOT NULL
            AND laminated_status.sort_order IS NOT NULL
            THEN detail_status.sort_order >= laminated_status.sort_order
          ELSE false
        END AS laminated_or_later
      FROM result_details result_detail
      JOIN cut_result_placement placement
        ON placement.cut_result_id = result_detail.cut_result_id
       AND placement.order_id = result_detail.order_id
       AND placement.order_detail_id = result_detail.order_detail_id
      JOIN order_details detail
        ON detail.detail_id = placement.order_detail_id
       AND COALESCE(detail.delete_flag, false) = false
      LEFT JOIN production_statuses detail_status
        ON detail_status.production_status_id = detail.production_status_id
      CROSS JOIN laminated_status_threshold laminated_status
      LEFT JOIN completed_quantities completed
        ON completed.order_detail_id = placement.order_detail_id
      GROUP BY
        placement.cut_result_id,
        placement.order_id,
        placement.order_detail_id,
        completed.completed_quantity,
        detail_status.sort_order,
        laminated_status.sort_order
    )
    SELECT DISTINCT state.cut_result_id, state.order_id
    FROM detail_state state
    WHERE NOT EXISTS (
      SELECT 1
      FROM detail_state candidate
      WHERE candidate.cut_result_id = state.cut_result_id
        AND (
          candidate.completed_quantity < candidate.quantity
          OR candidate.laminated_or_later = false
        )
    )
    ORDER BY state.cut_result_id, state.order_id
    `,
    [detailIds],
  );
  return result.rows;
}

async function evaluateStatusAutomationInTransaction(
  tx: TransactionClient,
  event: StatusAutomationEvent,
): Promise<void> {
  const { evaluateStatusAutomation } = await import(
    '../../status-automation/application/status-automation-runtime'
  );
  await evaluateStatusAutomation(tx, event);
}

async function evaluateMdfBoardColumnAutomationInTransaction(
  tx: TransactionClient,
  input: MdfBoardColumnAutomationInput,
): Promise<void> {
  const { evaluateMdfBoardColumnAutomation } = await import(
    '../../status-automation/application/status-automation-runtime'
  );
  await evaluateMdfBoardColumnAutomation(tx, input);
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
