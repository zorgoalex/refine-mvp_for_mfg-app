import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import type { OrderDto } from '../dto/order.dto';
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

export interface LockedOrderRow {
  orderId: number;
  version: number;
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
}

export interface OrderWriteUnitOfWork {
  setSessionUser(userId: string): Promise<void>;
  loadOrderForUpdate(orderId: number): Promise<LockedOrderRow | null>;
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
  writeAuditEvent(event: OrderSaveAuditEvent): Promise<void>;
  readOrder(orderId: number): Promise<OrderDto>;
}

export interface OrderTransactionManagerPort {
  runInTransaction<T>(handler: (unitOfWork: OrderWriteUnitOfWork) => Promise<T>): Promise<T>;
}

export interface OrderPermissionCheckerPort {
  canUser(user: CurrentUser | null | undefined, permission: PermissionName): boolean;
}
