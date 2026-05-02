import { ApiError } from '../../../common/errors/api-error';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { ExportOrderResponseDto } from '../dto/export-order.dto';
import type { OrderPermissionCheckerPort } from './order-transaction.types';
import { InMemoryOrderExportRateLimiter } from './order-export-rate-limiter';
import type {
  ExportOrderCommand,
  OrderExportPort,
  OrderExportRateLimiterPort,
} from './order-export.types';

export interface OrderExportServicePorts {
  exporter: OrderExportPort;
  permissions?: OrderPermissionCheckerPort;
  rateLimiter?: OrderExportRateLimiterPort;
}

export class OrderExportService {
  private readonly permissions: OrderPermissionCheckerPort;
  private readonly rateLimiter: OrderExportRateLimiterPort;

  constructor(private readonly ports: OrderExportServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
    this.rateLimiter = ports.rateLimiter ?? new InMemoryOrderExportRateLimiter();
  }

  async exportToGoogleDrive(command: ExportOrderCommand): Promise<ExportOrderResponseDto> {
    if (!this.permissions.canUser(command.currentUser, 'orders.export')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['orders.export'],
      });
    }

    this.rateLimiter.assertAllowed(command);

    return this.ports.exporter.exportToGoogleDrive(command);
  }
}
