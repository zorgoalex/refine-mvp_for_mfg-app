import { Body, Controller, Get, Inject, Param, Post, Put, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../../permissions/current-user';
import { OrderResourceDemandService } from '../application/order-resource-demand.service';
import {
  RESOURCE_PROCUREMENT_BULK_LIMIT,
  type BulkOrderResourceProcurementResultDto,
  type OrderResourceCardResponseDto,
  type OrderResourceProcurementResultDto,
  type SetOrderResourceProcurementInput,
} from '../application/order-resource-demand.types';
import { OrdersRuntimeConfigService } from './orders-runtime-config.service';

const fingerprint = z.string().regex(/^[0-9a-f]{64}$/, 'expectedDemandFingerprint must be a sha256 hex digest');
const expectedVersion = z.number().int().min(0).max(2147483646);
const setSchema = z.object({
  purchased: z.boolean(),
  expectedVersion,
  expectedDemandFingerprint: fingerprint,
}).strict();
const bulkSchema = z.object({
  resourceKey: z.string().min(1).max(64),
  purchased: z.boolean(),
  items: z.array(z.object({
    orderId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expectedVersion,
    expectedDemandFingerprint: fingerprint,
  }).strict()).min(1).max(RESOURCE_PROCUREMENT_BULK_LIMIT),
}).strict();

@ApiTags('Orders')
@ApiBearerAuth()
@Controller('orders')
export class OrderResourceProcurementController {
  constructor(
    @Inject(OrderResourceDemandService)
    private readonly demands: OrderResourceDemandService,
    @Inject(OrdersRuntimeConfigService)
    private readonly runtimeConfig: OrdersRuntimeConfigService,
  ) {}

  @ApiResponse({ status: 200, description: 'Order resource card with the details behind each line' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found or outside the user scope' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled' })
  @ApiOperation({ operationId: 'getOrderResourceDemandCard', summary: 'Resource demand card of one order' })
  @Get(':orderId/resource-demands')
  async card(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') rawOrderId: string,
  ): Promise<OrderResourceCardResponseDto> {
    const user = this.requireUser(request, false);
    return this.demands.getCard(
      { currentUser: user, orderId: parseOrderId(rawOrderId) },
      { procurementEnabled: this.procurementEnabled(), canSeeAmounts: user.permissions.includes('finance.view') },
    );
  }

  @ApiResponse({ status: 200, description: 'Purchase mark state after the command (no-op when unchanged)' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found or outside the user scope' })
  @ApiResponse({ status: 409, description: 'Stale version or changed demand' })
  @ApiResponse({ status: 422, description: 'Invalid body or material not in the order' })
  @ApiResponse({ status: 503, description: 'Orders API or procurement is disabled' })
  @ApiOperation({ operationId: 'setOrderResourceProcurement', summary: 'Mark an order material as purchased or not' })
  @Put(':orderId/resource-procurement/:resourceKey')
  async set(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') rawOrderId: string,
    @Param('resourceKey') resourceKey: string,
    @Body() body: unknown,
  ): Promise<OrderResourceProcurementResultDto> {
    const user = this.requireUser(request, true);
    const input: SetOrderResourceProcurementInput = parseBody(setSchema, body);
    return this.demands.setProcurement({
      ...input,
      currentUser: user,
      orderId: parseOrderId(rawOrderId),
      resourceKey,
      requestId: request.requestId ?? 'unknown',
    });
  }

  @ApiResponse({ status: 200, description: 'Per-order results; all or nothing' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Some order not found or outside the user scope' })
  @ApiResponse({ status: 409, description: 'Some orders changed; nothing written' })
  @ApiResponse({ status: 422, description: 'Invalid body' })
  @ApiResponse({ status: 503, description: 'Orders API or procurement is disabled' })
  @ApiOperation({ operationId: 'bulkSetOrderResourceProcurement', summary: 'Mark one material purchased across several orders' })
  @Post('resource-procurement/bulk')
  async bulk(
    @Req() request: RequestWithCurrentUser,
    @Body() body: unknown,
  ): Promise<BulkOrderResourceProcurementResultDto> {
    const user = this.requireUser(request, true);
    const input = parseBody(bulkSchema, body);
    return this.demands.bulkProcurement({
      ...input,
      currentUser: user,
      requestId: request.requestId ?? 'unknown',
    });
  }

  private procurementEnabled(): boolean {
    return this.runtimeConfig.getFeatureFlags().resourceProcurementEnabled === true;
  }

  private requireUser(request: RequestWithCurrentUser, write: boolean): CurrentUser {
    const flags = this.runtimeConfig.getFeatureFlags();
    if (!flags.ordersEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is disabled', { feature: 'orders' });
    }
    if (write && flags.ordersReadOnly) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is read-only', { feature: 'orders' });
    }
    if (write && flags.resourceProcurementEnabled !== true) {
      throw new ApiError(503, 'PROCUREMENT_DISABLED', 'Отметка закупа пока выключена', { feature: 'resourceProcurement' });
    }
    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }
    return request.user;
  }
}

function parseOrderId(value: string): number {
  if (!/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ApiError(422, 'ORDER_ID_INVALID', 'Некорректный номер заказа', { field: 'orderId' });
  }
  return Number(value);
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(422, 'PROCUREMENT_INVALID_INPUT', 'Некорректные данные отметки закупа', {
      issues: result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
    });
  }
  return result.data;
}
