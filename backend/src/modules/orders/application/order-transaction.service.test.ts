import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole, type PermissionName, type UserRole } from '../../../permissions/permissions';
import type { DeleteOrderResponseDto, OrderDto } from '../dto/order.dto';
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
import {
  ChildEntityNotFoundError,
  ChildEntityNotOwnedError,
  OrderVersionConflictError,
} from '../errors/order.errors';
import type {
  LockedOrderRow,
  LockedOrderDeleteRow,
  OrderChildReference,
  OrderDeleteAuditInput,
  OrderDeleteIdempotencyResult,
  OrderDeleteOutboxInput,
  OrderSaveAuditEvent,
  OrderTransactionManagerPort,
  OrderWriteUnitOfWork,
  SaveContext,
  SheetReferenceValidationInput,
  StoredOrderSheetState,
} from './order-transaction.types';
import { collectChildReferences, OrderTransactionService } from './order-transaction.service';

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
  createdAt: string;
  updatedAt: string;
}

interface FakeState {
  nextOrderId: number;
  nextDetailId: number;
  nextPaymentId: number;
  nextWorkshopId: number;
  nextRequirementId: number;
  nextDowelingLinkId: number;
  orders: Map<number, FakeOrderRecord>;
  auditEvents: Array<OrderSaveAuditEvent | { action: 'orders.delete'; orderId: number; actorUserId: string; requestId: string; nextVersion: number }>;
  outboxEvents: Array<{ eventType: string; orderId: number; requestId: string }>;
}

class FakeOrderTransactions implements OrderTransactionManagerPort {
  calls: string[] = [];
  committed = 0;
  rolledBack = 0;
  failAt?: string;
  state: FakeState = {
    nextOrderId: 100,
    nextDetailId: 1000,
    nextPaymentId: 2000,
    nextWorkshopId: 3000,
    nextRequirementId: 4000,
    nextDowelingLinkId: 5000,
    orders: new Map(),
    auditEvents: [],
    outboxEvents: [],
  };
  completedDeleteResponse?: DeleteOrderResponseDto;

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
      createdAt: record.createdAt ?? '2026-04-30T00:00:00.000Z',
      updatedAt: record.updatedAt ?? '2026-04-30T00:00:00.000Z',
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

  setSaveContext(_context: SaveContext): void {
    this.call('setSaveContext');
  }

  async loadStoredOrderSheetState(_orderId: number): Promise<StoredOrderSheetState> {
    this.call('loadStoredOrderSheetState');
    return { sheetEligible: false, headerSheetMaterialTypeId: null, detailSheetIds: [] };
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

  async completeOrderDeleteIdempotency(): Promise<void> {
    this.call('completeOrderDeleteIdempotency');
  }

  async loadOrderForUpdate(orderId: number): Promise<LockedOrderRow | null> {
    this.call('loadOrderForUpdate');
    const order = this.state.orders.get(orderId);
    return order
      ? {
          orderId,
          version: order.version,
          createdByUserId: order.createdByUserId,
          managerUserId: order.managerUserId,
        }
      : null;
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
      createdAt: now,
      updatedAt: now,
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

  async softDeleteOrder(input: { orderId: number; previousVersion: number }): Promise<number> {
    this.call('softDeleteOrder');
    const order = this.getOrder(input.orderId);
    order.version = input.previousVersion + 1;
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
    expect(transactions.calls).toEqual([
      'begin',
      'setSessionUser',
      'validateNoShadowInjection',
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
            materialId: 1001,
            millingTypeId: 1001,
            edgeTypeId: 1001,
            detailCost: 7000,
          },
          {
            clientKey: 'new-detail',
            height: 1000,
            width: 500,
            quantity: 1,
            materialId: 1001,
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
    expect(transactions.calls.slice(0, 7)).toEqual([
      'begin',
      'setSessionUser',
      'loadOrderForUpdate',
      'loadOrderHeaderSnapshot',
      'validateNoShadowInjection',
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
            materialId: 1001,
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
            materialId: 1001,
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
            materialId: 1001,
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
    expect(transactions.calls).toEqual(['begin', 'setSessionUser', 'loadOrderForUpdate', 'rollback']);
  });

  it('omits payment rows from save responses when actor cannot view payments', async () => {
    const transactions = new FakeOrderTransactions();
    const actor = userWithPermissions('viewer', [
      'orders.create',
      'orders.view_financials',
      'payments.create',
      'payments.update',
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
          materialId: 1001,
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
      'validateNoShadowInjection',
      'createOrderHeader',
      'upsertDetails',
      'deleteDetails',
      'upsertPayments',
      'rollback',
    ]);
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
        materialId: 1001,
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
    materialId: 1001,
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
        },
      ]),
    ),
    auditEvents: state.auditEvents.map((event) => ({ ...event })),
    outboxEvents: state.outboxEvents.map((event) => ({ ...event })),
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

function toOrderDto(order: FakeOrderRecord): OrderDto {
  return {
    header: {
      ...order.header,
      orderId: order.orderId,
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
