import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole, type PermissionName, type UserRole } from '../../../permissions/permissions';
import type { TransactionClient } from '../../../database/database.types';
import type { DeleteOrderResponseDto, OrderDto, RestoreOrderResponseDto } from '../dto/order.dto';
import type {
  CalculatedOrderDetailDto,
  NormalizedSaveOrderDowelingLinkDto,
  NormalizedSaveOrderHeaderDto,
  NormalizedSaveOrderPaymentDto,
  NormalizedSaveOrderRequirementDto,
  NormalizedSaveOrderWorkshopDto,
  OrderTotalsDto,
  SaveOrderDto,
} from '../dto/save-order.dto';
import { OrderNameDuplicateError,
  ChildEntityNotFoundError,
  ChildEntityNotOwnedError,
  OrderRestoreIdempotencyFailedError,
  OrderRestoreIdempotencyInProgressError,
  OrderRestoreIdempotencyKeyReusedError,
  OrderVersionConflictError,
} from '../errors/order.errors';
import { ProjectClientMismatchError } from '../../projects/errors/projects.errors';
import type {
  LockedOrderRow,
  LockedOrderDeleteRow,
  LockedOrderRestoreRow,
  OrderChildReference,
  OrderDeleteAuditInput,
  OrderDeleteIdempotencyResult,
  OrderDeleteOutboxInput,
  OrderRestoreAuditInput,
  OrderRestoreIdempotencyResult,
  OrderRestoreOutboxInput,
  OrderSaveAuditEvent,
  OrderTransactionManagerPort,
  OrderWriteUnitOfWork,
  RestoreOrderCommand,
  SaveContext,
  SheetReferenceValidationInput,
  StoredOrderSheetState,
} from './order-transaction.types';
import { collectChildReferences, OrderTransactionService } from './order-transaction.service';

interface FakeProjectRecord {
  projectId: number;
  code: string;
  clientId: number;
  deleteFlag: boolean;
  version: number;
  editedByUserId: string | null;
}

interface FakeOrderRecord {
  orderId: number;
  header: NormalizedSaveOrderHeaderDto;
  details: CalculatedOrderDetailDto[];
  payments: NormalizedSaveOrderPaymentDto[];
  workshops: NormalizedSaveOrderWorkshopDto[];
  requirements: NormalizedSaveOrderRequirementDto[];
  dowelingLinks: NormalizedSaveOrderDowelingLinkDto[];
  totals: OrderTotalsDto;
  version: number;
  createdByUserId: string | null;
  managerUserId: string | null;
  projectId: number | null;
  projectCode: string | null;
  createdAt: string;
  updatedAt: string;
  deleteFlag: boolean;
  deletedAt: string | null;
  deletedBy: string | null;
}

interface FakeState {
  nextOrderId: number;
  nextProjectId: number;
  nextDetailId: number;
  nextPaymentId: number;
  nextWorkshopId: number;
  nextRequirementId: number;
  nextDowelingLinkId: number;
  orders: Map<number, FakeOrderRecord>;
  projects: Map<number, FakeProjectRecord>;
  auditEvents: Array<
    | OrderSaveAuditEvent
    | { action: 'orders.delete'; orderId: number; actorUserId: string; requestId: string; nextVersion: number }
    | {
        action: 'orders.restore';
        orderId: number;
        actorUserId: string;
        requestId: string;
        nextVersion: number;
        targetOrderName: string;
      }
  >;
  outboxEvents: Array<{ eventType: string; orderId: number; requestId: string; targetOrderName?: string }>;
  deniedRestoreAudits: Array<{ orderId: number; requestId: string; actorUserId: string }>;
}

class FakeOrderTransactions implements OrderTransactionManagerPort {
  calls: string[] = [];
  lockedOrderNames: string[] = [];
  committed = 0;
  rolledBack = 0;
  failAt?: string;
  state: FakeState = {
    nextOrderId: 100,
    nextProjectId: 500,
    nextDetailId: 1000,
    nextPaymentId: 2000,
    nextWorkshopId: 3000,
    nextRequirementId: 4000,
    nextDowelingLinkId: 5000,
    orders: new Map(),
    projects: new Map(),
    auditEvents: [],
    outboxEvents: [],
    deniedRestoreAudits: [],
  };
  completedDeleteResponse?: DeleteOrderResponseDto;
  completedRestoreResponse?: RestoreOrderResponseDto;
  completedCreateResponse?: OrderDto;
  /** Simulates a stale unlocked pre-read diverging from the locked snapshot. */
  preReadClientProjectOverride?: { clientId: number | null; projectId: number };
  lastRestoreIdempotencyInput?: unknown;
  restoreIdempotencyError?: Error;
  failedRestoreIdempotencyMarks: Array<{
    actorUserId: string;
    idempotencyKey: string;
    orderId: number;
    orderName?: string;
  }> = [];
  readonly transactionClient = { query: async () => ({ rows: [], rowCount: 0 }), raw: {} } as TransactionClient;

  async runInTransaction<T>(handler: (unitOfWork: OrderWriteUnitOfWork) => Promise<T>): Promise<T> {
    this.calls.push('begin');
    const working = cloneState(this.state);
    const unitOfWork = new FakeUnitOfWork(this, working);

    try {
      const result = await handler(unitOfWork);
      this.state = working;
      this.committed += 1;
      this.calls.push('commit');
      return result;
    } catch (error) {
      this.rolledBack += 1;
      this.calls.push('rollback');
      throw error;
    }
  }

  seedOrder(record: Partial<FakeOrderRecord> & { orderId: number; version: number }): void {
    const header = createHeader({
      orderId: record.orderId,
      paymentStatusId: record.totals?.paymentStatusId ?? 1,
    });
    const totals = record.totals ?? createTotals();

    this.state.orders.set(record.orderId, {
      orderId: record.orderId,
      header: record.header ?? header,
      details: record.details ?? [],
      payments: record.payments ?? [],
      workshops: record.workshops ?? [],
      requirements: record.requirements ?? [],
      dowelingLinks: record.dowelingLinks ?? [],
      totals,
      version: record.version,
      createdByUserId: record.createdByUserId ?? 'user_manager',
      managerUserId: record.managerUserId ?? 'user_manager',
      projectId: record.projectId ?? null,
      projectCode: record.projectCode ?? null,
      createdAt: record.createdAt ?? '2026-04-30T00:00:00.000Z',
      updatedAt: record.updatedAt ?? '2026-04-30T00:00:00.000Z',
      deleteFlag: record.deleteFlag ?? false,
      deletedAt: record.deletedAt ?? null,
      deletedBy: record.deletedBy ?? null,
    });
  }

  seedProject(record: FakeProjectRecord): void {
    this.state.projects.set(record.projectId, { ...record });
  }

  async markOrderRestoreIdempotencyFailed(command: RestoreOrderCommand): Promise<void> {
    this.calls.push('markOrderRestoreIdempotencyFailed');
    if (this.failAt === 'markOrderRestoreIdempotencyFailed') {
      throw new Error('Injected failure at markOrderRestoreIdempotencyFailed');
    }

    this.failedRestoreIdempotencyMarks.push({
      actorUserId: command.currentUser.id,
      idempotencyKey: command.idempotencyKey,
      orderId: command.orderId,
      orderName: command.orderName,
    });
  }
}

class FakeUnitOfWork implements OrderWriteUnitOfWork {
  constructor(
    private readonly owner: FakeOrderTransactions,
    private readonly state: FakeState,
  ) {}

  async setSessionUser(): Promise<void> {
    this.call('setSessionUser');
  }

  getTransactionClient(): TransactionClient {
    this.call('getTransactionClient');
    return this.owner.transactionClient;
  }

  setSaveContext(_context: SaveContext): void {
    this.call('setSaveContext');
  }

  async loadStoredOrderSheetState(_orderId: number): Promise<StoredOrderSheetState> {
    this.call('loadStoredOrderSheetState');
    // VARIANT B: all orders are sheet-eligible (sheet_eligible=true); every detail uses
    // sheetMaterialTypeId. Existing stored detail sheet ids reflect previously saved data.
    const seededOrder = this.state.orders.get(_orderId);
    const storedDetailSheetIds = seededOrder?.details.map((d) => ({
      detailId: d.id as number,
      sheetMaterialTypeId: (d as typeof d & { sheetMaterialTypeId?: number | null }).sheetMaterialTypeId ?? null,
    })) ?? [];
    return { sheetEligible: true, headerSheetMaterialTypeId: null, detailSheetIds: storedDetailSheetIds };
  }

  async validateSheetReferences(_input: SheetReferenceValidationInput): Promise<void> {
    this.call('validateSheetReferences');
  }

  async validateNoShadowInjection(_input: SheetReferenceValidationInput): Promise<void> {
    this.call('validateNoShadowInjection');
  }

  async reconcileOrderDeleteIdempotency(): Promise<OrderDeleteIdempotencyResult> {
    this.call('reconcileOrderDeleteIdempotency');
    return this.owner.completedDeleteResponse
      ? { completedResponse: this.owner.completedDeleteResponse }
      : {};
  }

  async reconcileOrderRestoreIdempotency(input: unknown): Promise<OrderRestoreIdempotencyResult> {
    this.call('reconcileOrderRestoreIdempotency');
    this.owner.lastRestoreIdempotencyInput = input;
    if (this.owner.restoreIdempotencyError) {
      throw this.owner.restoreIdempotencyError;
    }
    const command = input as RestoreOrderCommand;
    if (
      this.owner.failedRestoreIdempotencyMarks.some(
        (mark) => mark.idempotencyKey === command.idempotencyKey,
      )
    ) {
      throw new OrderRestoreIdempotencyFailedError(command.idempotencyKey);
    }
    return this.owner.completedRestoreResponse
      ? { completedResponse: this.owner.completedRestoreResponse }
      : {};
  }

  async resolveProjectForCreate(input: {
    projectId: number | null;
    clientId: number;
  }): Promise<{ projectId: number; created: boolean; code: string }> {
    this.call('resolveProjectForCreate');

    if (input.projectId !== null) {
      const project = this.state.projects.get(input.projectId);
      if (!project) {
        throw new Error(`Missing fake project ${input.projectId}`);
      }

      return { projectId: project.projectId, created: false, code: project.code };
    }

    const projectId = this.state.nextProjectId++;
    const projectCode = `МП-${projectId}`;
    this.state.projects.set(projectId, {
      projectId,
      code: projectCode,
      clientId: input.clientId,
      deleteFlag: false,
      version: 0,
      editedByUserId: null,
    });
    return { projectId, created: true, code: projectCode };
  }

  async reconcileOrderCreateIdempotency(): Promise<{ completedResponse: OrderDto | null }> {
    this.call('reconcileOrderCreateIdempotency');
    return { completedResponse: this.owner.completedCreateResponse ?? null };
  }

  async completeOrderCreateIdempotency(_idempotencyKey: string, response: OrderDto): Promise<void> {
    this.call('completeOrderCreateIdempotency');
    this.owner.completedCreateResponse = response;
  }

  async completeOrderDeleteIdempotency(): Promise<void> {
    this.call('completeOrderDeleteIdempotency');
  }

  async completeOrderRestoreIdempotency(
    _idempotencyKey: string,
    response: RestoreOrderResponseDto,
  ): Promise<void> {
    this.call('completeOrderRestoreIdempotency');
    this.owner.completedRestoreResponse = response;
  }

  async loadOrderForUpdate(orderId: number): Promise<LockedOrderRow | null> {
    this.call('loadOrderForUpdate');
    const order = this.state.orders.get(orderId);
    return order
      ? {
          orderId,
          orderName: order.header.orderName,
          version: order.version,
          createdByUserId: order.createdByUserId,
          managerUserId: order.managerUserId,
        }
      : null;
  }

  async lockOrderName(_orderName: string): Promise<void> {
    this.call('lockOrderName');
    this.owner.lockedOrderNames.push(_orderName);
  }

  async assertOrderNameAvailable(input: { orderName: string; excludeOrderId?: number }): Promise<void> {
    this.call('assertOrderNameAvailable');
    const normalized = input.orderName.trim().toLowerCase();
    const duplicate = [...this.state.orders.values()].find(
      (order) =>
        order.header.orderName.trim().toLowerCase() === normalized &&
        !order.deleteFlag &&
        order.orderId !== input.excludeOrderId,
    );
    if (!duplicate) {
      return;
    }
    const numbers = [...this.state.orders.values()]
      .filter((order) => !order.deleteFlag)
      .map((order) => order.header.orderName.trim())
      .filter((name) => /^\d+$/.test(name))
      .map(Number);
    throw new OrderNameDuplicateError({
      existingOrderId: duplicate.orderId,
      orderName: input.orderName.trim(),
      suggestedOrderName: numbers.length > 0 ? String(Math.max(...numbers) + 1) : null,
    });
  }

  async loadOrderForDelete(orderId: number): Promise<LockedOrderDeleteRow | null> {
    this.call('loadOrderForDelete');
    const order = this.state.orders.get(orderId);
    return order
      ? {
          orderId,
          orderName: order.header.orderName,
          clientId: order.header.clientId,
          version: order.version,
          createdByUserId: 'user_admin',
          managerUserId: order.header.managerId === null ? null : String(order.header.managerId),
        }
      : null;
  }

  async peekOrderName(orderId: number): Promise<string | null> {
    this.call('peekOrderName');
    return this.state.orders.get(orderId)?.header.orderName ?? null;
  }

  async loadOrderForRestore(orderId: number): Promise<LockedOrderRestoreRow | null> {
    this.call('loadOrderForRestore');
    const order = this.state.orders.get(orderId);
    return order
      ? {
          orderId,
          orderName: order.header.orderName,
          clientId: order.header.clientId,
          version: order.version,
          createdByUserId: order.createdByUserId,
          managerUserId: order.managerUserId,
          deleteFlag: order.deleteFlag,
          deletedAt: order.deletedAt,
          deletedBy: order.deletedBy,
        }
      : null;
  }

  async readOrderClientProject(
    orderId: number,
  ): Promise<{ clientId: number | null; projectId: number } | null> {
    this.call('readOrderClientProject');
    if (this.owner.preReadClientProjectOverride !== undefined) {
      return this.owner.preReadClientProjectOverride;
    }
    const order = this.state.orders.get(orderId);
    if (!order) return null;
    // Legacy fake orders may carry no project; -1 keeps them working as long as
    // the flow does not actually need the project lock (no client change).
    return { clientId: order.header.clientId ?? null, projectId: order.projectId ?? -1 };
  }

  async lockProjectById(projectId: number): Promise<void> {
    this.call('lockProjectById');
    if (!this.state.projects.get(projectId)) {
      throw new Error(`Missing fake project ${projectId}`);
    }
  }

  async lockProjectForOrder(orderId: number): Promise<{
    projectId: number;
    clientId: number;
    code: string;
  }> {
    this.call('lockProjectForOrder');
    const order = this.getOrder(orderId);
    if (order.projectId === null) {
      throw new Error(`Order ${orderId} has no fake project`);
    }

    const project = this.state.projects.get(order.projectId);
    if (!project) {
      throw new Error(`Missing fake project ${order.projectId}`);
    }

    return { projectId: project.projectId, clientId: project.clientId, code: project.code };
  }

  async countOrdersInProject(projectId: number): Promise<number> {
    this.call('countOrdersInProject');
    return [...this.state.orders.values()].filter((order) => order.projectId === projectId).length;
  }

  async retargetProjectClient(
    projectId: number,
    clientId: number,
    currentUser: CurrentUser,
  ): Promise<void> {
    this.call('retargetProjectClient');
    const project = this.state.projects.get(projectId);
    if (!project) {
      throw new Error(`Missing fake project ${projectId}`);
    }

    project.clientId = clientId;
    project.version += 1;
    project.editedByUserId = currentUser.id;
  }

  async assertChildOwnership(orderId: number, refs: readonly OrderChildReference[]): Promise<void> {
    this.call('assertChildOwnership');
    const order = this.getOrder(orderId);

    refs.forEach((ref) => {
      const owned = getCollection(order, ref.entityType).some((row) => row.id === ref.id);

      if (!owned) {
        const existsInAnotherOrder = [...this.state.orders.values()].some(
          (candidate) =>
            candidate.orderId !== orderId &&
            getCollection(candidate, ref.entityType).some((row) => row.id === ref.id),
        );

        if (existsInAnotherOrder) {
          throw new ChildEntityNotOwnedError(ref.entityType, ref.id, orderId);
        }

        throw new ChildEntityNotFoundError(ref.entityType, ref.id);
      }
    });
  }

  async createOrderHeader(input: {
    header: NormalizedSaveOrderHeaderDto;
    totals: OrderTotalsDto;
    projectId: number;
    projectCode?: string;
  }): Promise<number> {
    this.call('createOrderHeader');
    const orderId = this.state.nextOrderId++;
    const now = '2026-04-30T00:00:00.000Z';

    this.state.orders.set(orderId, {
      orderId,
      header: input.header,
      details: [],
      payments: [],
      workshops: [],
      requirements: [],
      dowelingLinks: [],
      totals: input.totals,
      version: 0,
      createdByUserId: 'user_manager',
      managerUserId: input.header.managerId === null ? null : String(input.header.managerId),
      projectId: input.projectId,
      projectCode: input.projectCode ?? `МП-${input.projectId}`,
      createdAt: now,
      updatedAt: now,
      deleteFlag: false,
      deletedAt: null,
      deletedBy: null,
    });

    return orderId;
  }

  async updateOrderHeader(input: {
    orderId: number;
    header: NormalizedSaveOrderHeaderDto;
    totals: OrderTotalsDto;
  }): Promise<void> {
    this.call('updateOrderHeader');
    const order = this.getOrder(input.orderId);
    order.header = input.header;
    order.totals = input.totals;
  }

  async upsertDetails(orderId: number, details: readonly CalculatedOrderDetailDto[]): Promise<void> {
    this.call('upsertDetails');
    const order = this.getOrder(orderId);
    order.details = upsertRows(order.details, details, () => this.state.nextDetailId++);
    for (const detail of details) {
      if (detail.id || !detail.clientKey) {
        continue;
      }
      const persisted = order.details.find((candidate) => candidate.clientKey === detail.clientKey);
      if (persisted?.id) {
        detail.id = persisted.id;
      }
    }
  }

  async deleteDetails(orderId: number, ids: readonly number[]): Promise<void> {
    this.call('deleteDetails');
    const order = this.getOrder(orderId);
    order.details = order.details.filter((detail) => !ids.includes(detail.id as number));
  }

  async upsertPayments(orderId: number, payments: readonly NormalizedSaveOrderPaymentDto[]): Promise<void> {
    this.call('upsertPayments');
    const order = this.getOrder(orderId);
    order.payments = upsertRows(order.payments, payments, () => this.state.nextPaymentId++);
  }

  async deletePayments(orderId: number, ids: readonly number[]): Promise<void> {
    this.call('deletePayments');
    const order = this.getOrder(orderId);
    order.payments = order.payments.filter((payment) => !ids.includes(payment.id as number));
  }

  async upsertWorkshops(
    orderId: number,
    workshops: readonly NormalizedSaveOrderWorkshopDto[],
  ): Promise<void> {
    this.call('upsertWorkshops');
    const order = this.getOrder(orderId);
    order.workshops = upsertRows(order.workshops, workshops, () => this.state.nextWorkshopId++);
  }

  async deleteWorkshops(orderId: number, ids: readonly number[]): Promise<void> {
    this.call('deleteWorkshops');
    const order = this.getOrder(orderId);
    order.workshops = order.workshops.filter((workshop) => !ids.includes(workshop.id as number));
  }

  async upsertRequirements(
    orderId: number,
    requirements: readonly NormalizedSaveOrderRequirementDto[],
  ): Promise<void> {
    this.call('upsertRequirements');
    const order = this.getOrder(orderId);
    order.requirements = upsertRows(order.requirements, requirements, () => this.state.nextRequirementId++);
  }

  async deleteRequirements(orderId: number, ids: readonly number[]): Promise<void> {
    this.call('deleteRequirements');
    const order = this.getOrder(orderId);
    order.requirements = order.requirements.filter(
      (requirement) => !ids.includes(requirement.id as number),
    );
  }

  async upsertDowelingLinks(
    orderId: number,
    links: readonly NormalizedSaveOrderDowelingLinkDto[],
  ): Promise<void> {
    this.call('upsertDowelingLinks');
    const order = this.getOrder(orderId);
    order.dowelingLinks = upsertRows(order.dowelingLinks, links, () => this.state.nextDowelingLinkId++);
  }

  async deleteDowelingLinks(orderId: number, ids: readonly number[]): Promise<void> {
    this.call('deleteDowelingLinks');
    const order = this.getOrder(orderId);
    order.dowelingLinks = order.dowelingLinks.filter((link) => !ids.includes(link.id as number));
  }

  async updateOrderTotalsAndVersion(input: {
    orderId: number;
    totals: OrderTotalsDto;
    previousVersion: number | null;
  }): Promise<number> {
    this.call('updateOrderTotalsAndVersion');
    const order = this.getOrder(input.orderId);
    order.totals = input.totals;
    order.version = input.previousVersion === null ? 1 : input.previousVersion + 1;
    order.updatedAt = '2026-04-30T01:00:00.000Z';
    return order.version;
  }

  async softDeleteOrder(input: {
    orderId: number;
    previousVersion: number;
    actorUserId: string;
  }): Promise<number> {
    this.call('softDeleteOrder');
    const order = this.getOrder(input.orderId);
    order.version = input.previousVersion + 1;
    order.deleteFlag = true;
    order.deletedAt = '2026-05-01T00:00:00.000Z';
    order.deletedBy = input.actorUserId;
    return order.version;
  }

  async restoreOrder(input: {
    orderId: number;
    previousVersion: number;
    targetOrderName: string;
    actorUserId: string;
  }): Promise<number> {
    this.call('restoreOrder');
    const order = this.getOrder(input.orderId);
    order.header = { ...order.header, orderName: input.targetOrderName };
    order.version = input.previousVersion + 1;
    order.deleteFlag = false;
    order.deletedAt = null;
    order.deletedBy = null;
    order.updatedAt = '2026-05-02T04:05:06.000Z';
    return order.version;
  }

  async writeAuditEvent(event: OrderSaveAuditEvent): Promise<void> {
    this.call('writeAuditEvent');
    this.state.auditEvents.push(event);
  }

  async writeOrderDeleteAudit(input: OrderDeleteAuditInput): Promise<string> {
    this.call('writeOrderDeleteAudit');
    this.state.auditEvents.push({
      action: 'orders.delete',
      orderId: input.order.orderId,
      actorUserId: input.currentUser.id,
      requestId: input.requestId,
      nextVersion: input.nextVersion,
    });
    return 'audit-delete-1';
  }

  async enqueueOrderDeleteOutbox(input: OrderDeleteOutboxInput): Promise<void> {
    this.call('enqueueOrderDeleteOutbox');
    this.state.outboxEvents.push({
      eventType: 'order.deleted',
      orderId: input.order.orderId,
      requestId: input.requestId,
    });
  }

  async writeOrderRestoreAudit(input: OrderRestoreAuditInput): Promise<string> {
    this.call('writeOrderRestoreAudit');
    this.state.auditEvents.push({
      action: 'orders.restore',
      orderId: input.order.orderId,
      actorUserId: input.currentUser.id,
      requestId: input.requestId,
      nextVersion: input.nextVersion,
      targetOrderName: input.targetOrderName,
    });
    return 'audit-restore-1';
  }

  async enqueueOrderRestoreOutbox(input: OrderRestoreOutboxInput): Promise<void> {
    this.call('enqueueOrderRestoreOutbox');
    this.state.outboxEvents.push({
      eventType: 'order.restored',
      orderId: input.order.orderId,
      requestId: input.requestId,
      targetOrderName: input.targetOrderName,
    });
  }

  async recordOrderRestoreDenied(input: {
    currentUser: CurrentUser;
    orderId: number;
    requestId: string;
  }): Promise<void> {
    this.call('recordOrderRestoreDenied');
    this.owner.state.deniedRestoreAudits.push({
      orderId: input.orderId,
      requestId: input.requestId,
      actorUserId: input.currentUser.id,
    });
  }

  // Test simulation of the real DB snapshot query. Does NOT need to mirror the
  // production SELECT column list 1:1 — focused assertions only depend on a
  // subset of fields (e.g. orderName). Leave the projection intact so that
  // before≠after is reliable for the update-path assertions.
  async loadOrderHeaderSnapshot(orderId: number): Promise<Record<string, unknown> | null> {
    this.call('loadOrderHeaderSnapshot');
    const order = this.state.orders.get(orderId);
    if (!order) return null;
    return {
      orderName: order.header.orderName,
      clientId: order.header.clientId ?? null,
      orderDate: order.header.orderDate,
      priority: order.header.priority,
      managerId: order.header.managerId ?? null,
      orderStatusId: order.header.orderStatusId,
      productionStatusId: order.header.productionStatusId ?? null,
      plannedCompletionDate: order.header.plannedCompletionDate ?? null,
      completionDate: order.header.completionDate ?? null,
      issueDate: order.header.issueDate ?? null,
      projectId: order.projectId,
      projectCode: order.projectCode,
      discount: order.totals.discount,
      surcharge: order.totals.surcharge,
      totalAmount: order.totals.totalAmount,
      finalAmount: order.totals.finalAmount,
      linkCuttingFile: order.header.linkCuttingFile ?? null,
      linkCuttingImageFile: order.header.linkCuttingImageFile ?? null,
      linkCadFile: order.header.linkCadFile ?? null,
      linkPdfFile: order.header.linkPdfFile ?? null,
      notes: order.header.notes ?? null,
      materialId: order.header.materialId ?? null,
      millingTypeId: order.header.millingTypeId ?? null,
      edgeTypeId: order.header.edgeTypeId ?? null,
      filmId: order.header.filmId ?? null,
      refKey1c: order.header.refKey1c ?? null,
      // VARIANT B: all seeded orders are sheet-eligible; sheetEligible drives enforceSheetGuards
      // path selection in OrderTransactionService (storedEligible check at line ~190).
      sheetEligible: true,
    };
  }

  async readOrder(orderId: number): Promise<OrderDto> {
    this.call('readOrder');
    return toOrderDto(this.getOrder(orderId));
  }

  private getOrder(orderId: number): FakeOrderRecord {
    const order = this.state.orders.get(orderId);

    if (!order) {
      throw new Error(`Missing fake order ${orderId}`);
    }

    return order;
  }

  private call(name: string): void {
    this.owner.calls.push(name);

    if (this.owner.failAt === name) {
      throw new Error(`Injected failure at ${name}`);
    }
  }
}

function dtoWithOrderName(orderName: string, version?: number): SaveOrderDto {
  const dto = createSaveDto(version === undefined ? {} : { version });
  return { ...dto, header: { ...dto.header, orderName } };
}

describe('OrderTransactionService order-name uniqueness', () => {
  it('rejects creating an order whose name is already taken by a live order (hard block, no override)', async () => {
    const transactions = new FakeOrderTransactions();
    const service = new OrderTransactionService({ transactions });
    await service.create({
      currentUser: currentUser('manager'),
      dto: dtoWithOrderName('2558'),
    });

    await expect(
      service.create({
        currentUser: currentUser('manager'),
        dto: dtoWithOrderName('2558'),
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'ORDER_NAME_DUPLICATE',
      details: expect.objectContaining({ suggestedOrderName: '2559' }),
    });
  });

  it('treats the duplicate check as whitespace/case-insensitive', async () => {
    const transactions = new FakeOrderTransactions();
    const service = new OrderTransactionService({ transactions });
    await service.create({
      currentUser: currentUser('manager'),
      dto: dtoWithOrderName('Кухня Ивановых'),
    });

    await expect(
      service.create({
        currentUser: currentUser('manager'),
        dto: dtoWithOrderName('  кухня ивановых '),
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_NAME_DUPLICATE' });
  });

  it('rejects renaming an order to a name taken by another live order', async () => {
    const transactions = new FakeOrderTransactions();
    const service = new OrderTransactionService({ transactions });
    const first = await service.create({
      currentUser: currentUser('manager'),
      dto: dtoWithOrderName('2558'),
    });
    const second = await service.create({
      currentUser: currentUser('manager'),
      dto: dtoWithOrderName('2559'),
    });

    await expect(
      service.update({
        currentUser: currentUser('manager'),
        orderId: second.header.orderId,
        dto: dtoWithOrderName('2558', second.version),
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_NAME_DUPLICATE' });
    expect(first.header.orderId).not.toBe(second.header.orderId);
  });

  it('does not crash on a non-string orderName in the raw body (coerced before the lock)', async () => {
    const transactions = new FakeOrderTransactions();
    const service = new OrderTransactionService({ transactions });
    const created = await service.create({
      currentUser: currentUser('manager'),
      dto: dtoWithOrderName('2558'),
    });

    const dto = createSaveDto({ version: created.version });
    (dto.header as Record<string, unknown>).orderName = 2558;

    // Не TypeError/500 до нормализации: лок получает коэрснутую строку, дальше
    // обычный normalizer-путь коэрсит 2558 → '2558' (имя не меняется) и
    // сохранение проходит.
    await expect(
      service.update({ currentUser: currentUser('manager'), orderId: created.header.orderId, dto }),
    ).resolves.toBeDefined();
    expect(transactions.calls).toContain('lockOrderName');
  });

  it('saving an order WITHOUT renaming skips the uniqueness check (legacy duplicates stay editable)', async () => {
    const transactions = new FakeOrderTransactions();
    const service = new OrderTransactionService({ transactions });
    const created = await service.create({
      currentUser: currentUser('manager'),
      dto: dtoWithOrderName('2558'),
    });
    // Легаси-дубль: второй живой заказ с тем же именем появился мимо команды
    // (история до включения проверки).
    transactions.state.orders.set(9999, {
      ...transactions.state.orders.get(created.header.orderId)!,
      orderId: 9999,
    } as never);

    transactions.calls = [];
    await expect(
      service.update({
        currentUser: currentUser('manager'),
        orderId: created.header.orderId,
        dto: dtoWithOrderName('2558', created.version),
      }),
    ).resolves.toBeDefined();
    expect(transactions.calls).not.toContain('assertOrderNameAvailable');
  });
});

describe('OrderTransactionService', () => {
  it('creates an order aggregate in the PRD transaction order and writes audit after totals', async () => {
    const transactions = new FakeOrderTransactions();
    const result = await new OrderTransactionService({ transactions }).create({
      currentUser: currentUser('manager'),
      dto: createSaveDto(),
    });

    expect(result.header.orderId).toBe(100);
    expect(result.details[0]).toMatchObject({
      id: 1000,
      clientKey: 'detail-temp-1',
      area: 0.22,
      detailCost: 10000,
    });
    expect(result.payments[0]).toMatchObject({
      id: 2000,
      clientKey: 'payment-temp-1',
    });
    expect(result.totals).toMatchObject({
      totalAmount: 10000,
      finalAmount: 9500,
      paidAmount: 3000,
      debtAmount: 6500,
    });
    expect(result.version).toBe(1);
    expect(transactions.state.auditEvents).toMatchObject([
      expect.objectContaining({ action: 'orders.create', orderId: 100, actorUserId: 'user_manager', actorUsername: 'manager', actorRole: 'manager', clientId: 1001 }),
    ]);
    const createAuditEvent = transactions.state.auditEvents[0] as typeof transactions.state.auditEvents[0] & { before?: unknown; after?: unknown };
    expect(createAuditEvent).toMatchObject({ before: null });
    expect((createAuditEvent.after as Record<string, unknown>)?.orderName).toBe('Test order');
    expect((result.header as Record<string, unknown>).projectId).toBe(500);
    expect((result.header as Record<string, unknown>).projectCode).toBe('МП-500');
    expect(transactions.calls).toEqual([
      'begin',
      'setSessionUser',
      'lockOrderName',
      'assertOrderNameAvailable',
      'validateSheetReferences',
      'resolveProjectForCreate',
      'createOrderHeader',
      'upsertDetails',
      'deleteDetails',
      'upsertPayments',
      'deletePayments',
      'deleteWorkshops',
      'upsertWorkshops',
      'deleteRequirements',
      'upsertRequirements',
      'deleteDowelingLinks',
      'upsertDowelingLinks',
      'updateOrderTotalsAndVersion',
      'loadOrderHeaderSnapshot',
      'writeAuditEvent',
      'readOrder',
      'commit',
    ]);
  });

  it('passes unit of work and persisted detail ids by clientKey to postPersistHook', async () => {
    const transactions = new FakeOrderTransactions();
    const hook = vi.fn().mockResolvedValue(undefined);

    await new OrderTransactionService({ transactions }).create({
      currentUser: currentUser('manager'),
      dto: createSaveDto({
        details: [
          {
            clientKey: 'bazis-node-101',
            height: 550,
            width: 200,
            quantity: 2,
            materialId: null,
            sheetMaterialTypeId: 1001,
            millingTypeId: 1001,
            edgeTypeId: 1001,
            detailCost: 10000,
          },
          {
            clientKey: 'bazis-node-102',
            height: 650,
            width: 250,
            quantity: 1,
            materialId: null,
            sheetMaterialTypeId: 1001,
            millingTypeId: 1001,
            edgeTypeId: 1001,
            detailCost: 5000,
          },
        ],
      }),
      postPersistHook: hook,
    });

    expect(hook).toHaveBeenCalledTimes(1);
    const [uow, created] = hook.mock.calls[0] as [OrderWriteUnitOfWork, {
      orderId: number;
      detailIdsByClientKey: Map<string, number>;
    }];
    expect(created.orderId).toBe(100);
    expect(created.detailIdsByClientKey).toEqual(
      new Map([
        ['bazis-node-101', 1000],
        ['bazis-node-102', 1001],
      ]),
    );
    expect(uow.getTransactionClient()).toBe(transactions.transactionClient);
  });

  it('rolls back the whole create transaction when postPersistHook throws', async () => {
    const transactions = new FakeOrderTransactions();

    await expect(
      new OrderTransactionService({ transactions }).create({
        currentUser: currentUser('manager'),
        dto: createSaveDto(),
        postPersistHook: async () => {
          throw new Error('hook failed');
        },
      }),
    ).rejects.toThrow('hook failed');

    expect(transactions.committed).toBe(0);
    expect(transactions.rolledBack).toBe(1);
    expect(transactions.state.orders.size).toBe(0);
    expect(transactions.state.auditEvents).toEqual([]);
    expect(transactions.calls).toContain('writeAuditEvent');
  });

  it('passes unit of work and locked order to prePersistHook before header persistence in update', async () => {
    const transactions = new FakeOrderTransactions();
    transactions.seedOrder({
      orderId: 42,
      version: 3,
      details: [calculatedDetail({ id: 11, detailCost: 5000 })],
    });
    const hook = vi.fn(async (uow: OrderWriteUnitOfWork, locked: LockedOrderRow) => {
      expect(transactions.calls).not.toContain('updateOrderHeader');
      transactions.calls.push('prePersistHook');
      expect(uow.getTransactionClient()).toBe(transactions.transactionClient);
      expect(locked).toEqual({
        orderId: 42,
        orderName: 'Seed order',
        version: 3,
        createdByUserId: 'user_manager',
        managerUserId: 'user_manager',
      });
    });

    await new OrderTransactionService({ transactions }).update({
      currentUser: currentUser('manager'),
      orderId: 42,
      dto: createSaveDto({
        header: {
          orderId: 42,
          orderName: 'Updated order',
          clientId: 1001,
          orderDate: '2026-04-30',
          orderStatusId: 1001,
          discount: 0,
          surcharge: 0,
        },
        details: [
          {
            id: 11,
            height: 550,
            width: 200,
            quantity: 2,
            materialId: null,
            sheetMaterialTypeId: 1001,
            millingTypeId: 1001,
            edgeTypeId: 1001,
            detailCost: 7000,
          },
        ],
        payments: [],
        version: 3,
      }),
      prePersistHook: hook,
    });

    expect(hook).toHaveBeenCalledTimes(1);
    expect(transactions.calls.indexOf('prePersistHook')).toBeGreaterThan(
      transactions.calls.indexOf('assertChildOwnership'),
    );
    expect(transactions.calls.indexOf('prePersistHook')).toBeLessThan(
      transactions.calls.indexOf('updateOrderHeader'),
    );
  });

  it('rolls back the whole update transaction when prePersistHook throws', async () => {
    const transactions = new FakeOrderTransactions();
    transactions.seedOrder({
      orderId: 42,
      version: 3,
      details: [calculatedDetail({ id: 11, detailCost: 5000 })],
    });

    await expect(
      new OrderTransactionService({ transactions }).update({
        currentUser: currentUser('manager'),
        orderId: 42,
        dto: createSaveDto({
          header: {
            orderId: 42,
            orderName: 'Updated order',
            clientId: 1001,
            orderDate: '2026-04-30',
            orderStatusId: 1001,
            discount: 0,
            surcharge: 0,
          },
          details: [
            {
              id: 11,
              height: 550,
              width: 200,
              quantity: 2,
              materialId: null,
              sheetMaterialTypeId: 1001,
              millingTypeId: 1001,
              edgeTypeId: 1001,
              detailCost: 7000,
            },
          ],
          payments: [],
          version: 3,
        }),
        prePersistHook: async () => {
          throw new Error('pre hook failed');
        },
      }),
    ).rejects.toThrow('pre hook failed');

    expect(transactions.committed).toBe(0);
    expect(transactions.rolledBack).toBe(1);
    expect(transactions.state.orders.get(42)?.header.orderName).toBe('Seed order');
    expect(transactions.state.orders.get(42)?.version).toBe(3);
    expect(transactions.state.auditEvents).toEqual([]);
    expect(transactions.calls).not.toContain('updateOrderHeader');
  });

  it('passes persisted detail ids by clientKey to postPersistHook in update', async () => {
    const transactions = new FakeOrderTransactions();
    transactions.seedOrder({
      orderId: 42,
      version: 3,
      details: [calculatedDetail({ id: 11, detailCost: 5000 })],
    });
    const hook = vi.fn().mockResolvedValue(undefined);

    await new OrderTransactionService({ transactions }).update({
      currentUser: currentUser('manager'),
      orderId: 42,
      dto: createSaveDto({
        header: {
          orderId: 42,
          orderName: 'Updated order',
          clientId: 1001,
          orderDate: '2026-04-30',
          orderStatusId: 1001,
          discount: 0,
          surcharge: 0,
        },
        details: [
          {
            id: 11,
            height: 550,
            width: 200,
            quantity: 2,
            materialId: null,
            sheetMaterialTypeId: 1001,
            millingTypeId: 1001,
            edgeTypeId: 1001,
            detailCost: 7000,
          },
          {
            clientKey: 'bazis-node-201',
            height: 1000,
            width: 500,
            quantity: 1,
            materialId: null,
            sheetMaterialTypeId: 1001,
            millingTypeId: 1001,
            edgeTypeId: 1001,
            detailCost: 3000,
          },
        ],
        payments: [],
        version: 3,
      }),
      postPersistHook: hook,
    });

    expect(hook).toHaveBeenCalledTimes(1);
    const [uow, updated] = hook.mock.calls[0] as [OrderWriteUnitOfWork, {
      orderId: number;
      detailIdsByClientKey: Map<string, number>;
    }];
    expect(updated).toEqual({
      orderId: 42,
      detailIdsByClientKey: new Map([['bazis-node-201', 1000]]),
    });
    expect(uow.getTransactionClient()).toBe(transactions.transactionClient);
  });

  it('rolls back the whole update transaction when postPersistHook throws', async () => {
    const transactions = new FakeOrderTransactions();
    transactions.seedOrder({
      orderId: 42,
      version: 3,
      details: [calculatedDetail({ id: 11, detailCost: 5000 })],
    });

    await expect(
      new OrderTransactionService({ transactions }).update({
        currentUser: currentUser('manager'),
        orderId: 42,
        dto: createSaveDto({
          header: {
            orderId: 42,
            orderName: 'Updated order',
            clientId: 1001,
            orderDate: '2026-04-30',
            orderStatusId: 1001,
            discount: 0,
            surcharge: 0,
          },
          details: [
            {
              id: 11,
              height: 550,
              width: 200,
              quantity: 2,
              materialId: null,
              sheetMaterialTypeId: 1001,
              millingTypeId: 1001,
              edgeTypeId: 1001,
              detailCost: 7000,
            },
          ],
          payments: [],
          version: 3,
        }),
        postPersistHook: async () => {
          throw new Error('post hook failed');
        },
      }),
    ).rejects.toThrow('post hook failed');

    expect(transactions.committed).toBe(0);
    expect(transactions.rolledBack).toBe(1);
    expect(transactions.state.orders.get(42)?.header.orderName).toBe('Seed order');
    expect(transactions.state.orders.get(42)?.version).toBe(3);
    expect(transactions.state.auditEvents).toEqual([]);
    expect(transactions.calls).toContain('writeAuditEvent');
  });

  it('returns cached create response for a repeated idempotency key before any inserts', async () => {
    const transactions = new FakeOrderTransactions();
    transactions.completedCreateResponse = toOrderDto({
      orderId: 222,
      header: createHeader({ orderName: 'Cached order' }),
      details: [],
      payments: [],
      workshops: [],
      requirements: [],
      dowelingLinks: [],
      totals: createTotals(),
      version: 1,
      createdByUserId: 'user_manager',
      managerUserId: 'user_manager',
      projectId: 901,
      projectCode: 'МП-901',
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    });

    const result = await new OrderTransactionService({ transactions }).create({
      currentUser: currentUser('manager'),
      dto: createSaveDto({ idempotencyKey: 'create-key-1' }),
    });

    expect(result.header.orderId).toBe(222);
    expect((result.header as Record<string, unknown>).projectId).toBe(901);
    expect(transactions.calls).toEqual([
      'begin',
      'setSessionUser',
      'reconcileOrderCreateIdempotency',
      'commit',
    ]);
  });

  it('runs normal create flow and completes create idempotency for a fresh key', async () => {
    const transactions = new FakeOrderTransactions();

    const result = await new OrderTransactionService({ transactions }).create({
      currentUser: currentUser('manager'),
      dto: createSaveDto({ idempotencyKey: 'create-key-2' }),
      requestId: 'req-create-2',
    });

    expect(result.header.orderId).toBe(100);
    expect((result.header as Record<string, unknown>).projectId).toBe(500);
    expect(transactions.calls).toContain('reconcileOrderCreateIdempotency');
    expect(transactions.calls).toContain('completeOrderCreateIdempotency');
    expect(transactions.calls.indexOf('resolveProjectForCreate')).toBeLessThan(
      transactions.calls.indexOf('createOrderHeader'),
    );
    expect(transactions.calls.indexOf('completeOrderCreateIdempotency')).toBeGreaterThan(
      transactions.calls.indexOf('readOrder'),
    );
  });

  it('does not sync deadlines after order save unless a deadline sync port is wired', async () => {
    const transactionsWithoutSync = new FakeOrderTransactions();
    const syncCalls: string[] = [];

    await new OrderTransactionService({ transactions: transactionsWithoutSync }).create({
      currentUser: currentUser('manager'),
      dto: createSaveDto(),
    });

    expect(syncCalls).toEqual([]);

    const transactionsWithSync = new FakeOrderTransactions();

    await new OrderTransactionService({
      transactions: transactionsWithSync,
      deadlineSync: {
        async syncOrderDeadlinesAfterSave(command) {
          syncCalls.push(`${command.eventType}:${command.orderId}:${command.currentUser.id}:${command.requestId}`);
        },
      },
    }).create({
      currentUser: currentUser('manager'),
      dto: createSaveDto(),
      requestId: 'req-order-create-1',
    });

    expect(syncCalls).toEqual(['ORDER_CREATED:100:user_manager:req-order-create-1']);
  });

  it('updates an order after lock, version check and child ownership validation', async () => {
    const transactions = new FakeOrderTransactions();
    transactions.seedOrder({
      orderId: 42,
      version: 3,
      details: [calculatedDetail({ id: 11, detailCost: 5000 })],
      payments: [payment({ id: 21, amount: 1000 })],
    });

    const result = await new OrderTransactionService({ transactions }).update({
      currentUser: currentUser('admin'),
      orderId: 42,
      dto: createSaveDto({
        header: {
          orderId: 42,
          orderName: 'Updated order',
          clientId: 1001,
          orderDate: '2026-04-30',
          orderStatusId: 1001,
          discount: 0,
          surcharge: 0,
        },
        details: [
          {
            id: 11,
            height: 550,
            width: 200,
            quantity: 2,
            materialId: null,
            sheetMaterialTypeId: 1001,
            millingTypeId: 1001,
            edgeTypeId: 1001,
            detailCost: 7000,
          },
          {
            clientKey: 'new-detail',
            height: 1000,
            width: 500,
            quantity: 1,
            materialId: null,
            sheetMaterialTypeId: 1001,
            millingTypeId: 1001,
            edgeTypeId: 1001,
            detailCost: 3000,
          },
        ],
        payments: [],
        deleted: {
          paymentIds: [21],
        },
        version: 3,
      }),
    });

    expect(result.version).toBe(4);
    expect(result.details).toHaveLength(2);
    expect(result.payments).toHaveLength(0);
    expect(result.totals.totalAmount).toBe(10000);
    expect(transactions.state.auditEvents).toMatchObject([
      expect.objectContaining({ action: 'orders.update', orderId: 42, actorUserId: 'user_admin', actorUsername: 'admin', actorRole: 'admin', clientId: 1001 }),
    ]);
    const updateAuditEvent1 = transactions.state.auditEvents[0] as typeof transactions.state.auditEvents[0] & { before?: Record<string, unknown> | null; after?: Record<string, unknown> | null };
    expect(updateAuditEvent1.before).toBeTruthy();
    expect(updateAuditEvent1.after).toBeTruthy();
    // after reflects the updated orderName
    expect((updateAuditEvent1.after as Record<string, unknown>)?.orderName).toBe('Updated order');
    expect(transactions.calls.slice(0, 11)).toEqual([
      'begin',
      'setSessionUser',
      'lockOrderName',
      'readOrderClientProject',
      'loadOrderForUpdate',
      'assertOrderNameAvailable',
      'loadOrderHeaderSnapshot',
      // VARIANT B: storedEligible=true (sheetEligible in snapshot) → loadStoredOrderSheetState runs
      'loadStoredOrderSheetState',
      'validateSheetReferences',
      'assertChildOwnership',
      'updateOrderHeader',
    ]);
  });

  it('updates operational child workflow collections inside the order transaction', async () => {
    const transactions = new FakeOrderTransactions();
    transactions.seedOrder({
      orderId: 42,
      version: 3,
      details: [calculatedDetail({ id: 11, detailCost: 5000 })],
      workshops: [
        workshop({ id: 31, workshopId: 7, productionStatusId: 8, notes: 'old workshop' }),
        workshop({ id: 32, workshopId: 8, productionStatusId: 8 }),
      ],
      requirements: [
        requirement({ id: 41, resourceType: 'material', materialId: 4, requiredQuantity: 1 }),
        requirement({ id: 42, resourceType: 'film', filmId: 5, requiredQuantity: 1 }),
      ],
      dowelingLinks: [
        dowelingLink({ id: 51, dowelingOrderId: 44, designEngineerId: null }),
        dowelingLink({ id: 52, dowelingOrderId: 45, designEngineerId: null }),
      ],
    });

    const result = await new OrderTransactionService({ transactions }).update({
      currentUser: currentUser('manager'),
      orderId: 42,
      dto: createSaveDto({
        header: {
          orderId: 42,
          orderName: 'Updated order',
          clientId: 1001,
          orderDate: '2026-04-30',
          orderStatusId: 1001,
          discount: 0,
          surcharge: 0,
        },
        details: [
          {
            id: 11,
            height: 500,
            width: 500,
            quantity: 1,
            materialId: null,
            sheetMaterialTypeId: 1001,
            millingTypeId: 1001,
            edgeTypeId: 1001,
            detailCost: 5000,
          },
        ],
        payments: [],
        workshops: [
          {
            id: 31,
            workshopId: 9,
            productionStatusId: 10,
            receivedDate: '2026-05-01',
            plannedCompletionDate: '2026-05-05',
            notes: 'updated workshop',
          },
          {
            clientKey: 'new-workshop',
            workshopId: 11,
            productionStatusId: 12,
            sequenceOrder: 2,
            responsibleEmployeeId: 99,
          },
        ],
        requirements: [
          {
            id: 41,
            resourceType: 'material',
            materialId: 6,
            requiredQuantity: 3,
            unitId: 1001,
            requirementStatusId: 1001,
            purchasePrice: 25,
          },
          {
            clientKey: 'new-requirement',
            resourceType: 'edge',
            edgeTypeId: 7,
            requiredQuantity: 4,
            unitId: 1001,
            requirementStatusId: 1001,
          },
        ],
        dowelingLinks: [
          {
            id: 51,
            dowelingOrderId: 46,
            designEngineerId: 12,
          },
          {
            clientKey: 'new-doweling-link',
            dowelingOrderId: 47,
            designEngineerId: null,
          },
        ],
        deleted: {
          workshopIds: [32],
          requirementIds: [42],
          dowelingLinkIds: [52],
        },
        version: 3,
      }),
    });

    expect(result.version).toBe(4);
    expect(result.workshops).toMatchObject([
      { id: 31, workshopId: 9, productionStatusId: 10, notes: 'updated workshop' },
      { id: 3000, clientKey: 'new-workshop', workshopId: 11, productionStatusId: 12 },
    ]);
    expect(result.requirements).toMatchObject([
      { id: 41, resourceType: 'material', materialId: 6, requiredQuantity: 3 },
      { id: 4000, clientKey: 'new-requirement', resourceType: 'edge', edgeTypeId: 7 },
    ]);
    expect(result.dowelingLinks).toMatchObject([
      { id: 51, dowelingOrderId: 46, designEngineerId: 12 },
      { id: 5000, clientKey: 'new-doweling-link', dowelingOrderId: 47 },
    ]);
    expect(transactions.calls).toContain('assertChildOwnership');
    expect(transactions.calls).toContain('upsertWorkshops');
    expect(transactions.calls).toContain('deleteWorkshops');
    expect(transactions.calls).toContain('upsertRequirements');
    expect(transactions.calls).toContain('deleteRequirements');
    expect(transactions.calls).toContain('upsertDowelingLinks');
    expect(transactions.calls).toContain('deleteDowelingLinks');
    expect(transactions.calls.indexOf('deleteDowelingLinks')).toBeLessThan(
      transactions.calls.indexOf('upsertDowelingLinks'),
    );
    expect(transactions.calls.indexOf('updateOrderTotalsAndVersion')).toBeGreaterThan(
      transactions.calls.indexOf('upsertDowelingLinks'),
    );
    expect(transactions.state.auditEvents).toMatchObject([
      expect.objectContaining({ action: 'orders.update', orderId: 42, actorUserId: 'user_manager', actorUsername: 'manager', actorRole: 'manager', clientId: 1001 }),
    ]);
  });

  it('updates a legacy order whose current optimistic lock version is zero', async () => {
    const transactions = new FakeOrderTransactions();
    transactions.seedOrder({
      orderId: 42,
      version: 0,
      details: [calculatedDetail({ id: 11, detailCost: 5000 })],
    });

    const result = await new OrderTransactionService({ transactions }).update({
      currentUser: currentUser('manager'),
      orderId: 42,
      dto: createSaveDto({
        header: {
          orderId: 42,
          orderName: 'Updated legacy order',
          clientId: 1001,
          orderDate: '2026-04-30',
          orderStatusId: 1001,
          discount: 0,
          surcharge: 0,
        },
        details: [
          {
            id: 11,
            height: 550,
            width: 200,
            quantity: 3,
            materialId: null,
            sheetMaterialTypeId: 1001,
            millingTypeId: 1001,
            edgeTypeId: 1001,
            detailCost: 15000,
          },
        ],
        payments: [],
        version: 0,
      }),
    });

    expect(result.version).toBe(1);
    expect(result.details[0].quantity).toBe(3);
    expect(transactions.state.auditEvents).toMatchObject([
      expect.objectContaining({ action: 'orders.update', orderId: 42, actorUserId: 'user_manager', actorUsername: 'manager', actorRole: 'manager', clientId: 1001 }),
    ]);
  });

  it('accepts an omitted client version for the first update of legacy zero-version orders', async () => {
    const transactions = new FakeOrderTransactions();
    transactions.seedOrder({
      orderId: 42,
      version: 0,
      details: [calculatedDetail({ id: 11, detailCost: 5000 })],
    });

    const result = await new OrderTransactionService({ transactions }).update({
      currentUser: currentUser('manager'),
      orderId: 42,
      dto: createSaveDto({
        header: {
          orderId: 42,
          orderName: 'Updated legacy order',
          clientId: 1001,
          orderDate: '2026-04-30',
          orderStatusId: 1001,
          discount: 0,
          surcharge: 0,
        },
        details: [
          {
            id: 11,
            height: 550,
            width: 200,
            quantity: 4,
            materialId: null,
            sheetMaterialTypeId: 1001,
            millingTypeId: 1001,
            edgeTypeId: 1001,
            detailCost: 20000,
          },
        ],
        payments: [],
        version: undefined,
      }),
    });

    expect(result.version).toBe(1);
    expect(result.details[0].quantity).toBe(4);
  });

  it('retargets the project client when the order is the only child in its project', async () => {
    const transactions = new FakeOrderTransactions();
    transactions.seedProject({
      projectId: 700,
      code: 'МП-700',
      clientId: 1001,
      deleteFlag: false,
      version: 2,
      editedByUserId: null,
    });
    transactions.seedOrder({
      orderId: 42,
      version: 3,
      projectId: 700,
      projectCode: 'МП-700',
      details: [calculatedDetail({ id: 11, detailCost: 5000 })],
    });

    const result = await new OrderTransactionService({ transactions }).update({
      currentUser: currentUser('manager'),
      orderId: 42,
      dto: createSaveDto({
        header: {
          orderId: 42,
          orderName: 'Updated order',
          clientId: 2002,
          orderDate: '2026-04-30',
          orderStatusId: 1001,
          discount: 0,
          surcharge: 0,
        },
        details: [
          {
            id: 11,
            height: 550,
            width: 200,
            quantity: 2,
            materialId: null,
            sheetMaterialTypeId: 1001,
            millingTypeId: 1001,
            edgeTypeId: 1001,
            detailCost: 5000,
          },
        ],
        payments: [],
        version: 3,
      }),
    });

    expect(result.header.clientId).toBe(2002);
    expect(transactions.state.projects.get(700)?.clientId).toBe(2002);
    expect(transactions.calls).toContain('lockProjectForOrder');
    expect(transactions.calls).toContain('countOrdersInProject');
    expect(transactions.calls).toContain('retargetProjectClient');
    expect(transactions.calls.indexOf('retargetProjectClient')).toBeLessThan(
      transactions.calls.indexOf('updateOrderHeader'),
    );
    // Global anti-deadlock order shared with projects move/merge: the project
    // row lock must precede the order row lock.
    expect(transactions.calls.indexOf('lockProjectById')).toBeGreaterThanOrEqual(0);
    expect(transactions.calls.indexOf('lockProjectById')).toBeLessThan(
      transactions.calls.indexOf('loadOrderForUpdate'),
    );
  });

  it('409 when the unlocked pre-read diverges from the locked snapshot on a client change', async () => {
    const transactions = new FakeOrderTransactions();
    transactions.seedProject({
      projectId: 700,
      code: 'МП-700',
      clientId: 1001,
      deleteFlag: false,
      version: 2,
      editedByUserId: null,
    });
    transactions.seedOrder({
      orderId: 42,
      version: 3,
      projectId: 700,
      projectCode: 'МП-700',
      details: [calculatedDetail({ id: 11, detailCost: 5000 })],
    });
    // Pre-read claims the client already equals the requested one (so no project
    // lock is taken upfront), but the locked snapshot still shows the old client:
    // proceeding would need the project lock AFTER the order lock — must 409.
    transactions.preReadClientProjectOverride = { clientId: 2002, projectId: 700 };

    await expect(
      new OrderTransactionService({ transactions }).update({
        currentUser: currentUser('manager'),
        orderId: 42,
        dto: createSaveDto({
          header: {
            orderId: 42,
            orderName: 'Updated order',
            clientId: 2002,
            orderDate: '2026-04-30',
            orderStatusId: 1001,
            discount: 0,
            surcharge: 0,
          },
          details: [],
          payments: [],
          version: 3,
        }),
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_PROJECT_CONFLICT' });

    expect(transactions.calls).not.toContain('lockProjectForOrder');
    expect(transactions.calls).not.toContain('retargetProjectClient');
    expect(transactions.calls).not.toContain('updateOrderHeader');
  });

  it('blocks client change when the project has multiple orders', async () => {
    const transactions = new FakeOrderTransactions();
    transactions.seedProject({
      projectId: 701,
      code: 'МП-701',
      clientId: 1001,
      deleteFlag: false,
      version: 0,
      editedByUserId: null,
    });
    transactions.seedOrder({
      orderId: 42,
      version: 3,
      projectId: 701,
      projectCode: 'МП-701',
      details: [calculatedDetail({ id: 11, detailCost: 5000 })],
    });
    transactions.seedOrder({
      orderId: 43,
      version: 1,
      projectId: 701,
      projectCode: 'МП-701',
      details: [calculatedDetail({ id: 12, detailCost: 2000 })],
    });

    await expect(
      new OrderTransactionService({ transactions }).update({
        currentUser: currentUser('manager'),
        orderId: 42,
        dto: createSaveDto({
          header: {
            orderId: 42,
            orderName: 'Updated order',
            clientId: 2002,
            orderDate: '2026-04-30',
            orderStatusId: 1001,
            discount: 0,
            surcharge: 0,
          },
          details: [
            {
              id: 11,
              height: 550,
              width: 200,
              quantity: 2,
              materialId: null,
              sheetMaterialTypeId: 1001,
              millingTypeId: 1001,
              edgeTypeId: 1001,
              detailCost: 5000,
            },
          ],
          payments: [],
          version: 3,
        }),
      }),
    ).rejects.toBeInstanceOf(ProjectClientMismatchError);

    expect(transactions.state.projects.get(701)?.clientId).toBe(1001);
    expect(transactions.calls).toContain('lockProjectForOrder');
    expect(transactions.calls).toContain('countOrdersInProject');
    expect(transactions.calls).not.toContain('retargetProjectClient');
    expect(transactions.calls).not.toContain('updateOrderHeader');
  });

  it('soft-deletes an order with stale check, audit, outbox and idempotency completion', async () => {
    const transactions = new FakeOrderTransactions();
    transactions.seedOrder({ orderId: 42, version: 3 });

    const result = await new OrderTransactionService({ transactions }).delete({
      currentUser: currentUser('admin'),
      orderId: 42,
      version: 3,
      idempotencyKey: 'order-delete-key-1',
      requestId: 'request-delete-1',
    });

    expect(result).toEqual({
      success: true,
      orderId: 42,
      auditId: 'audit-delete-1',
      requestId: 'request-delete-1',
    });
    expect(transactions.state.orders.get(42)?.version).toBe(4);
    expect(transactions.state.auditEvents).toEqual([
      {
        action: 'orders.delete',
        orderId: 42,
        actorUserId: 'user_admin',
        requestId: 'request-delete-1',
        nextVersion: 4,
      },
    ]);
    expect(transactions.state.outboxEvents).toEqual([
      { eventType: 'order.deleted', orderId: 42, requestId: 'request-delete-1' },
    ]);
    expect(transactions.calls).toEqual([
      'begin',
      'setSessionUser',
      'reconcileOrderDeleteIdempotency',
      'loadOrderForDelete',
      'softDeleteOrder',
      'writeOrderDeleteAudit',
      'enqueueOrderDeleteOutbox',
      'completeOrderDeleteIdempotency',
      'commit',
    ]);
  });

  it('returns stored delete idempotency response before loading a soft-deleted order', async () => {
    const transactions = new FakeOrderTransactions();
    transactions.completedDeleteResponse = {
      success: true,
      orderId: 42,
      auditId: 'audit-delete-1',
      requestId: 'request-delete-1',
    };

    await expect(
      new OrderTransactionService({ transactions }).delete({
        currentUser: currentUser('admin'),
        orderId: 42,
        version: 999,
        idempotencyKey: 'order-delete-key-1',
        requestId: 'request-delete-1',
      }),
    ).resolves.toEqual(transactions.completedDeleteResponse);

    expect(transactions.calls).toEqual([
      'begin',
      'setSessionUser',
      'reconcileOrderDeleteIdempotency',
      'commit',
    ]);
  });

  it('rejects stale order delete before mutation, audit, outbox and idempotency completion', async () => {
    const transactions = new FakeOrderTransactions();
    transactions.seedOrder({ orderId: 42, version: 5 });

    await expect(
      new OrderTransactionService({ transactions }).delete({
        currentUser: currentUser('admin'),
        orderId: 42,
        version: 3,
        idempotencyKey: 'order-delete-key-2',
      }),
    ).rejects.toBeInstanceOf(OrderVersionConflictError);

    expect(transactions.state.auditEvents).toEqual([]);
    expect(transactions.state.outboxEvents).toEqual([]);
    expect(transactions.calls).toEqual([
      'begin',
      'setSessionUser',
      'reconcileOrderDeleteIdempotency',
      'loadOrderForDelete',
      'rollback',
    ]);
  });

  it('rejects order delete without delete permission after locking the active order', async () => {
    const transactions = new FakeOrderTransactions();
    transactions.seedOrder({ orderId: 42, version: 3 });

    await expect(
      new OrderTransactionService({ transactions }).delete({
        currentUser: currentUser('manager'),
        orderId: 42,
        version: 3,
        idempotencyKey: 'order-delete-key-3',
      }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
      details: { requiredPermissions: ['orders.delete'] },
    } satisfies Partial<ApiError>);

    expect(transactions.state.auditEvents).toEqual([]);
    expect(transactions.state.outboxEvents).toEqual([]);
    expect(transactions.calls).toEqual([
      'begin',
      'setSessionUser',
      'reconcileOrderDeleteIdempotency',
      'loadOrderForDelete',
      'rollback',
    ]);
  });

  it('returns not found for missing active order delete', async () => {
    const transactions = new FakeOrderTransactions();

    await expect(
      new OrderTransactionService({ transactions }).delete({
        currentUser: currentUser('admin'),
        orderId: 999,
        version: 1,
        idempotencyKey: 'order-delete-key-4',
      }),
    ).rejects.toMatchObject({
      code: 'ORDER_NOT_FOUND',
      statusCode: 404,
    } satisfies Partial<ApiError>);

    expect(transactions.calls).toEqual([
      'begin',
      'setSessionUser',
      'reconcileOrderDeleteIdempotency',
      'loadOrderForDelete',
      'rollback',
    ]);
  });

  describe('restore', () => {
    it('restores happy path: lockOrderName first, audit outbox, returns fresh order', async () => {
      const transactions = new FakeOrderTransactions();
      transactions.seedOrder({
        orderId: 42,
        version: 3,
        header: createHeader({ orderName: '2558' }),
        deleteFlag: true,
        deletedAt: '2026-05-02T03:04:05.000Z',
        deletedBy: 'user_admin',
      });

      const result = await new OrderTransactionService({ transactions }).restore({
        currentUser: currentUser('admin'),
        orderId: 42,
        version: 3,
        idempotencyKey: 'order-restore-key-1',
        requestId: 'request-restore-1',
      });

      expect(result).toMatchObject({
        order: {
          header: { orderId: 42, orderName: '2558' },
          version: 4,
        },
        auditId: 'audit-restore-1',
        requestId: 'request-restore-1',
      });
      expect(transactions.state.orders.get(42)).toMatchObject({
        version: 4,
        deleteFlag: false,
        deletedAt: null,
        deletedBy: null,
      });
      expect(transactions.state.auditEvents).toContainEqual({
        action: 'orders.restore',
        orderId: 42,
        actorUserId: 'user_admin',
        requestId: 'request-restore-1',
        nextVersion: 4,
        targetOrderName: '2558',
      });
      expect(transactions.state.outboxEvents).toContainEqual({
        eventType: 'order.restored',
        orderId: 42,
        requestId: 'request-restore-1',
        targetOrderName: '2558',
      });
      expect(transactions.calls).toEqual([
        'begin',
        'setSessionUser',
        'reconcileOrderRestoreIdempotency',
        'peekOrderName',
        'lockOrderName',
        'loadOrderForRestore',
        'assertOrderNameAvailable',
        'restoreOrder',
        'writeOrderRestoreAudit',
        'enqueueOrderRestoreOutbox',
        'readOrder',
        'completeOrderRestoreIdempotency',
        'commit',
      ]);
    });

    it('replays cached response for same idempotency key', async () => {
      const transactions = new FakeOrderTransactions();
      transactions.completedRestoreResponse = {
        order: createOrderDto({ orderId: 42 }),
        auditId: 'audit-restore-1',
        requestId: 'request-restore-1',
      };

      await expect(
        new OrderTransactionService({ transactions }).restore({
          currentUser: currentUser('admin'),
          orderId: 42,
          version: 999,
          idempotencyKey: 'order-restore-key-1',
          requestId: 'request-restore-1',
        }),
      ).resolves.toEqual(transactions.completedRestoreResponse);

      expect(transactions.calls).toEqual([
        'begin',
        'setSessionUser',
        'reconcileOrderRestoreIdempotency',
        'commit',
      ]);
    });

    it('throws 404 when order does not exist', async () => {
      const transactions = new FakeOrderTransactions();

      await expect(
        new OrderTransactionService({ transactions }).restore({
          currentUser: currentUser('admin'),
          orderId: 999,
          version: 1,
          idempotencyKey: 'order-restore-key-2',
        }),
      ).rejects.toMatchObject({
        code: 'ORDER_NOT_FOUND',
        statusCode: 404,
      } satisfies Partial<ApiError>);

      expect(transactions.calls).toEqual([
        'begin',
        'setSessionUser',
        'reconcileOrderRestoreIdempotency',
        'peekOrderName',
        'rollback',
        'markOrderRestoreIdempotencyFailed',
      ]);
      expect(transactions.failedRestoreIdempotencyMarks).toEqual([
        {
          actorUserId: 'user_admin',
          idempotencyKey: 'order-restore-key-2',
          orderId: 999,
          orderName: undefined,
        },
      ]);
    });

    it('throws 409 ORDER_NOT_DELETED when order is alive', async () => {
      const transactions = new FakeOrderTransactions();
      transactions.seedOrder({ orderId: 42, version: 3, deleteFlag: false });

      await expect(
        new OrderTransactionService({ transactions }).restore({
          currentUser: currentUser('admin'),
          orderId: 42,
          version: 3,
          idempotencyKey: 'order-restore-key-3',
        }),
      ).rejects.toMatchObject({
        code: 'ORDER_NOT_DELETED',
        statusCode: 409,
      } satisfies Partial<ApiError>);

      expect(transactions.calls).toEqual([
        'begin',
        'setSessionUser',
        'reconcileOrderRestoreIdempotency',
        'peekOrderName',
        'lockOrderName',
        'loadOrderForRestore',
        'rollback',
        'markOrderRestoreIdempotencyFailed',
      ]);
      expect(transactions.failedRestoreIdempotencyMarks).toEqual([
        {
          actorUserId: 'user_admin',
          idempotencyKey: 'order-restore-key-3',
          orderId: 42,
          orderName: undefined,
        },
      ]);
    });

    it('throws 409 ORDER_VERSION_CONFLICT on stale If-Match', async () => {
      const transactions = new FakeOrderTransactions();
      transactions.seedOrder({
        orderId: 42,
        version: 5,
        deleteFlag: true,
        deletedAt: '2026-05-02T03:04:05.000Z',
        deletedBy: 'user_admin',
      });

      await expect(
        new OrderTransactionService({ transactions }).restore({
          currentUser: currentUser('admin'),
          orderId: 42,
          version: 3,
          idempotencyKey: 'order-restore-key-4',
        }),
      ).rejects.toBeInstanceOf(OrderVersionConflictError);

      expect(transactions.calls).toEqual([
        'begin',
        'setSessionUser',
        'reconcileOrderRestoreIdempotency',
        'peekOrderName',
        'lockOrderName',
        'loadOrderForRestore',
        'rollback',
        'markOrderRestoreIdempotencyFailed',
      ]);
      expect(transactions.failedRestoreIdempotencyMarks).toEqual([
        {
          actorUserId: 'user_admin',
          idempotencyKey: 'order-restore-key-4',
          orderId: 42,
          orderName: undefined,
        },
      ]);
    });

    it('propagates 409 ORDER_NAME_DUPLICATE with suggestedOrderName from assertOrderNameAvailable', async () => {
      const transactions = new FakeOrderTransactions();
      transactions.seedOrder({
        orderId: 42,
        version: 3,
        header: createHeader({ orderName: '2558' }),
        deleteFlag: true,
        deletedAt: '2026-05-02T03:04:05.000Z',
        deletedBy: 'user_admin',
      });
      transactions.seedOrder({
        orderId: 77,
        version: 1,
        header: createHeader({ orderName: '2561' }),
        deleteFlag: false,
      });

      await expect(
        new OrderTransactionService({ transactions }).restore({
          currentUser: currentUser('admin'),
          orderId: 42,
          version: 3,
          idempotencyKey: 'order-restore-key-5',
          orderName: '2561',
        }),
      ).rejects.toMatchObject({
        code: 'ORDER_NAME_DUPLICATE',
        statusCode: 409,
        details: expect.objectContaining({ suggestedOrderName: '2562' }),
      });

      expect(transactions.calls).toEqual([
        'begin',
        'setSessionUser',
        'reconcileOrderRestoreIdempotency',
        'lockOrderName',
        'loadOrderForRestore',
        'assertOrderNameAvailable',
        'rollback',
        'markOrderRestoreIdempotencyFailed',
      ]);
      expect(transactions.failedRestoreIdempotencyMarks).toEqual([
        {
          actorUserId: 'user_admin',
          idempotencyKey: 'order-restore-key-5',
          orderId: 42,
          orderName: '2561',
        },
      ]);
    });

    it('restores under body orderName override and hashes it into idempotency', async () => {
      const transactions = new FakeOrderTransactions();
      transactions.seedOrder({
        orderId: 42,
        version: 3,
        header: createHeader({ orderName: '2558' }),
        deleteFlag: true,
        deletedAt: '2026-05-02T03:04:05.000Z',
        deletedBy: 'user_admin',
      });

      await expect(
        new OrderTransactionService({ transactions }).restore({
          currentUser: currentUser('admin'),
          orderId: 42,
          version: 3,
          idempotencyKey: 'order-restore-key-6',
          orderName: '  2561  ' as unknown as string,
        }),
      ).resolves.toMatchObject({
        order: { header: { orderName: '2561' } },
      });

      expect(transactions.lockedOrderNames).toEqual(['2561']);
      expect(transactions.calls).not.toContain('peekOrderName');
      expect(transactions.lastRestoreIdempotencyInput).toMatchObject({
        orderName: '2561',
      });
    });

    it('throws 403 PERMISSION_DENIED without orders.delete scope, records denied audit, and does not mutate', async () => {
      const transactions = new FakeOrderTransactions();
      transactions.seedOrder({
        orderId: 42,
        version: 3,
        deleteFlag: true,
        deletedAt: '2026-05-02T03:04:05.000Z',
        deletedBy: 'user_admin',
        createdByUserId: 'user_admin',
        managerUserId: 'user_admin',
      });

      await expect(
        new OrderTransactionService({ transactions }).restore({
          currentUser: currentUser('viewer'),
          orderId: 42,
          version: 3,
          idempotencyKey: 'order-restore-key-7',
          requestId: 'request-restore-denied',
        }),
      ).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
        statusCode: 403,
        details: { requiredPermissions: ['orders.delete'] },
      } satisfies Partial<ApiError>);

      expect(transactions.state.deniedRestoreAudits).toEqual([
        {
          orderId: 42,
          requestId: 'request-restore-denied',
          actorUserId: 'user_viewer',
        },
      ]);
      expect(transactions.state.auditEvents).toEqual([]);
      expect(transactions.state.outboxEvents).toEqual([]);
      expect(transactions.state.orders.get(42)).toMatchObject({
        version: 3,
        deleteFlag: true,
      });
      expect(transactions.calls).toEqual([
        'begin',
        'setSessionUser',
        'reconcileOrderRestoreIdempotency',
        'peekOrderName',
        'lockOrderName',
        'loadOrderForRestore',
        'recordOrderRestoreDenied',
        'rollback',
        'markOrderRestoreIdempotencyFailed',
      ]);
      expect(transactions.failedRestoreIdempotencyMarks).toEqual([
        {
          actorUserId: 'user_viewer',
          idempotencyKey: 'order-restore-key-7',
          orderId: 42,
          orderName: undefined,
        },
      ]);
    });

    it('does not let denied-audit failure mask the 403', async () => {
      const transactions = new FakeOrderTransactions();
      transactions.seedOrder({
        orderId: 42,
        version: 3,
        deleteFlag: true,
        deletedAt: '2026-05-02T03:04:05.000Z',
        deletedBy: 'user_admin',
        createdByUserId: 'user_admin',
        managerUserId: 'user_admin',
      });
      transactions.failAt = 'recordOrderRestoreDenied';

      await expect(
        new OrderTransactionService({ transactions }).restore({
          currentUser: currentUser('viewer'),
          orderId: 42,
          version: 3,
          idempotencyKey: 'order-restore-key-8',
        }),
      ).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
        statusCode: 403,
      } satisfies Partial<ApiError>);
    });

    it('coerces orderName to trimmed string before locking', async () => {
      const transactions = new FakeOrderTransactions();
      transactions.seedOrder({
        orderId: 42,
        version: 3,
        header: createHeader({ orderName: '2558' }),
        deleteFlag: true,
        deletedAt: '2026-05-02T03:04:05.000Z',
        deletedBy: 'user_admin',
      });

      await expect(
        new OrderTransactionService({ transactions }).restore({
          currentUser: currentUser('admin'),
          orderId: 42,
          version: 3,
          idempotencyKey: 'order-restore-key-9',
          orderName: 2561 as unknown as string,
        }),
      ).resolves.toMatchObject({
        order: { header: { orderName: '2561' } },
      });

      expect(transactions.lockedOrderNames.at(-1)).toBe('2561');
    });

    it('replays failed idempotency state after a burned restore key', async () => {
      const transactions = new FakeOrderTransactions();
      transactions.seedOrder({
        orderId: 42,
        version: 3,
        header: createHeader({ orderName: '2558' }),
        deleteFlag: true,
        deletedAt: '2026-05-02T03:04:05.000Z',
        deletedBy: 'user_admin',
      });
      transactions.seedOrder({
        orderId: 77,
        version: 1,
        header: createHeader({ orderName: '2561' }),
        deleteFlag: false,
      });
      const service = new OrderTransactionService({ transactions });
      const command = {
        currentUser: currentUser('admin'),
        orderId: 42,
        version: 3,
        idempotencyKey: 'order-restore-key-burned',
        orderName: '2561',
      } satisfies RestoreOrderCommand;

      await expect(service.restore(command)).rejects.toMatchObject({
        code: 'ORDER_NAME_DUPLICATE',
        statusCode: 409,
      } satisfies Partial<ApiError>);
      await expect(service.restore(command)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_FAILED',
        statusCode: 409,
      } satisfies Partial<ApiError>);

      expect(
        transactions.calls.filter((call) => call === 'markOrderRestoreIdempotencyFailed'),
      ).toHaveLength(1);
    });

    it('does not burn a successful restore key', async () => {
      const transactions = new FakeOrderTransactions();
      transactions.seedOrder({
        orderId: 42,
        version: 3,
        header: createHeader({ orderName: '2558' }),
        deleteFlag: true,
        deletedAt: '2026-05-02T03:04:05.000Z',
        deletedBy: 'user_admin',
      });

      await expect(
        new OrderTransactionService({ transactions }).restore({
          currentUser: currentUser('admin'),
          orderId: 42,
          version: 3,
          idempotencyKey: 'order-restore-key-success',
        }),
      ).resolves.toMatchObject({
        order: { header: { orderName: '2558' } },
      });

      expect(transactions.failedRestoreIdempotencyMarks).toEqual([]);
      expect(transactions.calls).not.toContain('markOrderRestoreIdempotencyFailed');
    });

    it.each([
      [
        new OrderRestoreIdempotencyKeyReusedError('order-restore-key-reused'),
        'order-restore-key-reused',
      ],
      [
        new OrderRestoreIdempotencyInProgressError('order-restore-key-processing'),
        'order-restore-key-processing',
      ],
      [
        new OrderRestoreIdempotencyFailedError('order-restore-key-failed'),
        'order-restore-key-failed',
      ],
    ])('does not burn restore keys for existing idempotency state errors (%s)', async (error, idempotencyKey) => {
      const transactions = new FakeOrderTransactions();
      transactions.restoreIdempotencyError = error;

      await expect(
        new OrderTransactionService({ transactions }).restore({
          currentUser: currentUser('admin'),
          orderId: 42,
          version: 3,
          idempotencyKey,
        }),
      ).rejects.toBe(error);

      expect(transactions.failedRestoreIdempotencyMarks).toEqual([]);
      expect(transactions.calls).not.toContain('markOrderRestoreIdempotencyFailed');
    });
  });

  it('returns version conflict before child mutations and does not write audit', async () => {
    const transactions = new FakeOrderTransactions();
    transactions.seedOrder({ orderId: 42, version: 2 });

    await expect(
      new OrderTransactionService({ transactions }).update({
        currentUser: currentUser('manager'),
        orderId: 42,
        dto: createSaveDto({ version: 1 }),
      }),
    ).rejects.toBeInstanceOf(OrderVersionConflictError);

    expect(transactions.rolledBack).toBe(1);
    expect(transactions.state.auditEvents).toEqual([]);
    expect(transactions.calls).toEqual([
      'begin',
      'setSessionUser',
      'lockOrderName',
      'readOrderClientProject',
      'loadOrderForUpdate',
      'rollback',
    ]);
  });

  it('rejects users without orders.create permission before any write mutation', async () => {
    const transactions = new FakeOrderTransactions();

    await expect(
      new OrderTransactionService({ transactions }).create({
        currentUser: currentUser('viewer'),
        dto: createSaveDto(),
      }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
    } satisfies Partial<ApiError>);

    expect(transactions.state.orders.size).toBe(0);
    expect(transactions.state.auditEvents).toEqual([]);
    expect(transactions.calls).toEqual(['begin', 'setSessionUser', 'rollback']);
  });

  it.each([
    ['operator', currentUser('operator')],
    ['viewer with order create permission', userWithPermissions('viewer', ['orders.create'])],
  ])('rejects payment-bearing create for %s without finance visibility', async (_label, actor) => {
    const transactions = new FakeOrderTransactions();

    await expect(
      new OrderTransactionService({ transactions }).create({
        currentUser: actor,
        dto: createSaveDto(),
      }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
      details: { requiredPermissions: ['orders.view_financials'] },
    } satisfies Partial<ApiError>);

    expect(transactions.state.orders.size).toBe(0);
    expect(transactions.state.auditEvents).toEqual([]);
    expect(transactions.calls).toEqual(['begin', 'setSessionUser', 'rollback']);
  });

  it.each([
    ['operator', currentUser('operator')],
    ['viewer with order update permission', userWithPermissions('viewer', ['orders.update'])],
  ])('rejects payment deletion for %s without finance visibility', async (_label, actor) => {
    const transactions = new FakeOrderTransactions();
    transactions.seedOrder({
      orderId: 42,
      version: 3,
      payments: [payment({ id: 21, amount: 1000 })],
    });

    await expect(
      new OrderTransactionService({ transactions }).update({
        currentUser: actor,
        orderId: 42,
        dto: createSaveDto({
          payments: [],
          deleted: { paymentIds: [21] },
          version: 3,
        }),
      }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
      details: { requiredPermissions: ['orders.view_financials'] },
    } satisfies Partial<ApiError>);

    expect(transactions.state.orders.get(42)?.payments).toHaveLength(1);
    expect(transactions.state.auditEvents).toEqual([]);
    expect(transactions.calls).toEqual(['begin', 'setSessionUser', 'rollback']);
  });

  it('requires payments.delete for nested order-save payment deletion', async () => {
    const transactions = new FakeOrderTransactions();
    transactions.seedOrder({
      orderId: 42,
      version: 3,
      payments: [payment({ id: 21, amount: 1000 })],
    });

    await expect(
      new OrderTransactionService({ transactions }).update({
        currentUser: currentUser('manager'),
        orderId: 42,
        dto: createSaveDto({
          payments: [],
          deleted: { paymentIds: [21] },
          version: 3,
        }),
      }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
      details: { requiredPermissions: ['payments.delete'] },
    } satisfies Partial<ApiError>);

    expect(transactions.state.orders.get(42)?.payments).toHaveLength(1);
    expect(transactions.state.auditEvents).toEqual([]);
    expect(transactions.calls).toEqual(['begin', 'setSessionUser', 'lockOrderName', 'readOrderClientProject', 'loadOrderForUpdate', 'rollback']);
  });

  it('omits payment rows from save responses when actor cannot view payments', async () => {
    const transactions = new FakeOrderTransactions();
    const actor = userWithPermissions('viewer', [
      'orders.create',
      'orders.view_financials',
      'payments.create',
      'payments.update',
      // VARIANT B: all orders touch sheet path (sheetMaterialTypeId on every detail)
      'sheet_materials.view',
    ]);

    const result = await new OrderTransactionService({ transactions }).create({
      currentUser: actor,
      dto: createSaveDto(),
    });

    expect(result.payments).toEqual([]);
    expect(transactions.state.orders.get(100)?.payments).toHaveLength(1);
  });

  it('requires payments.update for explicit payment status changes through order save', async () => {
    const transactions = new FakeOrderTransactions();
    transactions.seedOrder({
      orderId: 42,
      version: 3,
      payments: [],
    });

    await expect(
      new OrderTransactionService({ transactions }).update({
        currentUser: {
          ...userWithPermissions('manager', ['orders.update', 'orders.view_financials']),
          id: 'user_manager',
        },
        orderId: 42,
        dto: createSaveDto({
          header: {
            orderId: 42,
            orderName: 'Updated order',
            clientId: 1001,
            orderDate: '2026-04-30',
            orderStatusId: 1001,
            paymentStatusId: 42,
          },
          payments: [],
          version: 3,
        }),
      }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
      details: { requiredPermissions: ['payments.update'] },
    } satisfies Partial<ApiError>);

    expect(transactions.state.auditEvents).toEqual([]);
  });

  it('rejects financial order fields for actors without finance visibility even without payment rows', async () => {
    const transactions = new FakeOrderTransactions();
    const operationalOnlyDto = createSaveDto({
      header: {
        orderName: 'Operational order',
        clientId: 1001,
        orderDate: '2026-04-30',
        orderStatusId: 1001,
      },
      details: [
        {
          clientKey: 'detail-temp-1',
          height: 550,
          width: 200,
          quantity: 2,
          materialId: null,
          sheetMaterialTypeId: 1001,
          millingTypeId: 1001,
          edgeTypeId: 1001,
        },
      ],
      payments: [],
      requirements: [
        {
          clientKey: 'requirement-temp-1',
          resourceType: 'material',
          materialId: 1001,
          requiredQuantity: 1,
          unitId: 1,
          requirementStatusId: 1,
          purchasePrice: 100,
        },
      ],
    });

    await expect(
      new OrderTransactionService({ transactions }).create({
        currentUser: currentUser('operator'),
        dto: operationalOnlyDto,
      }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
      details: { requiredPermissions: ['orders.view_financials'] },
    } satisfies Partial<ApiError>);

    expect(transactions.state.orders.size).toBe(0);
    expect(transactions.state.auditEvents).toEqual([]);
    expect(transactions.calls).toEqual(['begin', 'setSessionUser', 'rollback']);
  });

  it('rolls back created header and skips success audit when a child write fails', async () => {
    const transactions = new FakeOrderTransactions();
    transactions.failAt = 'upsertPayments';

    await expect(
      new OrderTransactionService({ transactions }).create({
        currentUser: currentUser('manager'),
        dto: createSaveDto(),
      }),
    ).rejects.toThrow('Injected failure at upsertPayments');

    expect(transactions.state.orders.size).toBe(0);
    expect(transactions.state.auditEvents).toEqual([]);
    expect(transactions.calls).toEqual([
      'begin',
      'setSessionUser',
      'lockOrderName',
      'assertOrderNameAvailable',
      'validateSheetReferences',
      'resolveProjectForCreate',
      'createOrderHeader',
      'upsertDetails',
      'deleteDetails',
      'upsertPayments',
      'rollback',
    ]);
  });

  it('detail sheet change with unchanged header emits detailSheetMaterialChanges in before/after (Critic R7 M2)', async () => {
    // Scenario: only a detail's sheetMaterialTypeId changes; the order header is identical.
    // The audit before/after MUST carry detailSheetMaterialChanges so computeDiff() can
    // emit a queryable diff_json entry (not just opaque metadata).
    const transactions = new FakeOrderTransactions();
    // Seed order with detail id=11, sheetMaterialTypeId=777 (before value).
    transactions.seedOrder({
      orderId: 42,
      version: 5,
      details: [calculatedDetail({ id: 11, sheetMaterialTypeId: 777 })],
    });

    // Update: same header, only sheetMaterialTypeId on detail 11 changes (777 → 888).
    await new OrderTransactionService({ transactions }).update({
      currentUser: currentUser('manager'),
      orderId: 42,
      dto: createSaveDto({
        header: {
          orderId: 42,
          orderName: 'Test order',  // SAME as default in createSaveDto
          clientId: 1001,
          orderDate: '2026-04-30',
          orderStatusId: 1001,
          discount: 0,
          surcharge: 0,
        },
        details: [
          {
            id: 11,
            height: 550,
            width: 200,
            quantity: 2,
            materialId: null,
            sheetMaterialTypeId: 888,  // changed
            millingTypeId: 1001,
            edgeTypeId: 1001,
            detailCost: 10000,
          },
        ],
        payments: [],
        version: 5,
      }),
    });

    expect(transactions.state.auditEvents).toHaveLength(1);
    const event = transactions.state.auditEvents[0] as OrderSaveAuditEvent;

    // Before snapshot must contain detailSheetMaterialChanges with the stored (before) ref.
    const beforeObj = event.before as Record<string, unknown> | null;
    expect(beforeObj).toBeTruthy();
    expect(Array.isArray(beforeObj!['detailSheetMaterialChanges'])).toBe(true);
    const beforeRefs = beforeObj!['detailSheetMaterialChanges'] as Array<{ detailId?: number; sheetMaterialTypeId: number | null }>;
    // The before snapshot should capture the stored sheet id (777) for detail 11.
    expect(beforeRefs.some((r) => r.detailId === 11 && r.sheetMaterialTypeId === 777)).toBe(true);

    // After snapshot must contain detailSheetMaterialChanges with the new (after) ref.
    const afterObj = event.after as Record<string, unknown> | null;
    expect(afterObj).toBeTruthy();
    expect(Array.isArray(afterObj!['detailSheetMaterialChanges'])).toBe(true);
    const afterRefs = afterObj!['detailSheetMaterialChanges'] as Array<{ detailId?: number; sheetMaterialTypeId: number | null }>;
    expect(afterRefs.some((r) => r.detailId === 11 && r.sheetMaterialTypeId === 888)).toBe(true);
  });

  it('collects active and deleted child ids for DB ownership checks', () => {
    const refs = collectChildReferences({
      ...createPreparedNormalizedOrder(),
      details: [calculatedDetail({ id: 11 })],
      payments: [payment({ id: 21 })],
      workshops: [workshop({ id: 31 })],
      requirements: [requirement({ id: 41 })],
      dowelingLinks: [dowelingLink({ id: 51 })],
      deleted: {
        detailIds: [12],
        paymentIds: [22],
        workshopIds: [32],
        requirementIds: [42],
        dowelingLinkIds: [52],
      },
    });

    expect(refs).toEqual([
      { entityType: 'detail', id: 11 },
      { entityType: 'detail', id: 12 },
      { entityType: 'payment', id: 21 },
      { entityType: 'payment', id: 22 },
      { entityType: 'workshop', id: 31 },
      { entityType: 'workshop', id: 32 },
      { entityType: 'requirement', id: 41 },
      { entityType: 'requirement', id: 42 },
      { entityType: 'dowelingLink', id: 51 },
      { entityType: 'dowelingLink', id: 52 },
    ]);
  });
});

function createSaveDto(overrides: Partial<SaveOrderDto> = {}): SaveOrderDto {
  return {
    header: {
      orderName: 'Test order',
      clientId: 1001,
      orderDate: '2026-04-30',
      orderStatusId: 1001,
      discount: 500,
      surcharge: 0,
    },
    details: [
      {
        clientKey: 'detail-temp-1',
        height: 550,
        width: 200,
        quantity: 2,
        materialId: null,
        sheetMaterialTypeId: 1001,
        millingTypeId: 1001,
        edgeTypeId: 1001,
        detailCost: 10000,
      },
    ],
    payments: [
      {
        clientKey: 'payment-temp-1',
        typePaidId: 1001,
        amount: 3000,
        paymentDate: '2026-04-30',
      },
    ],
    workshops: [],
    requirements: [],
    dowelingLinks: [],
    deleted: {},
    ...overrides,
  };
}

function currentUser(role: UserRole): CurrentUser {
  return {
    id: `user_${role}`,
    username: role,
    role,
    roleId: 10,
    permissions: getPermissionsForRole(role),
  };
}

function userWithPermissions(role: UserRole, permissions: PermissionName[]): CurrentUser {
  return {
    id: `user_${role}_custom`,
    username: `${role}_custom`,
    role,
    roleId: role === 'viewer' ? 100 : 10,
    permissions,
  };
}

function createHeader(
  overrides: Partial<NormalizedSaveOrderHeaderDto> = {},
): NormalizedSaveOrderHeaderDto {
  return {
    orderName: 'Seed order',
    clientId: 1001,
    orderDate: '2026-04-30',
    priority: 100,
    orderStatusId: 1001,
    paymentStatusId: 1,
    productionStatusId: null,
    productionStatusFromDetailsEnabled: true,
    plannedCompletionDate: null,
    completionDate: null,
    issueDate: null,
    paymentDate: null,
    discount: 0,
    surcharge: 0,
    linkCuttingFile: null,
    linkCuttingImageFile: null,
    linkCadFile: null,
    linkPdfFile: null,
    notes: null,
    refKey1c: null,
    materialId: null,
    millingTypeId: null,
    edgeTypeId: null,
    filmId: null,
    ...overrides,
  };
}

function createTotals(overrides: Partial<OrderTotalsDto> = {}): OrderTotalsDto {
  return {
    positionsCount: 0,
    partsCount: 0,
    totalArea: 0,
    totalAmount: 0,
    discount: 0,
    surcharge: 0,
    finalAmount: 0,
    paidAmount: 0,
    debtAmount: 0,
    paymentDate: null,
    paymentStatusId: 1,
    ...overrides,
  };
}

function calculatedDetail(
  overrides: Partial<CalculatedOrderDetailDto & { id: number }> = {},
): CalculatedOrderDetailDto & { id?: number } {
  return {
    detailNumber: 1,
    detailName: null,
    height: 550,
    width: 200,
    quantity: 2,
    materialId: null,
    sheetMaterialTypeId: 1001,
    millingTypeId: 1001,
    edgeTypeId: 1001,
    filmId: null,
    area: 0.22,
    millingCostPerSqm: null,
    detailCost: 10000,
    priority: 100,
    productionStatusId: null,
    jointOrderId: null,
    note: null,
    linkCuttingFile: null,
    linkCuttingImageFile: null,
    linkCadFile: null,
    linkPdfFile: null,
    refKey1c: null,
    ...overrides,
  };
}

function payment(
  overrides: Partial<NormalizedSaveOrderPaymentDto & { id: number }> = {},
): NormalizedSaveOrderPaymentDto & { id?: number } {
  return {
    typePaidId: 1001,
    amount: 3000,
    paymentDate: '2026-04-30',
    notes: null,
    refKey1c: null,
    ...overrides,
  };
}

function workshop(
  overrides: Partial<NormalizedSaveOrderWorkshopDto & { id: number }> = {},
): NormalizedSaveOrderWorkshopDto & { id?: number } {
  return {
    workshopId: 1001,
    productionStatusId: 1001,
    receivedDate: null,
    startedDate: null,
    completedDate: null,
    plannedCompletionDate: null,
    sequenceOrder: null,
    responsibleEmployeeId: null,
    notes: null,
    refKey1c: null,
    ...overrides,
  };
}

function requirement(
  overrides: Partial<NormalizedSaveOrderRequirementDto & { id: number }> = {},
): NormalizedSaveOrderRequirementDto & { id?: number } {
  return {
    resourceType: 'material',
    materialId: 1001,
    filmId: null,
    edgeTypeId: null,
    requiredQuantity: 2,
    unitId: 1001,
    wastePercentage: null,
    finalQuantity: null,
    requirementStatusId: 1001,
    supplierId: null,
    purchasePrice: null,
    requisitionId: null,
    warehouseId: null,
    reservedAt: null,
    consumedAt: null,
    notes: null,
    calculationDetails: null,
    refKey1c: null,
    ...overrides,
  };
}

function dowelingLink(
  overrides: Partial<NormalizedSaveOrderDowelingLinkDto & { id: number }> = {},
): NormalizedSaveOrderDowelingLinkDto & { id?: number } {
  return {
    dowelingOrderId: 1001,
    designEngineerId: null,
    refKey1c: null,
    ...overrides,
  };
}

function createPreparedNormalizedOrder() {
  return {
    header: createHeader(),
    details: [],
    payments: [],
    workshops: [],
    requirements: [],
    dowelingLinks: [],
    deleted: {
      detailIds: [],
      paymentIds: [],
      workshopIds: [],
      requirementIds: [],
      dowelingLinkIds: [],
    },
  };
}

function cloneState(state: FakeState): FakeState {
  return {
    ...state,
    orders: new Map(
      [...state.orders.entries()].map(([orderId, order]) => [
        orderId,
        {
          ...order,
          header: { ...order.header },
          details: order.details.map((detail) => ({ ...detail })),
          payments: order.payments.map((item) => ({ ...item })),
          workshops: order.workshops.map((item) => ({ ...item })),
          requirements: order.requirements.map((item) => ({ ...item })),
          dowelingLinks: order.dowelingLinks.map((item) => ({ ...item })),
          totals: { ...order.totals },
          projectId: order.projectId,
          projectCode: order.projectCode,
        },
      ]),
    ),
    projects: new Map(
      [...state.projects.entries()].map(([projectId, project]) => [projectId, { ...project }]),
    ),
    auditEvents: state.auditEvents.map((event) => ({ ...event })),
    outboxEvents: state.outboxEvents.map((event) => ({ ...event })),
    deniedRestoreAudits: state.deniedRestoreAudits.map((event) => ({ ...event })),
  };
}

function getCollection(
  order: FakeOrderRecord,
  entityType: OrderChildReference['entityType'],
): Array<{ id?: number }> {
  if (entityType === 'detail') return order.details;
  if (entityType === 'payment') return order.payments;
  if (entityType === 'workshop') return order.workshops;
  if (entityType === 'requirement') return order.requirements;
  return order.dowelingLinks;
}

function upsertRows<T extends { id?: number }>(
  existing: T[],
  incoming: readonly T[],
  nextId: () => number,
): T[] {
  const rows = [...existing];

  incoming.forEach((item) => {
    const nextItem = { ...item, id: item.id ?? nextId() };
    const index = rows.findIndex((row) => row.id === nextItem.id);

    if (index >= 0) {
      rows[index] = nextItem;
      return;
    }

    rows.push(nextItem);
  });

  return rows;
}

function createOrderDto(overrides: { orderId: number; orderName?: string; version?: number }): OrderDto {
  return toOrderDto({
    orderId: overrides.orderId,
    header: createHeader({ orderName: overrides.orderName ?? 'Test order' }),
    details: [],
    payments: [],
    workshops: [],
    requirements: [],
    dowelingLinks: [],
    totals: createTotals(),
    version: overrides.version ?? 1,
    createdByUserId: 'user_admin',
    managerUserId: 'user_admin',
    projectId: null,
    projectCode: null,
    createdAt: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
    deleteFlag: false,
    deletedAt: null,
    deletedBy: null,
  });
}

function toOrderDto(order: FakeOrderRecord): OrderDto {
  return {
    header: {
      ...order.header,
      orderId: order.orderId,
      projectId: order.projectId,
      projectCode: order.projectCode,
      paymentDate: order.totals.paymentDate,
      paymentStatusId: order.totals.paymentStatusId,
      totalAmount: order.totals.totalAmount,
      finalAmount: order.totals.finalAmount,
      paidAmount: order.totals.paidAmount,
      partsCount: order.totals.partsCount,
      totalArea: order.totals.totalArea,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      version: order.version,
    },
    details: order.details.map((detail) => ({ ...detail, id: detail.id as number, orderId: order.orderId })),
    payments: order.payments.map((payment) => ({
      ...payment,
      id: payment.id as number,
      orderId: order.orderId,
    })),
    workshops: order.workshops.map((workshopItem) => ({
      ...workshopItem,
      id: workshopItem.id as number,
      orderId: order.orderId,
    })),
    requirements: order.requirements.map((requirementItem) => ({
      ...requirementItem,
      id: requirementItem.id as number,
      orderId: order.orderId,
    })),
    dowelingLinks: order.dowelingLinks.map((link) => ({
      ...link,
      id: link.id as number,
      orderId: order.orderId,
    })),
    totals: {
      totalAmount: order.totals.totalAmount,
      finalAmount: order.totals.finalAmount,
      paidAmount: order.totals.paidAmount,
      debtAmount: order.totals.debtAmount,
      partsCount: order.totals.partsCount,
      totalArea: order.totals.totalArea,
    },
    version: order.version,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}
