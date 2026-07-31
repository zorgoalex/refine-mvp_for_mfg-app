import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import type { TransactionClient } from '../../../database/database.types';
import type { StatusAutomationEvent } from '../../status-automation/application/status-automation.types';
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

export interface CreateOrderCommand {
  currentUser: CurrentUser;
  dto: SaveOrderDto;
  requestId?: string;
  postPersistHook?: (
    uow: OrderWriteUnitOfWork,
    created: { orderId: number; detailIdsByClientKey: Map<string, number> },
  ) => Promise<void>;
}

export interface OrderDefaultSchedule {
  version: number;
  reserveDays: number;
  transitionsOrder?: Record<string, string[]>;
  stages: ReadonlyArray<{
    productionStatusId: number;
    productionStatusCode?: string | null;
    durationDays: number;
    parallelWithPrevious: boolean;
  }>;
}

export interface OrderDefaultSchedulePort {
  getConfiguredSchedule(client: TransactionClient): Promise<OrderDefaultSchedule | null>;
}

export interface UpdateOrderCommand {
  currentUser: CurrentUser;
  orderId: number;
  dto: SaveOrderDto;
  requestId?: string;
  prePersistHook?: (uow: OrderWriteUnitOfWork, locked: LockedOrderRow) => Promise<void>;
  postPersistHook?: (
    uow: OrderWriteUnitOfWork,
    updated: { orderId: number; detailIdsByClientKey: Map<string, number> },
  ) => Promise<void>;
}

export interface DeleteOrderCommand {
  currentUser: CurrentUser;
  orderId: number;
  version: number;
  idempotencyKey: string;
  requestId?: string;
}

export interface RestoreOrderCommand {
  currentUser: CurrentUser;
  orderId: number;
  version: number;
  idempotencyKey: string;
  orderName?: string;
  requestId?: string;
}

export interface LockedOrderRow {
  orderId: number;
  orderName: string;
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

export interface LockedOrderRestoreRow {
  orderId: number;
  orderName: string;
  clientId: number | null;
  version: number;
  createdByUserId: string | null;
  managerUserId: string | null;
  deleteFlag: boolean;
  deletedAt: string | null;
  deletedBy: string | null;
}

export interface OrderDeleteIdempotencyResult {
  completedResponse?: DeleteOrderResponseDto;
}

export interface OrderRestoreIdempotencyResult {
  completedResponse?: RestoreOrderResponseDto;
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

export interface OrderStatusAuditInfo {
  statusId: number;
  statusName: string;
  statusCode: string | null;
}

export interface ProductionStatusAuditInfo {
  statusId: number;
  statusName: string;
  statusCode: string | null;
}

export interface OrderDetailStatusAuditRow {
  detailId: number;
  detailNumber: number | null;
  productionStatusId: number | null;
  productionStatusName: string | null;
  productionStatusCode: string | null;
}

export interface OrderSaveAuditMetadata {
  commandName: string;
  requestId?: string;
  detailSheetMaterialTypeIds?: {
    before: DetailSheetAuditRef[];
    after: DetailSheetAuditRef[];
  };
  defaultSchedule?: {
    version: number;
    headerApplied: boolean;
    workshops: Array<{
      clientKey?: string;
      productionStatusId: number;
    }>;
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

export interface OrderStatusAuditEvent {
  action:
    | 'orders.status_change'
    | 'orders.production_status_change'
    | 'orders.detail_production_status_change';
  orderId: number;
  detailId?: number;
  actorUserId: string;
  actorUsername?: string | null;
  actorRole?: string | null;
  clientId?: number | null;
  requestId?: string;
  statusField: 'orderStatus' | 'productionCurrentStatus' | 'productionDetailStage';
  statusId: number | null;
  statusName?: string | null;
  statusCode?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  diff?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export interface OrderStatusOutboxEvent {
  eventType: 'order.status_changed' | 'order.production_status_changed';
  orderId: number;
  clientId: number | null;
  actorUserId: string;
  requestId: string;
  idempotencyKey: string;
  sourceIdempotencyKey?: string;
  payload: Record<string, unknown>;
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

export interface OrderRestoreAuditInput {
  currentUser: CurrentUser;
  requestId: string;
  order: LockedOrderRestoreRow;
  targetOrderName: string;
  nextVersion: number;
}

export interface OrderRestoreOutboxInput extends OrderRestoreAuditInput {
  auditId: string;
  idempotencyKey: string;
}

export interface OrderWriteUnitOfWork {
  setSessionUser(userId: string): Promise<void>;
  getTransactionClient(): TransactionClient;
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
  completeOrderRestoreIdempotency(
    idempotencyKey: string,
    response: RestoreOrderResponseDto,
  ): Promise<void>;
  loadOrderHeaderSnapshot(orderId: number): Promise<Record<string, unknown> | null>;
  loadOrderStatusAuditInfo(statusId: number | null): Promise<OrderStatusAuditInfo | null>;
  loadProductionStatusAuditInfo(statusId: number | null): Promise<ProductionStatusAuditInfo | null>;
  loadOrderDetailStatusAuditRows(orderId: number): Promise<OrderDetailStatusAuditRow[]>;
  peekOrderName(orderId: number): Promise<string | null>;
  loadOrderForUpdate(orderId: number): Promise<LockedOrderRow | null>;
  /**
   * Advisory xact lock по нормализованному номеру заказа. Берётся ПЕРВЫМ,
   * до project/order row-локов (единый порядок advisory→project→order во всех
   * командах — иначе create↔update deadlock, Critic R1-1); сериализует два
   * конкурентных сохранения одного номера.
   */
  lockOrderName(orderName: string): Promise<void>;
  /**
   * Гейт уникальности номера среди живых (delete_flag=false) заказов; кидает
   * OrderNameDuplicateError с предложенным следующим числовым номером.
   * Вызывается ПОД уже взятым lockOrderName. Обхода нет by design.
   */
  assertOrderNameAvailable(input: { orderName: string; excludeOrderId?: number }): Promise<void>;
  loadOrderForDelete(orderId: number): Promise<LockedOrderDeleteRow | null>;
  loadOrderForRestore(orderId: number): Promise<LockedOrderRestoreRow | null>;
  recordOrderRestoreDenied(input: {
    currentUser: CurrentUser;
    orderId: number;
    requestId: string;
  }): Promise<void>;
  assertChildOwnership(orderId: number, refs: readonly OrderChildReference[]): Promise<void>;
  createOrderHeader(input: {
    header: NormalizedSaveOrderHeaderDto;
    totals: OrderTotalsDto;
    projectId: number;
    currentUser: CurrentUser;
  }): Promise<number>;
  /** Unlocked pre-read for the projects-before-orders lock ordering in update. */
  readOrderClientProject(orderId: number): Promise<{ clientId: number | null; projectId: number } | null>;
  /** Lock a project row ahead of the order row (global lock order with move/merge). */
  lockProjectById(projectId: number): Promise<void>;
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
  softDeleteOrder(input: {
    orderId: number;
    previousVersion: number;
    actorUserId: string;
  }): Promise<number>;
  restoreOrder(input: {
    orderId: number;
    previousVersion: number;
    targetOrderName: string;
    actorUserId: string;
  }): Promise<number>;
  writeAuditEvent(event: OrderSaveAuditEvent): Promise<void>;
  writeStatusAuditEvent(event: OrderStatusAuditEvent): Promise<void>;
  enqueueStatusOutboxEvent(event: OrderStatusOutboxEvent): Promise<void>;
  evaluateStatusAutomation(event: StatusAutomationEvent): Promise<void>;
  writeOrderDeleteAudit(input: OrderDeleteAuditInput): Promise<string>;
  enqueueOrderDeleteOutbox(input: OrderDeleteOutboxInput): Promise<void>;
  writeOrderRestoreAudit(input: OrderRestoreAuditInput): Promise<string>;
  enqueueOrderRestoreOutbox(input: OrderRestoreOutboxInput): Promise<void>;
  readOrder(orderId: number): Promise<OrderDto>;
}

export interface OrderTransactionManagerPort {
  runInTransaction<T>(handler: (unitOfWork: OrderWriteUnitOfWork) => Promise<T>): Promise<T>;
  reserveOrderRestoreIdempotency(
    command: RestoreOrderCommand,
  ): Promise<OrderRestoreIdempotencyResult>;
  markOrderRestoreIdempotencyFailed(command: RestoreOrderCommand): Promise<void>;
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
