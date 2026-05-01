import { ApiError } from '../../../common/errors/api-error';
import type { ExportOrderResponseDto } from '../dto/export-order.dto';
import type { ExportOrderCommand, OrderExportPort } from '../application/order-export.types';

export class UnavailableOrderExporter implements OrderExportPort {
  async exportToGoogleDrive(_command: ExportOrderCommand): Promise<ExportOrderResponseDto> {
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Order export adapter is not configured', {
      feature: 'order_export',
      adapter: 'order_exporter',
    });
  }
}
