import type { CurrentUser } from '../../../permissions/current-user';
import type {
  OrderStatusBoardResponseDto,
  OrderStatusBoardType,
} from '../dto/order-status-board.dto';

export interface OrderStatusBoardQuery {
  board: OrderStatusBoardType;
  column?: string;
  cursor?: string;
  limit: number;
  search?: string;
  onlyMyOrders: boolean;
  overdueOnly: boolean;
  includeDone?: boolean;
  plannedFrom?: string;
  plannedTo?: string;
}

export interface GetOrderStatusBoardCommand {
  currentUser: CurrentUser;
  query: OrderStatusBoardQuery;
}

export interface OrderStatusBoardRepositoryPort {
  getBoard(command: GetOrderStatusBoardCommand): Promise<OrderStatusBoardResponseDto>;
}
