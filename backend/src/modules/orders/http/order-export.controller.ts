import { Body, Controller, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { OrderExportService } from '../application/order-export.service';
import type {
  ExportOrderRequestDto,
  ExportOrderResponseDto,
  NormalizedExportOrderRequestDto,
} from '../dto/export-order.dto';
import { parseOrderId } from './orders.controller';
import { OrdersRuntimeConfigService } from './orders-runtime-config.service';

@Controller('orders')
export class OrderExportController {
  constructor(
    @Inject(OrderExportService)
    private readonly exports: OrderExportService,
    @Inject(OrdersRuntimeConfigService)
    private readonly runtimeConfig: OrdersRuntimeConfigService,
  ) {}

  @Post(':orderId/export/google-drive')
  async exportToGoogleDrive(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Body() body: ExportOrderRequestDto = {},
  ): Promise<ExportOrderResponseDto> {
    this.assertExportEnabled();

    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return this.exports.exportToGoogleDrive({
      currentUser: request.user,
      orderId: parseOrderId(orderIdParam),
      request: normalizeExportOrderRequest(body),
    });
  }

  private assertExportEnabled(): void {
    const flags = this.runtimeConfig.getFeatureFlags();

    if (!flags.ordersEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is disabled', {
        feature: 'orders',
      });
    }

    if (!flags.orderExportEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Order export API is disabled', {
        feature: 'order_export',
      });
    }

    if (flags.exportDisabled !== false) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Order export is disabled', {
        feature: 'order_export',
        mode: 'disabled',
      });
    }
  }
}

export function normalizeExportOrderRequest(
  body: ExportOrderRequestDto | undefined,
): NormalizedExportOrderRequestDto {
  const format = body?.format ?? 'xlsx';

  if (format !== 'xlsx') {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Export request validation failed', {
      errors: [{ field: 'format', message: 'format must be xlsx' }],
    });
  }

  const fileName = body?.fileName === undefined || body.fileName === null
    ? null
    : String(body.fileName).trim();

  if (fileName !== null && fileName.length > 255) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Export request validation failed', {
      errors: [{ field: 'fileName', message: 'fileName must be 255 characters or fewer' }],
    });
  }

  return {
    format,
    fileName: fileName || null,
  };
}
