import { Body, Controller, Inject, Param, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
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

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

const exportOrderRequestSwaggerSchema = {
  type: 'object',
  properties: {
    format: { type: 'string', enum: ['xlsx'], default: 'xlsx' },
    fileName: { type: 'string', maxLength: 255, nullable: true },
  },
} as const;

const exportOrderResponseSwaggerSchema = {
  type: 'object',
  required: ['success', 'fileName'],
  properties: {
    success: { type: 'boolean' },
    fileName: { type: 'string' },
    folder: { type: 'string', nullable: true },
    xlsxUrl: { type: 'string', nullable: true },
    externalId: { type: 'string', nullable: true },
  },
} as const;

@ApiTags('Order Export')
@ApiBearerAuth()
@Controller('orders')
export class OrderExportController {
  constructor(
    @Inject(OrderExportService)
    private readonly exports: OrderExportService,
    @Inject(OrdersRuntimeConfigService)
    private readonly runtimeConfig: OrdersRuntimeConfigService,
  ) {}

  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiBody({ required: false, schema: swaggerSchema(exportOrderRequestSwaggerSchema) })
  @ApiResponse({ status: 201, description: 'Exported order file', schema: swaggerSchema(exportOrderResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 422, description: 'Invalid export request' })
  @ApiResponse({ status: 429, description: 'Export rate limit exceeded' })
  @ApiResponse({ status: 502, description: 'Upstream provider export failure' })
  @ApiResponse({ status: 503, description: 'Orders or order export API is disabled' })
  @ApiResponse({ status: 504, description: 'Upstream provider export timeout' })
  @ApiOperation({ operationId: 'exportOrderToGoogleDrive', summary: 'Export an order to Google Drive' })
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
      requestId: request.requestId,
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
