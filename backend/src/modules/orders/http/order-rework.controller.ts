import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../../permissions/current-user';
import {
  clarifyReworkReasonRequestSchema,
  falsePositiveReworkRequestSchema,
  parseReworkRequest,
  startOrExtendReworkRequestSchema,
} from '../domain/order-rework';
import {
  OrderReworkService,
  type OrderReworkAvailability,
  type OrderReworkOrderStateDto,
  type OrderReworkReasonDto,
  type OrderReworkResponseDto,
  type OrderReworkRoundDto,
} from '../application/order-rework.service';
import { parseIdempotencyKeyHeader, parseIfMatchVersion, parseOrderId } from './orders.controller';
import {
  OrderReworkReasonCatalogService,
  createReworkReasonSchema,
  parseReworkReasonRequest,
  updateReworkReasonSchema,
  type OrderReworkReasonCatalogItemDto,
} from '../application/order-rework-reason-catalog.service';
import { OrdersRuntimeConfigService } from './orders-runtime-config.service';

const commentProperty = { type: 'string', maxLength: 4000, nullable: true };

const startOrExtendSchema = {
  type: 'object',
  required: ['details'],
  additionalProperties: false,
  properties: {
    reasonId: { type: 'integer', minimum: 1, description: 'Required to start a round; must be absent when details join the open round' },
    comment: commentProperty,
    details: {
      type: 'array',
      minItems: 1,
      maxItems: 500,
      items: {
        type: 'object',
        required: ['detailId', 'productionStatusId'],
        additionalProperties: false,
        properties: {
          detailId: { type: 'integer', minimum: 1 },
          productionStatusId: { type: 'integer', minimum: 1 },
        },
      },
    },
  },
};

const commandResponseSchema = {
  type: 'object',
  required: ['orderId', 'roundNo', 'mode', 'action', 'version', 'detailIds', 'requestId', 'order'],
  properties: {
    orderId: { type: 'integer' },
    roundNo: { type: 'integer' },
    mode: { type: 'string', enum: ['after_ready', 'in_production'] },
    action: { type: 'string', enum: ['started', 'extended', 'noop', 'reason_clarified', 'false_positive'] },
    version: { type: 'integer' },
    detailIds: { type: 'array', items: { type: 'integer' } },
    requestId: { type: 'string' },
    order: { type: 'object', additionalProperties: true },
  },
};

const idempotencyHeader = {
  name: 'Idempotency-Key',
  required: true,
  description: 'Idempotency key for safe retry of the rework command.',
  schema: { type: 'string', minLength: 8, maxLength: 200 },
};
const ifMatchHeader = {
  name: 'If-Match',
  required: true,
  description: 'Current order version.',
  schema: { type: 'string' },
};

@ApiTags('Orders')
@ApiBearerAuth()
@ApiResponse({ status: 401, description: 'Authentication required' })
@ApiResponse({ status: 503, description: 'Rework disabled' })
@Controller('order-rework')
export class OrderReworkCatalogController {
  constructor(
    @Inject(OrderReworkService) private readonly rework: OrderReworkService,
    @Inject(OrdersRuntimeConfigService) private readonly runtime: OrdersRuntimeConfigService,
    @Inject(OrderReworkReasonCatalogService) private readonly reasonCatalogService: OrderReworkReasonCatalogService,
  ) {}

  @Get('reasons/catalog')
  @ApiOperation({ operationId: 'listOrderReworkReasonCatalog', summary: 'All rework reasons incl. inactive/system (references.manage)' })
  @ApiResponse({ status: 200, schema: { type: 'object', required: ['data'], properties: { data: { type: 'array', items: { type: 'object', additionalProperties: true } } } } })
  async reasonCatalog(@Req() request: RequestWithCurrentUser): Promise<{ data: OrderReworkReasonCatalogItemDto[] }> {
    return this.reasonCatalogService.list(requireUser(request, this.runtime, false));
  }

  @Post('reasons')
  @HttpCode(201)
  @ApiBody({
    schema: {
      type: 'object', required: ['name'], additionalProperties: false,
      properties: {
        name: { type: 'string', maxLength: 100 },
        code: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,63}$' },
        requiresComment: { type: 'boolean' },
        sortOrder: { type: 'integer', minimum: 0 },
      },
    },
  })
  @ApiResponse({ status: 201, schema: { type: 'object', additionalProperties: true } })
  @ApiResponse({ status: 409, description: 'Duplicate name or code' })
  @ApiOperation({ operationId: 'createOrderReworkReason', summary: 'Create a rework reason (references.manage)' })
  async createReason(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<OrderReworkReasonCatalogItemDto> {
    const currentUser = requireUser(request, this.runtime, true);
    return this.reasonCatalogService.create(currentUser, parseReworkReasonRequest(createReworkReasonSchema, body), request.requestId);
  }

  @Patch('reasons/:reasonId')
  @HttpCode(200)
  @ApiParam({ name: 'reasonId', type: Number })
  @ApiBody({
    schema: {
      type: 'object', required: ['expectedUpdatedAt'], additionalProperties: false,
      properties: {
        expectedUpdatedAt: { type: 'string', description: 'updatedAt from the catalogue (optimistic concurrency)' },
        name: { type: 'string', maxLength: 100 },
        requiresComment: { type: 'boolean' },
        sortOrder: { type: 'integer', minimum: 0 },
        isActive: { type: 'boolean' },
      },
    },
  })
  @ApiResponse({ status: 200, schema: { type: 'object', additionalProperties: true } })
  @ApiResponse({ status: 409, description: 'Stale, duplicate name or system reason' })
  @ApiOperation({ operationId: 'updateOrderReworkReason', summary: 'Update/deactivate a rework reason (references.manage)' })
  async updateReason(
    @Req() request: RequestWithCurrentUser,
    @Param('reasonId') reasonIdParam: string,
    @Body() body: unknown,
  ): Promise<OrderReworkReasonCatalogItemDto> {
    const currentUser = requireUser(request, this.runtime, true);
    const reasonId = Number(reasonIdParam);
    if (!Number.isSafeInteger(reasonId) || reasonId < 1) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный ID причины');
    return this.reasonCatalogService.update(currentUser, reasonId, parseReworkReasonRequest(updateReworkReasonSchema, body), request.requestId);
  }

  @Get('availability')
  @ApiOperation({ operationId: 'getOrderReworkAvailability', summary: 'Whether rework commands are available now' })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      required: ['availability'],
      properties: { availability: { type: 'string', enum: ['available', 'disabled_flag', 'mdf_engine_unsupported', 'mdf_cutover_in_progress'] } },
    },
  })
  async availability(@Req() request: RequestWithCurrentUser): Promise<{ availability: OrderReworkAvailability }> {
    requireUser(request, this.runtime, false);
    return this.rework.availability();
  }

  @Get('reasons')
  @ApiOperation({ operationId: 'listOrderReworkReasons', summary: 'Active manual rework reasons' })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      required: ['data'],
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            required: ['reasonId', 'code', 'name', 'requiresComment', 'sortOrder'],
            properties: {
              reasonId: { type: 'integer' },
              code: { type: 'string' },
              name: { type: 'string' },
              requiresComment: { type: 'boolean' },
              sortOrder: { type: 'integer' },
            },
          },
        },
      },
    },
  })
  async reasons(@Req() request: RequestWithCurrentUser): Promise<{ data: OrderReworkReasonDto[] }> {
    return this.rework.listReasons(requireUser(request, this.runtime, false));
  }
}

@ApiTags('Orders')
@ApiBearerAuth()
@ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
@ApiResponse({ status: 401, description: 'Authentication required' })
@ApiResponse({ status: 403, description: 'Insufficient permissions (orders.rework + order scope)' })
@ApiResponse({ status: 404, description: 'Order or round not found' })
@ApiResponse({ status: 409, description: 'Stale version, status not allowed, MDF engine/cutover, closed round, or idempotency conflict' })
@ApiResponse({ status: 422, description: 'Invalid rework payload' })
@ApiResponse({ status: 503, description: 'Rework or orders writes disabled' })
@Controller('orders/:orderId/rework')
export class OrderReworkController {
  constructor(
    @Inject(OrderReworkService) private readonly rework: OrderReworkService,
    @Inject(OrdersRuntimeConfigService) private readonly runtime: OrdersRuntimeConfigService,
  ) {}

  @Get('rounds')
  @ApiOperation({ operationId: 'listOrderReworkRounds', summary: 'Production rounds (rework history) of an order' })
  @ApiResponse({ status: 200, schema: { type: 'object', required: ['data'], properties: { data: { type: 'array', items: { type: 'object', additionalProperties: true } } } } })
  async rounds(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
  ): Promise<{ order: OrderReworkOrderStateDto; data: OrderReworkRoundDto[] }> {
    return this.rework.listRounds(requireUser(request, this.runtime, false), parseOrderId(orderIdParam));
  }

  @Post()
  @HttpCode(200)
  @ApiHeader(ifMatchHeader)
  @ApiHeader(idempotencyHeader)
  @ApiBody({ schema: startOrExtendSchema })
  @ApiResponse({ status: 200, description: 'Round started or details added', schema: commandResponseSchema })
  @ApiOperation({ operationId: 'startOrExtendOrderRework', summary: 'Start a production round or add details to the open round' })
  async startOrExtend(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Headers('if-match') ifMatch: string | string[] | undefined,
    @Headers('idempotency-key') idempotencyKey: string | string[] | undefined,
    @Body() body: unknown,
  ): Promise<OrderReworkResponseDto> {
    const currentUser = requireUser(request, this.runtime, true);
    return this.rework.startOrExtend({
      currentUser,
      orderId: parseOrderId(orderIdParam),
      version: parseIfMatchVersion(ifMatch),
      idempotencyKey: parseIdempotencyKeyHeader(idempotencyKey),
      dto: parseReworkRequest(startOrExtendReworkRequestSchema, body),
      requestId: request.requestId,
    });
  }

  @Patch('rounds/:roundNo/reason')
  @HttpCode(200)
  @ApiParam({ name: 'roundNo', type: Number })
  @ApiHeader(ifMatchHeader)
  @ApiHeader(idempotencyHeader)
  @ApiBody({
    schema: {
      type: 'object',
      required: ['reasonId'],
      additionalProperties: false,
      properties: { reasonId: { type: 'integer', minimum: 1 }, comment: commentProperty },
    },
  })
  @ApiResponse({ status: 200, description: 'Reason clarified', schema: commandResponseSchema })
  @ApiOperation({ operationId: 'clarifyOrderReworkReason', summary: 'Clarify the reason of a production round' })
  async clarifyReason(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Param('roundNo') roundNoParam: string,
    @Headers('if-match') ifMatch: string | string[] | undefined,
    @Headers('idempotency-key') idempotencyKey: string | string[] | undefined,
    @Body() body: unknown,
  ): Promise<OrderReworkResponseDto> {
    const currentUser = requireUser(request, this.runtime, true);
    return this.rework.clarifyReason({
      currentUser,
      orderId: parseOrderId(orderIdParam),
      roundNo: parseRoundNo(roundNoParam),
      version: parseIfMatchVersion(ifMatch),
      idempotencyKey: parseIdempotencyKeyHeader(idempotencyKey),
      dto: parseReworkRequest(clarifyReworkReasonRequestSchema, body),
      requestId: request.requestId,
    });
  }

  @Post('rounds/:roundNo/false-positive')
  @HttpCode(200)
  @ApiParam({ name: 'roundNo', type: Number })
  @ApiHeader(ifMatchHeader)
  @ApiHeader(idempotencyHeader)
  @ApiBody({ schema: { type: 'object', additionalProperties: false, properties: { comment: commentProperty } } })
  @ApiResponse({ status: 200, description: 'Round closed as «не переделка», before-state restored', schema: commandResponseSchema })
  @ApiOperation({ operationId: 'closeOrderReworkAsFalsePositive', summary: 'Close the open round as not a rework and restore the details' })
  async falsePositive(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Param('roundNo') roundNoParam: string,
    @Headers('if-match') ifMatch: string | string[] | undefined,
    @Headers('idempotency-key') idempotencyKey: string | string[] | undefined,
    @Body() body: unknown,
  ): Promise<OrderReworkResponseDto> {
    const currentUser = requireUser(request, this.runtime, true);
    return this.rework.falsePositive({
      currentUser,
      orderId: parseOrderId(orderIdParam),
      roundNo: parseRoundNo(roundNoParam),
      version: parseIfMatchVersion(ifMatch),
      idempotencyKey: parseIdempotencyKeyHeader(idempotencyKey),
      dto: parseReworkRequest(falsePositiveReworkRequestSchema, body ?? {}),
      requestId: request.requestId,
    });
  }
}

function requireUser(request: RequestWithCurrentUser, runtime: OrdersRuntimeConfigService, write: boolean): CurrentUser {
  const flags = runtime.getFeatureFlags();
  if (!flags.ordersEnabled || (write && flags.ordersReadOnly)) {
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Изменения заказов недоступны');
  }
  if (!request.user) {
    throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  }
  return request.user;
}

function parseRoundNo(value: string): number {
  const roundNo = Number(value);
  if (!/^[1-9]\d{0,4}$/.test(value) || !Number.isSafeInteger(roundNo) || roundNo < 2) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный номер круга');
  }
  return roundNo;
}
