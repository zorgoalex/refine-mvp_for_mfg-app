import { ApiError } from '../../../common/errors/api-error';
import type {
  GetOrderStatusBoardCommand,
  OrderStatusBoardRepositoryPort,
} from '../application/order-status-board.types';
import type { OrderStatusBoardResponseDto } from '../dto/order-status-board.dto';

export class UnavailableOrderStatusBoardRepository implements OrderStatusBoardRepositoryPort {
  async getBoard(_command: GetOrderStatusBoardCommand): Promise<OrderStatusBoardResponseDto> {
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders read adapter is not configured', {
      feature: 'order_status_board',
      adapter: 'order_status_board_repository',
    });
  }
}

