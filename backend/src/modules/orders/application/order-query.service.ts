import { ApiError } from '../../../common/errors/api-error';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { OrderFormDataResponseDto } from '../dto/order-form-data.dto';
import type { OrderDto, OrderListResponseDto } from '../dto/order.dto';
import { OrderNotFoundError } from '../errors/order.errors';
import type { OrderPermissionCheckerPort } from './order-transaction.types';
import type {
  GetOrderFormDataCommand,
  GetOrderByIdCommand,
  ListOrdersCommand,
  OrderReadRepositoryPort,
} from './order-query.types';

export interface OrderQueryServicePorts {
  reader: OrderReadRepositoryPort;
  permissions?: OrderPermissionCheckerPort;
}

export class OrderQueryService {
  private readonly permissions: OrderPermissionCheckerPort;

  constructor(private readonly ports: OrderQueryServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async list(command: ListOrdersCommand): Promise<OrderListResponseDto> {
    this.requireViewPermission(command);
    return this.ports.reader.listOrders(command);
  }

  async getById(command: GetOrderByIdCommand): Promise<OrderDto> {
    this.requireViewPermission(command);

    const order = await this.ports.reader.getOrderById(command);

    if (!order) {
      throw new OrderNotFoundError(command.orderId);
    }

    return order;
  }

  async getFormData(command: GetOrderFormDataCommand): Promise<OrderFormDataResponseDto> {
    this.requireViewPermission(command);
    return this.ports.reader.getOrderFormData(command);
  }

  private requireViewPermission(command: Pick<ListOrdersCommand, 'currentUser'>): void {
    if (!this.permissions.canUser(command.currentUser, 'orders.view')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['orders.view'],
      });
    }
  }
}
