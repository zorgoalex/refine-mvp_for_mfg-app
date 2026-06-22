import { ApiError } from '../../../common/errors/api-error';
import { OrderAccessPolicy } from '../../../permissions/policies/order-access.policy';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  CreateOrderCommand,
  DeleteOrderCommand,
  DetailSheetAuditRef,
  OrderDeadlineSyncPort,
  OrderChildReference,
  OrderSaveAuditMetadata,
  LockedOrderRow,
  OrderPermissionCheckerPort,
  OrderTransactionManagerPort,
  OrderWriteUnitOfWork,
  UpdateOrderCommand,
} from './order-transaction.types';
import type { DeleteOrderResponseDto, OrderDto } from '../dto/order.dto';
import type {
  CalculatedOrderDetailDto,
  NormalizedSaveOrderDto,
  PreparedOrderSave,
} from '../dto/save-order.dto';
import type { CurrentUser } from '../../../permissions/current-user';
import { OrderNotFoundError, OrderVersionConflictError } from '../errors/order.errors';
import { prepareOrderSave } from '../domain/order-save-preparer';
import {
  assertSheetEligibilityAndNoClear,
  orderTouchesSheet,
  type SheetValidationDetail,
  type SheetValidationHeader,
} from '../domain/sheet-order-validation';

interface StoredSheetSummary {
  eligible: boolean;
  headerSheetId: number | null;
  detailSheetIds: ReadonlyArray<{ detailId: number; sheetMaterialTypeId: number | null }>;
}

function actorUserIdOf(currentUser: CurrentUser): number | null {
  const parsed = Number(currentUser.id);
  return Number.isFinite(parsed) ? parsed : null;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toSheetHeader(order: NormalizedSaveOrderDto): SheetValidationHeader {
  return {
    sheetMaterialTypeId: order.header.sheetMaterialTypeId ?? null,
    materialId: order.header.materialId ?? null,
  };
}

function toSheetDetails(details: readonly CalculatedOrderDetailDto[]): SheetValidationDetail[] {
  return details.map((detail, index) => ({
    label: `details[${index}]`,
    detailId: detail.id,
    sheetMaterialTypeId: detail.sheetMaterialTypeId ?? null,
    materialId: detail.materialId ?? null,
    height: detail.height,
    width: detail.width,
  }));
}

function toAfterDetailRefs(details: readonly CalculatedOrderDetailDto[]): DetailSheetAuditRef[] {
  return details.map((detail) => ({
    detailId: detail.id,
    tempKey: detail.id === undefined ? detail.clientKey : undefined,
    sheetMaterialTypeId: detail.sheetMaterialTypeId ?? null,
  }));
}

function toBeforeDetailRefs(
  stored: ReadonlyArray<{ detailId: number; sheetMaterialTypeId: number | null }>,
): DetailSheetAuditRef[] {
  return stored.map((row) => ({
    detailId: row.detailId,
    sheetMaterialTypeId: row.sheetMaterialTypeId,
  }));
}

function collectSheetMaterialTypeIds(
  headerSheetId: number | null | undefined,
  details: ReadonlyArray<{ sheetMaterialTypeId?: number | null }>,
  storedDetailIds?: ReadonlyArray<{ sheetMaterialTypeId: number | null }>,
): number[] {
  const ids = new Set<number>();
  if (headerSheetId != null) ids.add(headerSheetId);
  for (const d of details) {
    if (d.sheetMaterialTypeId != null) ids.add(d.sheetMaterialTypeId);
  }
  for (const d of storedDetailIds ?? []) {
    if (d.sheetMaterialTypeId != null) ids.add(d.sheetMaterialTypeId);
  }
  return [...ids];
}

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
      this.requirePermission(command, 'orders.view_financials');
      this.requireFinancePermissionForPaymentMutations(command, prepared.order);

      // New orders are SP3-era (sheet_eligible default true): eligible, no stored sheet state.
      const touchesSheet = await this.enforceSheetGuards(unitOfWork, command, prepared, {
        eligible: true,
        headerSheetId: null,
        detailSheetIds: [],
      });

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
      const afterSnapshot = await unitOfWork.loadOrderHeaderSnapshot(orderId);
      await unitOfWork.writeAuditEvent({
        action: 'orders.create',
        orderId,
        actorUserId: command.currentUser.id,
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        clientId: prepared.order.header.clientId ?? null,
        requestId: command.requestId,
        before: null,
        after: afterSnapshot,
        metadata: this.buildSaveMetadata(
          'orders.create',
          command.requestId,
          touchesSheet ? { before: [], after: toAfterDetailRefs(prepared.details) } : undefined,
        ),
        relatedSheetMaterialTypeIds: collectSheetMaterialTypeIds(
          prepared.order.header.sheetMaterialTypeId,
          prepared.details,
        ),
      });

      return this.readAndAssertVersion(unitOfWork, orderId, version, command);
    });

    await this.ports.deadlineSync?.syncOrderDeadlinesAfterSave({
      orderId: order.header.orderId,
      currentUser: command.currentUser,
      eventType: 'ORDER_CREATED',
      requestId: command.requestId,
    });

    return order;
  }

  async update(command: UpdateOrderCommand): Promise<OrderDto> {
    const order = await this.ports.transactions.runInTransaction(async (unitOfWork) => {
      await unitOfWork.setSessionUser(command.currentUser.id);
      this.requirePermission(command, 'orders.update');
      this.requirePermission(command, 'orders.view_financials');

      const lockedOrder = await unitOfWork.loadOrderForUpdate(command.orderId);

      if (!lockedOrder) {
        throw new OrderNotFoundError(command.orderId);
      }

      this.requireUpdateScope(command, lockedOrder);

      const clientVersion = this.extractClientVersion(command.dto.version, lockedOrder.version);

      if (clientVersion !== lockedOrder.version) {
        throw new OrderVersionConflictError(lockedOrder.version, clientVersion);
      }

      const prepared = prepareOrderSave({ ...command.dto, version: clientVersion }, {
        mode: 'update',
        pathOrderId: command.orderId,
      });
      this.requireFinancePermissionForPaymentMutations(command, prepared.order);
      const beforeSnapshot = await unitOfWork.loadOrderHeaderSnapshot(command.orderId);

      // SP3 stored sheet state. Only sheet-eligible orders can carry sheet details, so
      // read stored details ONLY when eligible — legacy updates take no extra query and
      // skip the sheet path entirely.
      const storedEligible = (beforeSnapshot as Record<string, unknown> | null)?.sheetEligible === true;
      const storedHeaderSheetId = numOrNull(
        (beforeSnapshot as Record<string, unknown> | null)?.sheetMaterialTypeId,
      );
      let storedDetailSheetIds: ReadonlyArray<{
        detailId: number;
        sheetMaterialTypeId: number | null;
      }> = [];
      if (storedEligible) {
        const storedState = await unitOfWork.loadStoredOrderSheetState(command.orderId);
        storedDetailSheetIds = storedState.detailSheetIds;
      }
      const touchesSheet = await this.enforceSheetGuards(unitOfWork, command, prepared, {
        eligible: storedEligible,
        headerSheetId: storedHeaderSheetId,
        detailSheetIds: storedDetailSheetIds,
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
      const afterSnapshot = await unitOfWork.loadOrderHeaderSnapshot(command.orderId);
      await unitOfWork.writeAuditEvent({
        action: 'orders.update',
        orderId: command.orderId,
        actorUserId: command.currentUser.id,
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        clientId: prepared.order.header.clientId ?? null,
        requestId: command.requestId,
        before: beforeSnapshot,
        after: afterSnapshot,
        metadata: this.buildSaveMetadata(
          'orders.update',
          command.requestId,
          touchesSheet
            ? { before: toBeforeDetailRefs(storedDetailSheetIds), after: toAfterDetailRefs(prepared.details) }
            : undefined,
        ),
        relatedSheetMaterialTypeIds: collectSheetMaterialTypeIds(
          prepared.order.header.sheetMaterialTypeId,
          prepared.details,
          storedDetailSheetIds,
        ),
      });

      return this.readAndAssertVersion(unitOfWork, command.orderId, version, command);
    });

    await this.ports.deadlineSync?.syncOrderDeadlinesAfterSave({
      orderId: command.orderId,
      currentUser: command.currentUser,
      eventType: 'ORDER_UPDATED',
      requestId: command.requestId,
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
    command: Pick<CreateOrderCommand | UpdateOrderCommand, 'currentUser'>,
  ): Promise<OrderDto> {
    const order = await unitOfWork.readOrder(orderId);

    if (order.version !== version) {
      throw new ApiError(500, 'ORDER_SAVE_FAILED', 'Не удалось сохранить заказ');
    }

    if (this.permissions.canUser(command.currentUser, 'payments.view')) {
      return order;
    }

    return {
      ...order,
      payments: [],
    };
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
    permission: PermissionName,
  ): void {
    if (!this.permissions.canUser(command.currentUser, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }

  /**
   * SP3 sheet guards. Runs ONLY when the save touches the sheet path (incoming OR stored
   * sheet id) so legacy orders are untouched. Order: permission → eligibility/no-clear →
   * tx-scoped reference validation → save-context for shadow audit. Returns whether the
   * sheet path is active (drives audit metadata).
   */
  private async enforceSheetGuards(
    unitOfWork: OrderWriteUnitOfWork,
    command: { currentUser: CurrentUser; requestId?: string },
    prepared: PreparedOrderSave,
    stored: StoredSheetSummary,
  ): Promise<boolean> {
    const header = toSheetHeader(prepared.order);
    const details = toSheetDetails(prepared.details);
    const touchesSheet = orderTouchesSheet({
      header,
      details,
      storedHeaderSheetId: stored.headerSheetId,
      storedDetailSheetIds: stored.detailSheetIds,
    });
    if (!touchesSheet) {
      // SECURITY: even a legacy-looking save must not smuggle a shadow material_id with a
      // null sheet id (would forge Variant-A sheet semantics outside the command boundary).
      // Anti-injection runs on EVERY save; the full sheet path (existence/dim/eligibility)
      // stays gated below.
      await unitOfWork.validateNoShadowInjection({ header, details });
      return false;
    }
    // SECURITY: any incoming OR stored sheet id requires sheet_materials.view (FE gating
    // is not a boundary). Reject BEFORE any write.
    this.requirePermission(command, 'sheet_materials.view');
    assertSheetEligibilityAndNoClear({
      eligible: stored.eligible,
      storedHeaderSheetId: stored.headerSheetId,
      storedDetailSheetIds: stored.detailSheetIds,
      header,
      details,
    });
    await unitOfWork.validateSheetReferences({ header, details });
    // VARIANT B: shadow save-context no longer needed — material_id is always NULL for
    // order rows and resolveShadowMaterialId is never called. setSaveContext is retained
    // on the interface as a no-op (dead after shadow removal — delete in follow-up).
    return true;
  }

  private buildSaveMetadata(
    commandName: 'orders.create' | 'orders.update',
    requestId: string | undefined,
    detailSheetMaterialTypeIds?: { before: DetailSheetAuditRef[]; after: DetailSheetAuditRef[] },
  ): OrderSaveAuditMetadata {
    return {
      commandName,
      ...(requestId ? { requestId } : {}),
      ...(detailSheetMaterialTypeIds ? { detailSheetMaterialTypeIds } : {}),
    };
  }

  private requireFinancePermissionForPaymentMutations(
    command: Pick<CreateOrderCommand | UpdateOrderCommand, 'currentUser'>,
    order: NormalizedSaveOrderDto,
  ): void {
    const createsPayment = order.payments.some((payment) => payment.id === undefined);
    const updatesPayment = order.payments.some((payment) => payment.id !== undefined);
    const deletesPayment = (order.deleted.paymentIds?.length ?? 0) > 0;
    const updatesPaymentStatus = order.header.paymentStatusId !== undefined;
    const carriesFinancialFields = orderCarriesFinancialFields(order);

    if (!createsPayment && !updatesPayment && !deletesPayment && !carriesFinancialFields) {
      return;
    }

    this.requirePermission(command, 'orders.view_financials');

    if (createsPayment) {
      this.requirePermission(command, 'payments.create');
    }
    if (updatesPayment || updatesPaymentStatus) {
      this.requirePermission(command, 'payments.update');
    }
    if (deletesPayment) {
      this.requirePermission(command, 'payments.delete');
    }
  }

  private requireUpdateScope(command: Pick<UpdateOrderCommand, 'currentUser'>, order: LockedOrderRow): void {
    if (
      !this.orderAccessPolicy.canUpdate(command.currentUser, {
        orderId: order.orderId,
        createdByUserId: order.createdByUserId,
        managerUserId: order.managerUserId,
      })
    ) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['orders.update'],
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

function orderCarriesFinancialFields(order: NormalizedSaveOrderDto): boolean {
  return (
    order.header.discount !== 0 ||
    order.header.surcharge !== 0 ||
    order.header.paymentStatusId !== undefined ||
    order.header.paymentDate !== undefined ||
    order.details.some((detail) => detail.millingCostPerSqm !== null || detail.detailCost !== null) ||
    order.requirements.some((requirement) => requirement.purchasePrice !== null)
  );
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
