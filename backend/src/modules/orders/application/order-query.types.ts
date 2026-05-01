import type { CurrentUser } from '../../../permissions/current-user';
import type { OrderDto, OrderListResponseDto } from '../dto/order.dto';

export const ORDER_LIST_SORT_FIELDS = [
  'orderId',
  'orderName',
  'orderDate',
  'plannedCompletionDate',
  'completionDate',
  'issueDate',
  'clientName',
  'orderStatusName',
  'paymentStatusName',
  'productionStatusName',
  'finalAmount',
  'paidAmount',
  'debtAmount',
  'updatedAt',
] as const;

export type OrderListSortBy = (typeof ORDER_LIST_SORT_FIELDS)[number];
export type SortOrder = 'asc' | 'desc';

export interface OrderListQuery {
  page: number;
  pageSize: number;
  sortBy: OrderListSortBy;
  sortOrder: SortOrder;
  search?: string;
  clientId?: number;
  orderStatusId?: number;
  paymentStatusId?: number;
  productionStatusId?: number;
  dateFrom?: string;
  dateTo?: string;
  onlyMyOrders: boolean;
}

export interface ListOrdersCommand {
  currentUser: CurrentUser;
  query: OrderListQuery;
}

export interface GetOrderByIdCommand {
  currentUser: CurrentUser;
  orderId: number;
}

export interface OrderReadRepositoryPort {
  listOrders(command: ListOrdersCommand): Promise<OrderListResponseDto>;
  getOrderById(command: GetOrderByIdCommand): Promise<OrderDto | null>;
}
