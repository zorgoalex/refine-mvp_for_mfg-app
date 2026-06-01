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
}

export interface UpdateOrderCommand {
  currentUser: CurrentUser;
  orderId: number;
  dto: SaveOrderDto;
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

export interface OrderSaveAuditEvent {
  action: 'orders.create' | 'orders.update';
  orderId: number;
  actorUserId: string;
  actorUsername?: string | null;
  actorRole?: string | null;
  clientId?: number | null;
  requestId?: string;
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
  reconcileOrderDeleteIdempotency(command: DeleteOrderCommand): Promise<OrderDeleteIdempotencyResult>;
  completeOrderDeleteIdempotency(
    idempotencyKey: string,
    response: DeleteOrderResponseDto,
  ): Promise<void>;
  loadOrderForUpdate(orderId: number): Promise<LockedOrderRow | null>;
  loadOrderForDelete(orderId: number): Promise<LockedOrderDeleteRow | null>;
  assertChildOwnership(orderId: number, refs: readonly OrderChildReference[]): Promise<void>;
  createOrderHeader(input: {
    header: NormalizedSaveOrderHeaderDto;
    totals: OrderTotalsDto;
    currentUser: CurrentUser;
  }): Promise<number>;
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
  }): Promise<void>;
}
