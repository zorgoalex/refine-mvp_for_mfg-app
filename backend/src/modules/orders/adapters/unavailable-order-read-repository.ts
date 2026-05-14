import { ApiError } from '../../../common/errors/api-error';
import type { OrderFormDataResponseDto } from '../dto/order-form-data.dto';
import type { OrderAuditListResponseDto, OrderDto, OrderListResponseDto } from '../dto/order.dto';
import type {
  GetOrderFormDataCommand,
  GetOrderAuditCommand,
  GetOrderByIdCommand,
  ListOrdersCommand,
  OrderReadRepositoryPort,
} from '../application/order-query.types';

export class UnavailableOrderReadRepository implements OrderReadRepositoryPort {
  async listOrders(_command: ListOrdersCommand): Promise<OrderListResponseDto> {
    throw unavailableReadAdapterError();
  }

  async getOrderById(_command: GetOrderByIdCommand): Promise<OrderDto | null> {
    throw unavailableReadAdapterError();
  }

  async getOrderAudit(_command: GetOrderAuditCommand): Promise<OrderAuditListResponseDto> {
    throw unavailableReadAdapterError();
  }

  async getOrderFormData(_command: GetOrderFormDataCommand): Promise<OrderFormDataResponseDto> {
    throw unavailableReadAdapterError();
  }
}

function unavailableReadAdapterError(): ApiError {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders read adapter is not configured', {
    feature: 'orders',
    adapter: 'order_read_repository',
  });
}
