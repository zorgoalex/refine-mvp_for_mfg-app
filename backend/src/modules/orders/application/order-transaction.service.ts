import { ApiError } from '../../../common/errors/api-error';
import { OrderAccessPolicy } from '../../../permissions/policies/order-access.policy';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  CreateOrderCommand,
  DeleteOrderCommand,
  OrderDeadlineSyncPort,
  OrderChildReference,
  OrderPermissionCheckerPort,
  OrderTransactionManagerPort,
  OrderWriteUnitOfWork,
  UpdateOrderCommand,
} from './order-transaction.types';
import type { DeleteOrderResponseDto, OrderDto } from '../dto/order.dto';
import type { NormalizedSaveOrderDto, PreparedOrderSave } from '../dto/save-order.dto';
import { OrderNotFoundError, OrderVersionConflictError } from '../errors/order.errors';
import { prepareOrderSave } from '../domain/order-save-preparer';

export interface OrderTransactionServicePorts {
  transactions: OrderTransactionManagerPort;
  permissions?: OrderPermissionCheckerPort;
  deadlineSync?: OrderDeadlineSyncPort;
}

export class OrderTransactionService {
  private readonly permissions: OrderPermissionCheckerPort;
  private readonly orderAccessPolicy = new OrderAccessPolicy();

  constructor(private readonly ports: OrderTransactionServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async create(command: CreateOrderCommand): Promise<OrderDto> {
    const prepared = prepareOrderSave(command.dto, { mode: 'create' });

    const order = await this.ports.transactions.runInTransaction(async (unitOfWork) => {
      await unitOfWork.setSessionUser(command.currentUser.id);
      this.requirePermission(command, 'orders.create');

      const orderId = await unitOfWork.createOrderHeader({
        header: prepared.order.header,
        totals: prepared.totals,
        currentUser: command.currentUser,
      });

      await this.persistChildren(unitOfWork, orderId, prepared);
      const version = await unitOfWork.updateOrderTotalsAndVersion({
        orderId,
        totals: prepared.totals,
        previousVersion: null,
        currentUser: command.currentUser,
      });
      await unitOfWork.writeAuditEvent({
        action: 'orders.create',
        orderId,
        actorUserId: command.currentUser.id,
      });

      return this.readAndAssertVersion(unitOfWork, orderId, version);
    });

    await this.ports.deadlineSync?.syncOrderDeadlinesAfterSave({
      orderId: order.header.orderId,
      currentUser: command.currentUser,
      eventType: 'ORDER_CREATED',
    });

    return order;
  }

  async update(command: UpdateOrderCommand): Promise<OrderDto> {
    const order = await this.ports.transactions.runInTransaction(async (unitOfWork) => {
      await unitOfWork.setSessionUser(command.currentUser.id);
      this.requirePermission(command, 'orders.update');

      const lockedOrder = await unitOfWork.loadOrderForUpdate(command.orderId);

      if (!lockedOrder) {
        throw new OrderNotFoundError(command.orderId);
      }

      const clientVersion = this.extractClientVersion(command.dto.version, lockedOrder.version);

      if (clientVersion !== lockedOrder.version) {
        throw new OrderVersionConflictError(lockedOrder.version, clientVersion);
      }

      const prepared = prepareOrderSave({ ...command.dto, version: clientVersion }, {
        mode: 'update',
        pathOrderId: command.orderId,
      });
      await unitOfWork.assertChildOwnership(
        command.orderId,
        collectChildReferences(prepared.order),
      );
      await unitOfWork.updateOrderHeader({
        orderId: command.orderId,
        header: prepared.order.header,
        totals: prepared.totals,
        currentUser: command.currentUser,
      });
      await this.persistChildren(unitOfWork, command.orderId, prepared);
      const version = await unitOfWork.updateOrderTotalsAndVersion({
        orderId: command.orderId,
        totals: prepared.totals,
        previousVersion: lockedOrder.version,
        currentUser: command.currentUser,
      });
      await unitOfWork.writeAuditEvent({
        action: 'orders.update',
        orderId: command.orderId,
        actorUserId: command.currentUser.id,
      });

      return this.readAndAssertVersion(unitOfWork, command.orderId, version);
    });

    await this.ports.deadlineSync?.syncOrderDeadlinesAfterSave({
      orderId: command.orderId,
      currentUser: command.currentUser,
      eventType: 'ORDER_UPDATED',
    });

    return order;
  }

  async delete(command: DeleteOrderCommand): Promise<DeleteOrderResponseDto> {
    return this.ports.transactions.runInTransaction(async (unitOfWork) => {
      await unitOfWork.setSessionUser(command.currentUser.id);

      const requestId = command.requestId ?? 'order-delete-command';
      const idempotency = await unitOfWork.reconcileOrderDeleteIdempotency(command);
      if (idempotency.completedResponse) {
        return idempotency.completedResponse;
      }

      const lockedOrder = await unitOfWork.loadOrderForDelete(command.orderId);

      if (!lockedOrder) {
        throw new OrderNotFoundError(command.orderId);
      }

      this.requireDeletePermission(command, lockedOrder);

      if (command.version !== lockedOrder.version) {
        throw new OrderVersionConflictError(lockedOrder.version, command.version);
      }

      const nextVersion = await unitOfWork.softDeleteOrder({
        orderId: command.orderId,
        previousVersion: lockedOrder.version,
      });
      const auditId = await unitOfWork.writeOrderDeleteAudit({
        currentUser: command.currentUser,
        requestId,
        order: lockedOrder,
        nextVersion,
      });
      await unitOfWork.enqueueOrderDeleteOutbox({
        currentUser: command.currentUser,
        requestId,
        order: lockedOrder,
        nextVersion,
        auditId,
        idempotencyKey: command.idempotencyKey,
      });

      const response: DeleteOrderResponseDto = {
        success: true,
        orderId: command.orderId,
        auditId,
        requestId,
      };
      await unitOfWork.completeOrderDeleteIdempotency(command.idempotencyKey, response);

      return response;
    });
  }

  private async persistChildren(
    unitOfWork: OrderWriteUnitOfWork,
    orderId: number,
    prepared: PreparedOrderSave,
  ): Promise<void> {
    await unitOfWork.upsertDetails(orderId, prepared.details);
    await unitOfWork.deleteDetails(orderId, prepared.order.deleted.detailIds);
    await unitOfWork.upsertPayments(orderId, prepared.order.payments);
    await unitOfWork.deletePayments(orderId, prepared.order.deleted.paymentIds);
    await unitOfWork.deleteWorkshops(orderId, prepared.order.deleted.workshopIds);
    await unitOfWork.upsertWorkshops(orderId, prepared.order.workshops);
    await unitOfWork.deleteRequirements(orderId, prepared.order.deleted.requirementIds);
    await unitOfWork.upsertRequirements(orderId, prepared.order.requirements);
    await unitOfWork.deleteDowelingLinks(orderId, prepared.order.deleted.dowelingLinkIds);
    await unitOfWork.upsertDowelingLinks(orderId, prepared.order.dowelingLinks);
  }

  private async readAndAssertVersion(
    unitOfWork: OrderWriteUnitOfWork,
    orderId: number,
    version: number,
  ): Promise<OrderDto> {
    const order = await unitOfWork.readOrder(orderId);

    if (order.version !== version) {
      throw new ApiError(500, 'ORDER_SAVE_FAILED', 'Не удалось сохранить заказ');
    }

    return order;
  }

  private extractClientVersion(version: unknown, lockedVersion: number): number {
    if ((version === null || version === undefined) && lockedVersion === 0) {
      return 0;
    }

    if (!Number.isInteger(version) || Number(version) < 0) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Order payload validation failed', {
        errors: [{ field: 'version', message: 'version must be a non-negative integer' }],
      });
    }

    return Number(version);
  }

  private requirePermission(
    command: Pick<CreateOrderCommand | UpdateOrderCommand, 'currentUser'>,
    permission: 'orders.create' | 'orders.update',
  ): void {
    if (!this.permissions.canUser(command.currentUser, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }

  private requireDeletePermission(
    command: Pick<DeleteOrderCommand, 'currentUser'>,
    order: {
      orderId: number;
      createdByUserId: string | null;
      managerUserId: string | null;
    },
  ): void {
    if (
      !this.orderAccessPolicy.canDelete(command.currentUser, {
        orderId: order.orderId,
        createdByUserId: order.createdByUserId,
        managerUserId: order.managerUserId,
      })
    ) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['orders.delete'],
      });
    }
  }
}

export function collectChildReferences(order: NormalizedSaveOrderDto): OrderChildReference[] {
  return [
    ...order.details
      .filter((detail) => detail.id !== undefined)
      .map((detail) => ({ entityType: 'detail' as const, id: detail.id as number })),
    ...order.deleted.detailIds.map((id) => ({ entityType: 'detail' as const, id })),
    ...order.payments
      .filter((payment) => payment.id !== undefined)
      .map((payment) => ({ entityType: 'payment' as const, id: payment.id as number })),
    ...order.deleted.paymentIds.map((id) => ({ entityType: 'payment' as const, id })),
    ...order.workshops
      .filter((workshop) => workshop.id !== undefined)
      .map((workshop) => ({ entityType: 'workshop' as const, id: workshop.id as number })),
    ...order.deleted.workshopIds.map((id) => ({ entityType: 'workshop' as const, id })),
    ...order.requirements
      .filter((requirement) => requirement.id !== undefined)
      .map((requirement) => ({
        entityType: 'requirement' as const,
        id: requirement.id as number,
      })),
    ...order.deleted.requirementIds.map((id) => ({ entityType: 'requirement' as const, id })),
    ...order.dowelingLinks
      .filter((link) => link.id !== undefined)
      .map((link) => ({ entityType: 'dowelingLink' as const, id: link.id as number })),
    ...order.deleted.dowelingLinkIds.map((id) => ({ entityType: 'dowelingLink' as const, id })),
  ];
}
