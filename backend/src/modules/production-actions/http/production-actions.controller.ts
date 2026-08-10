import { Body, Controller, Delete, HttpCode, Inject, Param, Patch, Put, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { ProductionActionService } from '../application/production-action.service';
import type {
  BatchDetailProductionStatusRequestDto,
  BatchDetailProductionStatusResponseDto,
  ChangeOrderStatusRequestDto,
  ChangePaymentStatusRequestDto,
  ChangeProductionStatusRequestDto,
  DetailProductionStageEventRequestDto,
  EnterManualProductionStatusRequestDto,
  MoveCalendarDateRequestDto,
  ProductionActionResponseDto,
  ProductionStageEventRequestDto,
  RestoreAutoProductionStatusRequestDto,
} from '../dto/production-action.dto';
import { ProductionActionsRuntimeConfigService } from './production-actions-runtime-config.service';

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'plannedCompletionDate must be YYYY-MM-DD');
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const versionSchema = z.number().int().nonnegative();

const calendarDateRequestSchema = z.object({
  plannedCompletionDate: dateOnlySchema.nullable(),
  version: versionSchema,
  idempotencyKey: idempotencyKeySchema,
});

const orderStatusRequestSchema = z.object({
  orderStatusId: z.number().int().positive(),
  version: versionSchema,
  idempotencyKey: idempotencyKeySchema,
});

const paymentStatusRequestSchema = z.object({
  paymentStatusId: z.number().int().positive(),
  version: versionSchema,
  idempotencyKey: idempotencyKeySchema,
});

const productionStatusRequestSchema = z.object({
  productionStatusId: z.number().int().positive(),
  version: versionSchema,
  idempotencyKey: idempotencyKeySchema,
});

const stageEventRequestSchema = z.object({
  version: versionSchema,
  idempotencyKey: idempotencyKeySchema,
});

const detailStageEventRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  note: z.string().trim().max(1000).nullable().optional(),
});

const productionStatusModeRequestSchema = z.object({
  version: versionSchema,
  idempotencyKey: idempotencyKeySchema,
});

const batchDetailProductionStatusRequestSchema = z.object({
  detailIds: z.array(z.number().int().positive()).min(1).max(500),
  productionStatusId: z.number().int().positive(),
  version: versionSchema,
  idempotencyKey: idempotencyKeySchema,
});

const actionVersionFieldsSwaggerSchema = {
  version: { type: 'integer', minimum: 0 },
  idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
} as const;

const productionStatusModeRequestSwaggerSchema = {
  type: 'object',
  required: ['version', 'idempotencyKey'],
  properties: actionVersionFieldsSwaggerSchema,
} as const;

const moveCalendarDateRequestSwaggerSchema = {
  type: 'object',
  required: ['plannedCompletionDate', 'version', 'idempotencyKey'],
  properties: {
    plannedCompletionDate: { type: 'string', format: 'date', nullable: true },
    ...actionVersionFieldsSwaggerSchema,
  },
} as const;

const changeOrderStatusRequestSwaggerSchema = {
  type: 'object',
  required: ['orderStatusId', 'version', 'idempotencyKey'],
  properties: {
    orderStatusId: { type: 'integer' },
    ...actionVersionFieldsSwaggerSchema,
  },
} as const;

const changePaymentStatusRequestSwaggerSchema = {
  type: 'object',
  required: ['paymentStatusId', 'version', 'idempotencyKey'],
  properties: {
    paymentStatusId: { type: 'integer' },
    ...actionVersionFieldsSwaggerSchema,
  },
} as const;

const changeProductionStatusRequestSwaggerSchema = {
  type: 'object',
  required: ['productionStatusId', 'version', 'idempotencyKey'],
  properties: {
    productionStatusId: { type: 'integer', minimum: 1 },
    ...actionVersionFieldsSwaggerSchema,
  },
} as const;

const productionStageEventRequestSwaggerSchema = {
  type: 'object',
  required: ['version', 'idempotencyKey'],
  properties: actionVersionFieldsSwaggerSchema,
} as const;

const productionActionResponseSwaggerSchema = {
  type: 'object',
  required: ['order', 'requestId'],
  properties: {
    order: {
      type: 'object',
      required: ['orderId', 'version'],
      properties: {
        orderId: { type: 'integer' },
        plannedCompletionDate: { type: 'string', format: 'date', nullable: true },
        orderStatusId: { type: 'integer' },
        paymentStatusId: { type: 'integer' },
        productionStatusId: { type: 'integer' },
        productionStatusFromDetailsEnabled: { type: 'boolean' },
        version: { type: 'integer' },
      },
    },
    event: {
      type: 'object',
      required: ['productionStatusId', 'active'],
      properties: {
        productionEventId: { type: 'integer' },
        productionStatusId: { type: 'integer' },
        active: { type: 'boolean' },
      },
    },
    auditId: { type: 'string' },
    requestId: { type: 'string' },
  },
} as const;

const batchDetailProductionStatusRequestSwaggerSchema = {
  type: 'object',
  required: ['detailIds', 'productionStatusId', 'version', 'idempotencyKey'],
  properties: {
    detailIds: {
      type: 'array',
      items: { type: 'integer', minimum: 1 },
      minItems: 1,
      maxItems: 500,
    },
    productionStatusId: { type: 'integer', minimum: 1 },
    ...actionVersionFieldsSwaggerSchema,
  },
} as const;

const batchDetailProductionStatusResponseSwaggerSchema = {
  type: 'object',
  required: ['order', 'selectedDetailCount', 'affectedDetailCount', 'requestId'],
  properties: {
    order: {
      type: 'object',
      required: ['orderId', 'version'],
      properties: {
        orderId: { type: 'integer' },
        productionStatusId: { type: 'integer' },
        version: { type: 'integer' },
      },
    },
    selectedDetailCount: { type: 'integer' },
    affectedDetailCount: { type: 'integer' },
    auditId: { type: 'string' },
    requestId: { type: 'string' },
  },
} as const;

@ApiTags('Production Actions')
@ApiBearerAuth()
@Controller('orders/:orderId')
export class ProductionActionsController {
  constructor(
    @Inject(ProductionActionService)
    private readonly productionActions: ProductionActionService,
    @Inject(ProductionActionsRuntimeConfigService)
    private readonly runtimeConfig: ProductionActionsRuntimeConfigService,
  ) {}

  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiBody({ schema: swaggerSchema(moveCalendarDateRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Moved order calendar date', schema: swaggerSchema(productionActionResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid order ID' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Stale order version or idempotency key conflict' })
  @ApiResponse({ status: 422, description: 'Invalid production action payload' })
  @ApiResponse({ status: 503, description: 'Production actions API is disabled' })
  @ApiOperation({ operationId: 'moveOrderCalendarDate', summary: 'Move an order calendar date' })
  @Patch('calendar-date')
  async moveCalendarDate(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Body() body: unknown,
  ): Promise<ProductionActionResponseDto> {
    this.assertProductionActionsEnabled();

    return this.productionActions.moveCalendarDate({
      currentUser: this.requireCurrentUser(request),
      orderId: parseOrderId(orderIdParam),
      dto: parseCalendarDateRequest(body),
      requestId: request.requestId,
    });
  }

  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiBody({ schema: swaggerSchema(changeOrderStatusRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Changed order status', schema: swaggerSchema(productionActionResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid order ID' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Stale order version or idempotency key conflict' })
  @ApiResponse({ status: 422, description: 'Invalid production status or production action payload' })
  @ApiResponse({ status: 503, description: 'Production actions API is disabled' })
  @ApiOperation({ operationId: 'changeOrderStatus', summary: 'Change an order status' })
  @Patch('status')
  async changeOrderStatus(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Body() body: unknown,
  ): Promise<ProductionActionResponseDto> {
    return this.executeChangeOrderStatus(request, orderIdParam, body);
  }

  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiBody({ schema: swaggerSchema(changeOrderStatusRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Changed order status', schema: swaggerSchema(productionActionResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid order ID' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Stale order version or idempotency key conflict' })
  @ApiResponse({ status: 422, description: 'Invalid production status or production action payload' })
  @ApiResponse({ status: 503, description: 'Production actions API is disabled' })
  @ApiOperation({ operationId: 'changeOrderStatusLegacy', summary: 'Change an order status using the legacy route' })
  @Patch('order-status')
  async changeOrderStatusLegacy(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Body() body: unknown,
  ): Promise<ProductionActionResponseDto> {
    return this.executeChangeOrderStatus(request, orderIdParam, body);
  }

  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiBody({ schema: swaggerSchema(changePaymentStatusRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Changed payment status', schema: swaggerSchema(productionActionResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid order ID' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Stale order version or idempotency key conflict' })
  @ApiResponse({ status: 422, description: 'Invalid payment status or production action payload' })
  @ApiResponse({ status: 503, description: 'Production actions API is disabled' })
  @ApiOperation({ operationId: 'changePaymentStatus', summary: 'Change an order payment status' })
  @Patch('payment-status')
  async changePaymentStatus(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Body() body: unknown,
  ): Promise<ProductionActionResponseDto> {
    this.assertProductionActionsEnabled();

    return this.productionActions.changePaymentStatus({
      currentUser: this.requireCurrentUser(request),
      orderId: parseOrderId(orderIdParam),
      dto: parsePaymentStatusRequest(body),
      requestId: request.requestId,
    });
  }

  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiBody({ schema: swaggerSchema(changeProductionStatusRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Changed production status', schema: swaggerSchema(productionActionResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid order ID' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Stale order version or idempotency key conflict' })
  @ApiResponse({ status: 422, description: 'Invalid production status or production action payload' })
  @ApiResponse({ status: 503, description: 'Production actions API is disabled' })
  @ApiOperation({ operationId: 'changeProductionStatus', summary: 'Change an order current production status' })
  @Patch('production-status')
  async changeProductionStatus(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Body() body: unknown,
  ): Promise<ProductionActionResponseDto> {
    this.assertProductionActionsEnabled();

    return this.productionActions.changeProductionStatus({
      currentUser: this.requireCurrentUser(request),
      orderId: parseOrderId(orderIdParam),
      dto: parseProductionStatusRequest(body),
      requestId: request.requestId,
    });
  }

  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiBody({ schema: swaggerSchema(batchDetailProductionStatusRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Changed production status for the selected order details', schema: swaggerSchema(batchDetailProductionStatusResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid order ID' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order or detail not found' })
  @ApiResponse({ status: 409, description: 'Stale order version or idempotency key conflict' })
  @ApiResponse({ status: 422, description: 'Invalid batch detail production-status payload' })
  @ApiResponse({ status: 503, description: 'Production actions API is disabled' })
  @ApiOperation({ operationId: 'changeBatchDetailProductionStatus', summary: 'Set production status for a selected set of order details' })
  @Patch('details/production-status')
  async changeBatchDetailProductionStatus(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Body() body: unknown,
  ): Promise<BatchDetailProductionStatusResponseDto> {
    this.assertProductionActionsEnabled();

    return this.productionActions.changeBatchDetailProductionStatus({
      currentUser: this.requireCurrentUser(request),
      orderId: parseOrderId(orderIdParam),
      dto: parseBatchDetailProductionStatusRequest(body),
      requestId: request.requestId,
    });
  }

  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiParam({ name: 'productionStatusId', type: Number, description: 'Production status ID' })
  @ApiBody({ schema: swaggerSchema(productionStageEventRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Activated production stage', schema: swaggerSchema(productionActionResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid order or production status ID' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Stale order version or idempotency key conflict' })
  @ApiResponse({ status: 422, description: 'Invalid or missing production status or production action payload' })
  @ApiResponse({ status: 503, description: 'Production actions API is disabled' })
  @ApiOperation({ operationId: 'activateProductionStage', summary: 'Activate a production stage' })
  @Put('production-stage-events/:productionStatusId')
  async activateProductionStage(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Param('productionStatusId') productionStatusIdParam: string,
    @Body() body: unknown,
  ): Promise<ProductionActionResponseDto> {
    this.assertProductionActionsEnabled();

    return this.productionActions.activateProductionStage({
      currentUser: this.requireCurrentUser(request),
      orderId: parseOrderId(orderIdParam),
      productionStatusId: parseProductionStatusId(productionStatusIdParam),
      dto: parseStageEventRequest(body),
      requestId: request.requestId,
    });
  }

  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiParam({ name: 'productionStatusId', type: Number, description: 'Production status ID' })
  @ApiBody({ schema: swaggerSchema(productionStageEventRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Deactivated production stage', schema: swaggerSchema(productionActionResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid order or production status ID' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Stale order version or idempotency key conflict' })
  @ApiResponse({ status: 422, description: 'Invalid or missing production status or production action payload' })
  @ApiResponse({ status: 503, description: 'Production actions API is disabled' })
  @ApiOperation({ operationId: 'deactivateProductionStage', summary: 'Deactivate a production stage' })
  @Delete('production-stage-events/:productionStatusId')
  @HttpCode(200)
  async deactivateProductionStage(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Param('productionStatusId') productionStatusIdParam: string,
    @Body() body: unknown,
  ): Promise<ProductionActionResponseDto> {
    this.assertProductionActionsEnabled();

    return this.productionActions.deactivateProductionStage({
      currentUser: this.requireCurrentUser(request),
      orderId: parseOrderId(orderIdParam),
      productionStatusId: parseProductionStatusId(productionStatusIdParam),
      dto: parseStageEventRequest(body),
      requestId: request.requestId,
    });
  }

  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiBody({ schema: swaggerSchema(productionStatusModeRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Restored auto production status mode', schema: swaggerSchema(productionActionResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid order ID' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Stale order version or idempotency key conflict' })
  @ApiResponse({ status: 422, description: 'Invalid production action payload' })
  @ApiResponse({ status: 503, description: 'Production actions API is disabled' })
  @ApiOperation({ operationId: 'restoreAutoProductionStatus', summary: 'Restore auto production status mode (derive from details)' })
  @Patch('production-status-mode/auto')
  async restoreAutoProductionStatus(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Body() body: unknown,
  ): Promise<ProductionActionResponseDto> {
    this.assertProductionActionsEnabled();

    return this.productionActions.restoreAutoProductionStatus({
      currentUser: this.requireCurrentUser(request),
      orderId: parseOrderId(orderIdParam),
      dto: parseProductionStatusModeRequest(body),
      requestId: request.requestId,
    });
  }

  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiBody({ schema: swaggerSchema(productionStatusModeRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Kept production status derived from details', schema: swaggerSchema(productionActionResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid order ID' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Stale order version or idempotency key conflict' })
  @ApiResponse({ status: 422, description: 'Invalid production action payload' })
  @ApiResponse({ status: 503, description: 'Production actions API is disabled' })
  @ApiOperation({ operationId: 'enterManualProductionStatus', summary: 'Deprecated compatibility endpoint for production status mode' })
  @Patch('production-status-mode/manual')
  async enterManualProductionStatus(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Body() body: unknown,
  ): Promise<ProductionActionResponseDto> {
    this.assertProductionActionsEnabled();

    return this.productionActions.enterManualProductionStatus({
      currentUser: this.requireCurrentUser(request),
      orderId: parseOrderId(orderIdParam),
      dto: parseProductionStatusModeRequest(body),
      requestId: request.requestId,
    });
  }

  private assertProductionActionsEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().productionActionsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Production actions API is disabled', {
        feature: 'productionActions',
      });
    }
  }

  private requireCurrentUser(request: RequestWithCurrentUser) {
    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return request.user;
  }

  private executeChangeOrderStatus(
    request: RequestWithCurrentUser,
    orderIdParam: string,
    body: unknown,
  ): Promise<ProductionActionResponseDto> {
    this.assertProductionActionsEnabled();

    return this.productionActions.changeOrderStatus({
      currentUser: this.requireCurrentUser(request),
      orderId: parseOrderId(orderIdParam),
      dto: parseOrderStatusRequest(body),
      requestId: request.requestId,
    });
  }
}

export function parseOrderId(value: string): number {
  const orderId = Number(value);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid order id', {
      field: 'orderId',
    });
  }

  return orderId;
}

export function parseOrderDetailId(value: string): number {
  const detailId = Number(value);

  if (!Number.isInteger(detailId) || detailId <= 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid order detail id', {
      field: 'detailId',
    });
  }

  return detailId;
}

export function parseProductionStatusId(value: string): number {
  const productionStatusId = Number(value);

  if (!Number.isInteger(productionStatusId) || productionStatusId <= 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid production status id', {
      field: 'productionStatusId',
    });
  }

  return productionStatusId;
}

export function parseCalendarDateRequest(body: unknown): MoveCalendarDateRequestDto {
  const parsed = calendarDateRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw productionActionValidationError(parsed.error);
  }

  return parsed.data;
}

export function parseOrderStatusRequest(body: unknown): ChangeOrderStatusRequestDto {
  const parsed = orderStatusRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw productionActionValidationError(parsed.error);
  }

  return parsed.data;
}

export function parsePaymentStatusRequest(body: unknown): ChangePaymentStatusRequestDto {
  const parsed = paymentStatusRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw productionActionValidationError(parsed.error);
  }

  return parsed.data;
}

export function parseProductionStatusRequest(body: unknown): ChangeProductionStatusRequestDto {
  const parsed = productionStatusRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw productionActionValidationError(parsed.error);
  }

  return parsed.data;
}

export function parseBatchDetailProductionStatusRequest(
  body: unknown,
): BatchDetailProductionStatusRequestDto {
  const parsed = batchDetailProductionStatusRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw productionActionValidationError(parsed.error);
  }

  return parsed.data;
}

export function parseStageEventRequest(body: unknown): ProductionStageEventRequestDto {
  const parsed = stageEventRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw productionActionValidationError(parsed.error);
  }

  return parsed.data;
}

export function parseDetailStageEventRequest(body: unknown): DetailProductionStageEventRequestDto {
  const parsed = detailStageEventRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw productionActionValidationError(parsed.error);
  }

  return parsed.data;
}

export function parseProductionStatusModeRequest(
  body: unknown,
): RestoreAutoProductionStatusRequestDto | EnterManualProductionStatusRequestDto {
  const parsed = productionStatusModeRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw productionActionValidationError(parsed.error);
  }

  return parsed.data;
}

function productionActionValidationError(error: z.ZodError): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', 'Production action payload validation failed', {
    errors: error.issues.map((issue) => ({
      field: issue.path.join('.') || 'body',
      message: issue.message,
    })),
  });
}
