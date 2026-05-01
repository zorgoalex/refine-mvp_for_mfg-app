import { ApiError } from '../../../common/errors/api-error';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { ExportOrderResponseDto } from '../dto/export-order.dto';
import type { OrderPermissionCheckerPort } from './order-transaction.types';
import type { ExportOrderCommand, OrderExportPort } from './order-export.types';

export interface OrderExportServicePorts {
  exporter: OrderExportPort;
  permissions?: OrderPermissionCheckerPort;
}

export class OrderExportService {
  private readonly permissions: OrderPermissionCheckerPort;

  constructor(private readonly ports: OrderExportServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async exportToGoogleDrive(command: ExportOrderCommand): Promise<ExportOrderResponseDto> {
    if (!this.permissions.canUser(command.currentUser, 'orders.export')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['orders.export'],
      });
    }

    return this.ports.exporter.exportToGoogleDrive(command);
  }
}
