import { ApiError } from '../../../common/errors/api-error';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { OrderPermissionCheckerPort } from './order-transaction.types';
import type {
  ListOrderResourceDemandsCommand,
  OrderResourceDemandRepositoryPort,
  OrderResourceDemandResponseDto,
} from './order-resource-demand.types';

export interface OrderResourceDemandServicePorts {
  demands: OrderResourceDemandRepositoryPort;
  permissions?: OrderPermissionCheckerPort;
}

export class OrderResourceDemandService {
  private readonly permissions: OrderPermissionCheckerPort;

  constructor(private readonly ports: OrderResourceDemandServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async list(command: ListOrderResourceDemandsCommand): Promise<OrderResourceDemandResponseDto> {
    if (!this.permissions.canUser(command.currentUser, 'orders.view')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра потребностей заказов', {
        requiredPermissions: ['orders.view'],
      });
    }

    return this.ports.demands.list(command);
  }
}
