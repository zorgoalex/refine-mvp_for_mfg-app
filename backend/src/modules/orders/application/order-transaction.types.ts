import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
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

export interface CreateOrderCommand {
  currentUser: CurrentUser;
  dto: SaveOrderDto;
  requestId?: string;
}

export interface UpdateOrderCommand {
  currentUser: CurrentUser;
  orderId: number;
  dto: SaveOrderDto;
  requestId?: string;
}

export interface DeleteOrderCommand {
  currentUser: CurrentUser;
  orderId: number;
  version: number;
  idempotencyKey: string;
  requestId?: string;
}

export interface LockedOrderRow {
  orderId: number;
  version: number;
  createdByUserId: string | null;
  managerUserId: string | null;
}

export interface LockedOrderDeleteRow {
  orderId: number;
  orderName: string;
  clientId: number | null;
  version: number;
  createdByUserId: string | null;
  managerUserId: string | null;
}

export interface OrderDeleteIdempotencyResult {
  completedResponse?: DeleteOrderResponseDto;
}

export interface OrderCreateIdempotencyResult {
  completedResponse?: OrderDto | null;
}

export interface ResolvedProjectForCreate {
  projectId: number;
  created: boolean;
  code: string;
}

export interface LockedProjectRow {
  projectId: number;
  clientId: number;
  code: string;
}

export type OrderChildEntityType =
  | 'detail'
  | 'payment'
  | 'workshop'
  | 'requirement'
  | 'dowelingLink';

export interface OrderChildReference {
  entityType: OrderChildEntityType;
  id: number;
}

/** Stable-keyed detail sheet-id snapshot for audit metadata (detailId/tempKey, never detailNumber). */
export interface DetailSheetAuditRef {
  detailId?: number;
  tempKey?: string;
  sheetMaterialTypeId: number | null;
}

export interface OrderSaveAuditMetadata {
  commandName: string;
  requestId?: string;
  detailSheetMaterialTypeIds?: {
    before: DetailSheetAuditRef[];
    after: DetailSheetAuditRef[];
  };
}

export interface OrderSaveAuditEvent {
  action: 'orders.create' | 'orders.update';
  orderId: number;
  actorUserId: string;
  actorUsername?: string | null;
  actorRole?: string | null;
  clientId?: number | null;
  requestId?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: OrderSaveAuditMetadata;
  relatedSheetMaterialTypeIds?: number[];
}

/** Transaction-scoped context threaded into shadow-material audit writes. */
export interface SaveContext {
  actorUserId: number | null;
  requestId?: string;
  source: string;
  clientId?: number | null;
}

/** Stored SP3 sheet state of an existing order (for new-only/no-clear + permission gate). */
export interface StoredOrderSheetState {
  sheetEligible: boolean;
  headerSheetMaterialTypeId: number | null;
  detailSheetIds: Array<{ detailId: number; sheetMaterialTypeId: number | null }>;
}

/** Header + detail sheet/material refs handed to the tx-scoped sheet reference validator. */
export interface SheetReferenceValidationInput {
  header: { sheetMaterialTypeId: number | null; materialId: number | null };
  details: ReadonlyArray<{
    label: string;
    detailId?: number;
    sheetMaterialTypeId: number | null;
    materialId: number | null;
    height: number;
    width: number;
  }>;
}

export interface OrderDeleteAuditInput {
  currentUser: CurrentUser;
  requestId: string;
  order: LockedOrderDeleteRow;
  nextVersion: number;
}

export interface OrderDeleteOutboxInput extends OrderDeleteAuditInput {
  auditId: string;
  idempotencyKey: string;
}

export interface OrderWriteUnitOfWork {
  setSessionUser(userId: string): Promise<void>;
  /** SP3: transaction-scoped context for shadow-material audit attribution. */
  setSaveContext(context: SaveContext): void;
  /** SP3: stored sheet state of an existing order (new-only/no-clear + permission gate). */
  loadStoredOrderSheetState(orderId: number): Promise<StoredOrderSheetState>;
  /** SP3: tx-scoped existence + dimension + anti-injection validation (422 on violation). */
  validateSheetReferences(input: SheetReferenceValidationInput): Promise<void>;
  /**
   * SP3: shadow-material anti-injection only — runs on EVERY save (legacy included) so a
   * payload can't smuggle a shadow material_id with a null sheet id. 422 on violation.
   */
  validateNoShadowInjection(input: SheetReferenceValidationInput): Promise<void>;
  resolveProjectForCreate(input: {
    projectId: number | null;
    clientId: number;
    orderName: string;
    currentUser: CurrentUser;
    requestId: string;
  }): Promise<ResolvedProjectForCreate>;
  reconcileOrderCreateIdempotency(input: {
    idempotencyKey: string;
    currentUser: CurrentUser;
    dto: SaveOrderDto;
  }): Promise<OrderCreateIdempotencyResult>;
  completeOrderCreateIdempotency(idempotencyKey: string, response: OrderDto): Promise<void>;
  reconcileOrderDeleteIdempotency(command: DeleteOrderCommand): Promise<OrderDeleteIdempotencyResult>;
  completeOrderDeleteIdempotency(
    idempotencyKey: string,
    response: DeleteOrderResponseDto,
  ): Promise<void>;
  loadOrderHeaderSnapshot(orderId: number): Promise<Record<string, unknown> | null>;
  loadOrderForUpdate(orderId: number): Promise<LockedOrderRow | null>;
  loadOrderForDelete(orderId: number): Promise<LockedOrderDeleteRow | null>;
  assertChildOwnership(orderId: number, refs: readonly OrderChildReference[]): Promise<void>;
  createOrderHeader(input: {
    header: NormalizedSaveOrderHeaderDto;
    totals: OrderTotalsDto;
    projectId: number;
    currentUser: CurrentUser;
  }): Promise<number>;
  lockProjectForOrder(orderId: number): Promise<LockedProjectRow>;
  countOrdersInProject(projectId: number): Promise<number>;
  retargetProjectClient(
    projectId: number,
    clientId: number,
    currentUser: CurrentUser,
    requestId?: string,
  ): Promise<void>;
  updateOrderHeader(input: {
    orderId: number;
    header: NormalizedSaveOrderHeaderDto;
    totals: OrderTotalsDto;
    currentUser: CurrentUser;
  }): Promise<void>;
  upsertDetails(orderId: number, details: readonly CalculatedOrderDetailDto[]): Promise<void>;
  deleteDetails(orderId: number, ids: readonly number[]): Promise<void>;
  upsertPayments(orderId: number, payments: readonly NormalizedSaveOrderPaymentDto[]): Promise<void>;
  deletePayments(orderId: number, ids: readonly number[]): Promise<void>;
  upsertWorkshops(
    orderId: number,
    workshops: readonly NormalizedSaveOrderWorkshopDto[],
  ): Promise<void>;
  deleteWorkshops(orderId: number, ids: readonly number[]): Promise<void>;
  upsertRequirements(
    orderId: number,
    requirements: readonly NormalizedSaveOrderRequirementDto[],
  ): Promise<void>;
  deleteRequirements(orderId: number, ids: readonly number[]): Promise<void>;
  upsertDowelingLinks(
    orderId: number,
    links: readonly NormalizedSaveOrderDowelingLinkDto[],
  ): Promise<void>;
  deleteDowelingLinks(orderId: number, ids: readonly number[]): Promise<void>;
  updateOrderTotalsAndVersion(input: {
    orderId: number;
    totals: OrderTotalsDto;
    previousVersion: number | null;
    currentUser: CurrentUser;
  }): Promise<number>;
  softDeleteOrder(input: { orderId: number; previousVersion: number }): Promise<number>;
  writeAuditEvent(event: OrderSaveAuditEvent): Promise<void>;
  writeOrderDeleteAudit(input: OrderDeleteAuditInput): Promise<string>;
  enqueueOrderDeleteOutbox(input: OrderDeleteOutboxInput): Promise<void>;
  readOrder(orderId: number): Promise<OrderDto>;
}

export interface OrderTransactionManagerPort {
  runInTransaction<T>(handler: (unitOfWork: OrderWriteUnitOfWork) => Promise<T>): Promise<T>;
}

export interface OrderPermissionCheckerPort {
  canUser(user: CurrentUser | null | undefined, permission: PermissionName): boolean;
}

export interface OrderDeadlineSyncPort {
  syncOrderDeadlinesAfterSave(input: {
    orderId: number;
    currentUser: CurrentUser;
    eventType: 'ORDER_CREATED' | 'ORDER_UPDATED';
    requestId?: string;
  }): Promise<void>;
}
