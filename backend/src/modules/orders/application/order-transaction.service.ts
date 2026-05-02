import { ApiError } from '../../../common/errors/api-error';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  CreateOrderCommand,
  OrderDeadlineSyncPort,
  OrderChildReference,
  OrderPermissionCheckerPort,
  OrderTransactionManagerPort,
  OrderWriteUnitOfWork,
  UpdateOrderCommand,
} from './order-transaction.types';
import type { OrderDto } from '../dto/order.dto';
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

      const clientVersion = this.extractClientVersion(command.dto.version);

      if (clientVersion !== lockedOrder.version) {
        throw new OrderVersionConflictError(lockedOrder.version, clientVersion);
      }

      const prepared = prepareOrderSave(command.dto, {
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

  private async persistChildren(
    unitOfWork: OrderWriteUnitOfWork,
    orderId: number,
    prepared: PreparedOrderSave,
  ): Promise<void> {
    await unitOfWork.upsertDetails(orderId, prepared.details);
    await unitOfWork.deleteDetails(orderId, prepared.order.deleted.detailIds);
    await unitOfWork.upsertPayments(orderId, prepared.order.payments);
    await unitOfWork.deletePayments(orderId, prepared.order.deleted.paymentIds);
    await unitOfWork.upsertWorkshops(orderId, prepared.order.workshops);
    await unitOfWork.deleteWorkshops(orderId, prepared.order.deleted.workshopIds);
    await unitOfWork.upsertRequirements(orderId, prepared.order.requirements);
    await unitOfWork.deleteRequirements(orderId, prepared.order.deleted.requirementIds);
    await unitOfWork.upsertDowelingLinks(orderId, prepared.order.dowelingLinks);
    await unitOfWork.deleteDowelingLinks(orderId, prepared.order.deleted.dowelingLinkIds);
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

  private extractClientVersion(version: unknown): number {
    if (!Number.isInteger(version) || Number(version) <= 0) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Order payload validation failed', {
        errors: [{ field: 'version', message: 'version must be a positive integer' }],
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
