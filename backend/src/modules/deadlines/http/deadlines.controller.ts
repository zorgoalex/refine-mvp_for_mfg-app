import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { DeadlineCommandService } from '../application/deadline-command.service';
import { DeadlineQueryService } from '../application/deadline-query.service';
import {
  DEADLINE_LIST_SORT_FIELDS,
  type DeadlineListQuery,
  type DeadlineListSortBy,
  type SortOrder,
} from '../application/deadline.types';
import {
  deadlineEntityTypeSchema,
  deadlinePauseModeSchema,
  deadlineSourceSchema,
  deadlineStatusSchema,
  isUuid,
  isoDateTimeSchema,
  metadataSchema,
} from '../domain/deadline-validation';
import type {
  CancelDeadlineRequestDto,
  CreateDeadlineRequestDto,
  OverrideDeadlineRequestDto,
  PauseDeadlineRequestDto,
  ResumeDeadlineRequestDto,
} from '../dto/deadline-instance.dto';
import { DeadlinesRuntimeConfigService } from './deadlines-runtime-config.service';

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

const optionalPositiveIntSchema = z.number().int().positive().nullable().optional();

const createDeadlineRequestSchema = z.object({
  entityType: deadlineEntityTypeSchema,
  entityId: z.string().trim().min(1).max(200),
  orderId: optionalPositiveIntSchema,
  orderWorkshopId: optionalPositiveIntSchema,
  clientId: optionalPositiveIntSchema,
  responsibleUserId: optionalPositiveIntSchema,
  deadlineAt: isoDateTimeSchema,
  source: deadlineSourceSchema.default('manual'),
  metadata: metadataSchema,
});

const overrideDeadlineRequestSchema = z.object({
  deadlineAt: isoDateTimeSchema,
  reason: z.string().trim().min(1).max(1000),
  metadata: metadataSchema,
});

const pauseDeadlineRequestSchema = z.object({
  pauseMode: deadlinePauseModeSchema,
  pauseReason: z.string().trim().min(1).max(1000),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const resumeDeadlineRequestSchema = z.object({
  notes: z.string().trim().max(2000).nullable().optional(),
});

const cancelDeadlineRequestSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});

const deadlineEntityTypeSwaggerSchema = {
  type: 'string',
  enum: ['order', 'order_stage', 'client_action', 'project', 'task'],
} as const;
const deadlineSourceSwaggerSchema = {
  type: 'string',
  enum: ['policy', 'manual', 'imported', 'recalculated', 'system'],
} as const;
const deadlineStatusSwaggerSchema = {
  type: 'string',
  enum: ['active', 'paused', 'expired', 'completed_on_time', 'completed_late', 'cancelled', 'superseded'],
} as const;
const deadlineMetadataSwaggerSchema = {
  type: 'object',
  additionalProperties: true,
} as const;

const createDeadlineRequestSwaggerSchema = {
  type: 'object',
  required: ['entityType', 'entityId', 'deadlineAt'],
  properties: {
    entityType: deadlineEntityTypeSwaggerSchema,
    entityId: { type: 'string', minLength: 1, maxLength: 200 },
    orderId: { type: 'integer', nullable: true },
    orderWorkshopId: { type: 'integer', nullable: true },
    clientId: { type: 'integer', nullable: true },
    responsibleUserId: { type: 'integer', nullable: true },
    deadlineAt: { type: 'string', format: 'date-time' },
    source: { ...deadlineSourceSwaggerSchema, default: 'manual' },
    metadata: deadlineMetadataSwaggerSchema,
  },
} as const;

const overrideDeadlineRequestSwaggerSchema = {
  type: 'object',
  required: ['deadlineAt', 'reason'],
  properties: {
    deadlineAt: { type: 'string', format: 'date-time' },
    reason: { type: 'string', minLength: 1, maxLength: 1000 },
    metadata: deadlineMetadataSwaggerSchema,
  },
} as const;

const pauseDeadlineRequestSwaggerSchema = {
  type: 'object',
  required: ['pauseMode', 'pauseReason'],
  properties: {
    pauseMode: { type: 'string', enum: ['pause_without_shift', 'pause_and_shift_deadline'] },
    pauseReason: { type: 'string', minLength: 1, maxLength: 1000 },
    notes: { type: 'string', maxLength: 2000, nullable: true },
  },
} as const;

const resumeDeadlineRequestSwaggerSchema = {
  type: 'object',
  properties: {
    notes: { type: 'string', maxLength: 2000, nullable: true },
  },
} as const;

const cancelDeadlineRequestSwaggerSchema = {
  type: 'object',
  required: ['reason'],
  properties: {
    reason: { type: 'string', minLength: 1, maxLength: 1000 },
  },
} as const;

const deadlineSwaggerSchema = {
  type: 'object',
  required: ['deadlineId', 'entityType', 'entityId', 'deadlineAt', 'status', 'source', 'isManuallyOverridden', 'createdAt', 'updatedAt'],
  properties: {
    deadlineId: { type: 'string', format: 'uuid' },
    policyId: { type: 'string', format: 'uuid', nullable: true },
    policyVersionId: { type: 'string', format: 'uuid', nullable: true },
    entityType: deadlineEntityTypeSwaggerSchema,
    entityId: { type: 'string' },
    parentEntityType: { type: 'string', nullable: true },
    parentEntityId: { type: 'string', nullable: true },
    orderId: { type: 'integer', nullable: true },
    orderWorkshopId: { type: 'integer', nullable: true },
    clientId: { type: 'integer', nullable: true },
    responsibleUserId: { type: 'integer', nullable: true },
    deadlineAt: { type: 'string', format: 'date-time' },
    status: deadlineStatusSwaggerSchema,
    source: deadlineSourceSwaggerSchema,
    isManuallyOverridden: { type: 'boolean' },
    policySnapshot: { type: 'object', nullable: true, additionalProperties: true },
    metadata: { type: 'object', nullable: true, additionalProperties: true },
    startedAt: { type: 'string', format: 'date-time', nullable: true },
    completedAt: { type: 'string', format: 'date-time', nullable: true },
    expiredAt: { type: 'string', format: 'date-time', nullable: true },
    cancelledAt: { type: 'string', format: 'date-time', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const deadlineResponseSwaggerSchema = {
  type: 'object',
  required: ['deadline'],
  properties: {
    deadline: deadlineSwaggerSchema,
  },
} as const;

const deadlinePaginationSwaggerSchema = {
  type: 'object',
  required: ['page', 'pageSize', 'total', 'totalPages'],
  properties: {
    page: { type: 'integer' },
    pageSize: { type: 'integer' },
    total: { type: 'integer' },
    totalPages: { type: 'integer' },
  },
} as const;

const deadlineListResponseSwaggerSchema = {
  type: 'object',
  required: ['data', 'pagination'],
  properties: {
    data: { type: 'array', items: deadlineSwaggerSchema },
    pagination: deadlinePaginationSwaggerSchema,
  },
} as const;

const orderDeadlineListResponseSwaggerSchema = {
  type: 'object',
  required: ['data'],
  properties: {
    data: { type: 'array', items: deadlineSwaggerSchema },
  },
} as const;

const deadlineEventSwaggerSchema = {
  type: 'object',
  required: ['deadlineEventId', 'deadlineId', 'eventType', 'severity', 'entityType', 'entityId', 'eventAt', 'createdAt'],
  properties: {
    deadlineEventId: { type: 'string', format: 'uuid' },
    deadlineId: { type: 'string', format: 'uuid' },
    eventType: { type: 'string' },
    severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
    entityType: deadlineEntityTypeSwaggerSchema,
    entityId: { type: 'string' },
    orderId: { type: 'integer', nullable: true },
    orderWorkshopId: { type: 'integer', nullable: true },
    clientId: { type: 'integer', nullable: true },
    deadlineAt: { type: 'string', format: 'date-time', nullable: true },
    eventAt: { type: 'string', format: 'date-time' },
    delayMinutes: { type: 'integer', nullable: true },
    payload: { type: 'object', nullable: true, additionalProperties: true },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

const deadlineEventListResponseSwaggerSchema = {
  type: 'object',
  required: ['data'],
  properties: {
    data: { type: 'array', items: deadlineEventSwaggerSchema },
  },
} as const;

const deadlineSummaryItemSwaggerSchema = {
  type: 'object',
  required: ['deadlineId', 'deadlineAt', 'status', 'remainingMinutes', 'delayMinutes', 'severity'],
  properties: {
    deadlineId: { type: 'string', format: 'uuid' },
    deadlineAt: { type: 'string', format: 'date-time' },
    status: deadlineStatusSwaggerSchema,
    remainingMinutes: { type: 'integer', nullable: true },
    delayMinutes: { type: 'integer', nullable: true },
    severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
  },
} as const;

const deadlineSummaryResponseSwaggerSchema = {
  type: 'object',
  required: ['orderId', 'finalDeadline', 'currentStageDeadline', 'counts'],
  properties: {
    orderId: { type: 'integer' },
    finalDeadline: { ...deadlineSummaryItemSwaggerSchema, nullable: true },
    currentStageDeadline: {
      allOf: [
        deadlineSummaryItemSwaggerSchema,
        {
          type: 'object',
          required: ['orderWorkshopId'],
          properties: {
            orderWorkshopId: { type: 'integer', nullable: true },
            stageName: { type: 'string', nullable: true },
          },
        },
      ],
      nullable: true,
    },
    counts: {
      type: 'object',
      required: ['active', 'expired', 'completedLate', 'completedOnTime'],
      properties: {
        active: { type: 'integer' },
        expired: { type: 'integer' },
        completedLate: { type: 'integer' },
        completedOnTime: { type: 'integer' },
      },
    },
  },
} as const;

@ApiTags('Deadlines')
@ApiBearerAuth()
@Controller()
export class DeadlinesController {
  constructor(
    @Inject(DeadlineCommandService)
    private readonly commands: DeadlineCommandService,
    @Inject(DeadlineQueryService)
    private readonly queries: DeadlineQueryService,
    @Inject(DeadlinesRuntimeConfigService)
    private readonly runtimeConfig: DeadlinesRuntimeConfigService,
  ) {}

  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiResponse({ status: 200, description: 'Order deadlines', schema: swaggerSchema(orderDeadlineListResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid order ID' })
  @ApiResponse({ status: 503, description: 'Deadlines API is disabled' })
  @ApiOperation({ operationId: 'listOrderDeadlines', summary: 'List order deadlines' })
  @Get('orders/:orderId/deadlines')
  async listOrderDeadlines(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
  ) {
    this.assertReadEnabled();

    return this.queries.listOrderDeadlines({
      currentUser: this.requireCurrentUser(request),
      orderId: parsePositivePathInteger(orderIdParam, 'orderId'),
    });
  }

  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiResponse({ status: 200, description: 'Order deadline events', schema: swaggerSchema(deadlineEventListResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid order ID' })
  @ApiResponse({ status: 503, description: 'Deadlines API is disabled' })
  @ApiOperation({ operationId: 'listOrderDeadlineEvents', summary: 'List order deadline events' })
  @Get('orders/:orderId/deadline-events')
  async listOrderDeadlineEvents(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
  ) {
    this.assertReadEnabled();

    return this.queries.listOrderDeadlineEvents({
      currentUser: this.requireCurrentUser(request),
      orderId: parsePositivePathInteger(orderIdParam, 'orderId'),
    });
  }

  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiResponse({ status: 200, description: 'Order deadline summary', schema: swaggerSchema(deadlineSummaryResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid order ID' })
  @ApiResponse({ status: 503, description: 'Deadlines API is disabled' })
  @ApiOperation({ operationId: 'getOrderDeadlineSummary', summary: 'Get order deadline summary' })
  @Get('orders/:orderId/deadline-summary')
  async getOrderDeadlineSummary(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
  ) {
    this.assertReadEnabled();

    return this.queries.getOrderDeadlineSummary({
      currentUser: this.requireCurrentUser(request),
      orderId: parsePositivePathInteger(orderIdParam, 'orderId'),
    });
  }

  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, description: 'Items per page' })
  @ApiQuery({ name: 'sortBy', required: false, enum: DEADLINE_LIST_SORT_FIELDS, description: 'Sort field' })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'], description: 'Sort direction' })
  @ApiQuery({ name: 'entityType', required: false, schema: swaggerSchema(deadlineEntityTypeSwaggerSchema), description: 'Entity type filter' })
  @ApiQuery({ name: 'entityId', required: false, type: String, description: 'Entity ID filter' })
  @ApiQuery({ name: 'orderId', required: false, type: Number, description: 'Order ID filter' })
  @ApiQuery({ name: 'status', required: false, schema: swaggerSchema(deadlineStatusSwaggerSchema), description: 'Deadline status filter' })
  @ApiQuery({ name: 'responsibleUserId', required: false, type: Number, description: 'Responsible user ID filter' })
  @ApiQuery({ name: 'dateFrom', required: false, type: String, description: 'Start date filter' })
  @ApiQuery({ name: 'dateTo', required: false, type: String, description: 'End date filter' })
  @ApiQuery({ name: 'onlyOverdue', required: false, type: Boolean, description: 'Only overdue deadlines' })
  @ApiResponse({ status: 200, description: 'Deadline list', schema: swaggerSchema(deadlineListResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid deadline list query' })
  @ApiResponse({ status: 503, description: 'Deadlines API is disabled' })
  @ApiOperation({ operationId: 'listDeadlines', summary: 'List deadlines' })
  @Get('deadlines')
  async list(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ) {
    this.assertReadEnabled();

    return this.queries.list({
      currentUser: this.requireCurrentUser(request),
      query: parseDeadlineListQuery(query),
    });
  }

  @ApiParam({ name: 'deadlineId', type: String, description: 'Deadline ID' })
  @ApiResponse({ status: 200, description: 'Deadline', schema: swaggerSchema(deadlineResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid deadline ID' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Deadline not found' })
  @ApiResponse({ status: 503, description: 'Deadlines API is disabled' })
  @ApiOperation({ operationId: 'getDeadlineById', summary: 'Get a deadline by ID' })
  @Get('deadlines/:deadlineId')
  async getById(
    @Req() request: RequestWithCurrentUser,
    @Param('deadlineId') deadlineIdParam: string,
  ) {
    this.assertReadEnabled();

    return {
      deadline: await this.queries.getById({
        currentUser: this.requireCurrentUser(request),
        deadlineId: parseDeadlineId(deadlineIdParam),
      }),
    };
  }

  @ApiBody({ schema: swaggerSchema(createDeadlineRequestSwaggerSchema) })
  @ApiResponse({ status: 201, description: 'Created deadline', schema: swaggerSchema(deadlineResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid deadline payload' })
  @ApiResponse({ status: 503, description: 'Deadlines API is disabled or read-only' })
  @ApiOperation({ operationId: 'createDeadline', summary: 'Create a deadline' })
  @Post('deadlines')
  async create(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    this.assertWriteOperationEnabled('create');

    return {
      deadline: await this.commands.create({
        currentUser: this.requireCurrentUser(request),
        requestId: request.requestId,
        dto: parseCreateDeadlineRequest(body),
      }),
    };
  }

  @ApiParam({ name: 'deadlineId', type: String, description: 'Deadline ID' })
  @ApiBody({ schema: swaggerSchema(overrideDeadlineRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Overridden deadline', schema: swaggerSchema(deadlineResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid deadline ID' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Deadline not found' })
  @ApiResponse({ status: 422, description: 'Invalid deadline payload' })
  @ApiResponse({ status: 503, description: 'Deadlines API is disabled or read-only' })
  @ApiOperation({ operationId: 'overrideDeadline', summary: 'Override a deadline' })
  @Post('deadlines/:deadlineId/override')
  @HttpCode(200)
  async override(
    @Req() request: RequestWithCurrentUser,
    @Param('deadlineId') deadlineIdParam: string,
    @Body() body: unknown,
  ) {
    this.assertWriteOperationEnabled('override');

    return {
      deadline: await this.commands.override({
        currentUser: this.requireCurrentUser(request),
        deadlineId: parseDeadlineId(deadlineIdParam),
        requestId: request.requestId,
        dto: parseOverrideDeadlineRequest(body),
      }),
    };
  }

  @ApiParam({ name: 'deadlineId', type: String, description: 'Deadline ID' })
  @ApiBody({ schema: swaggerSchema(pauseDeadlineRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Paused deadline', schema: swaggerSchema(deadlineResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid deadline ID' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Deadline not found' })
  @ApiResponse({ status: 422, description: 'Invalid deadline payload' })
  @ApiResponse({ status: 503, description: 'Deadlines API is disabled or read-only' })
  @ApiOperation({ operationId: 'pauseDeadline', summary: 'Pause a deadline' })
  @Post('deadlines/:deadlineId/pause')
  @HttpCode(200)
  async pause(
    @Req() request: RequestWithCurrentUser,
    @Param('deadlineId') deadlineIdParam: string,
    @Body() body: unknown,
  ) {
    this.assertWriteOperationEnabled('pause');

    return {
      deadline: await this.commands.pause({
        currentUser: this.requireCurrentUser(request),
        deadlineId: parseDeadlineId(deadlineIdParam),
        requestId: request.requestId,
        dto: parsePauseDeadlineRequest(body),
      }),
    };
  }

  @ApiParam({ name: 'deadlineId', type: String, description: 'Deadline ID' })
  @ApiBody({ schema: swaggerSchema(resumeDeadlineRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Resumed deadline', schema: swaggerSchema(deadlineResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid deadline ID' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Deadline not found' })
  @ApiResponse({ status: 422, description: 'Invalid deadline payload' })
  @ApiResponse({ status: 503, description: 'Deadlines API is disabled or read-only' })
  @ApiOperation({ operationId: 'resumeDeadline', summary: 'Resume a deadline' })
  @Post('deadlines/:deadlineId/resume')
  @HttpCode(200)
  async resume(
    @Req() request: RequestWithCurrentUser,
    @Param('deadlineId') deadlineIdParam: string,
    @Body() body: unknown,
  ) {
    this.assertWriteOperationEnabled('resume');

    return {
      deadline: await this.commands.resume({
        currentUser: this.requireCurrentUser(request),
        deadlineId: parseDeadlineId(deadlineIdParam),
        requestId: request.requestId,
        dto: parseResumeDeadlineRequest(body),
      }),
    };
  }

  @ApiParam({ name: 'deadlineId', type: String, description: 'Deadline ID' })
  @ApiBody({ schema: swaggerSchema(cancelDeadlineRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Cancelled deadline', schema: swaggerSchema(deadlineResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid deadline ID' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Deadline not found' })
  @ApiResponse({ status: 422, description: 'Invalid deadline payload' })
  @ApiResponse({ status: 503, description: 'Deadlines API is disabled or read-only' })
  @ApiOperation({ operationId: 'cancelDeadline', summary: 'Cancel a deadline' })
  @Post('deadlines/:deadlineId/cancel')
  @HttpCode(200)
  async cancel(
    @Req() request: RequestWithCurrentUser,
    @Param('deadlineId') deadlineIdParam: string,
    @Body() body: unknown,
  ) {
    this.assertWriteOperationEnabled('cancel');

    return {
      deadline: await this.commands.cancel({
        currentUser: this.requireCurrentUser(request),
        deadlineId: parseDeadlineId(deadlineIdParam),
        requestId: request.requestId,
        dto: parseCancelDeadlineRequest(body),
      }),
    };
  }

  private assertReadEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().deadlinesEnabled) {
      throw new ApiError(503, 'DEADLINES_DISABLED', 'Deadlines API is disabled', {
        feature: 'deadlines',
      });
    }
  }

  private assertWriteEnabled(): void {
    const flags = this.runtimeConfig.getFeatureFlags();
    if (!flags.deadlinesEnabled) {
      throw new ApiError(503, 'DEADLINES_DISABLED', 'Deadlines API is disabled', {
        feature: 'deadlines',
      });
    }

    if (flags.deadlinesReadOnly) {
      throw new ApiError(503, 'DEADLINES_READ_ONLY', 'Deadlines write API is disabled', {
        feature: 'deadlines',
        mode: 'read_only',
      });
    }
  }

  private assertWriteOperationEnabled(
    operation: 'create' | 'override' | 'pause' | 'resume' | 'cancel',
  ): void {
    this.assertWriteEnabled();

    const enabledOperations = new Set<typeof operation>(['create', 'override', 'pause', 'resume', 'cancel']);
    if (!enabledOperations.has(operation)) {
      throw new ApiError(503, 'DEADLINE_WRITE_OPERATION_DISABLED', 'Deadline write operation is disabled', {
        feature: 'deadlines',
        operation,
      });
    }
  }

  private requireCurrentUser(request: RequestWithCurrentUser) {
    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return request.user;
  }
}

export function parseDeadlineListQuery(
  query: Record<string, string | string[] | undefined>,
): DeadlineListQuery {
  return {
    page: parsePositiveInteger(query.page, 'page', 1, 1, Number.MAX_SAFE_INTEGER),
    pageSize: parsePositiveInteger(query.pageSize, 'pageSize', 25, 1, 200),
    sortBy: parseSortBy(query.sortBy),
    sortOrder: parseSortOrder(query.sortOrder),
    entityType: parseEnum(query.entityType, deadlineEntityTypeSchema, 'entityType'),
    entityId: parseOptionalText(query.entityId, 'entityId'),
    orderId: parseOptionalPositiveInteger(query.orderId, 'orderId'),
    status: parseEnum(query.status, deadlineStatusSchema, 'status'),
    responsibleUserId: parseOptionalPositiveInteger(query.responsibleUserId, 'responsibleUserId'),
    dateFrom: parseOptionalDateOnly(query.dateFrom, 'dateFrom'),
    dateTo: parseOptionalDateOnly(query.dateTo, 'dateTo'),
    onlyOverdue: parseBoolean(query.onlyOverdue, false, 'onlyOverdue'),
  };
}

export function parseDeadlineId(value: string): string {
  if (!isUuid(value)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid deadline id', { field: 'deadlineId' });
  }

  return value;
}

export function parseCreateDeadlineRequest(body: unknown): CreateDeadlineRequestDto {
  return parseRequestBody(createDeadlineRequestSchema, body, 'Deadline request validation failed');
}

export function parseOverrideDeadlineRequest(body: unknown): OverrideDeadlineRequestDto {
  return parseRequestBody(overrideDeadlineRequestSchema, body, 'Deadline request validation failed');
}

export function parsePauseDeadlineRequest(body: unknown): PauseDeadlineRequestDto {
  return parseRequestBody(pauseDeadlineRequestSchema, body, 'Deadline request validation failed');
}

export function parseResumeDeadlineRequest(body: unknown): ResumeDeadlineRequestDto {
  return parseRequestBody(resumeDeadlineRequestSchema, body, 'Deadline request validation failed');
}

export function parseCancelDeadlineRequest(body: unknown): CancelDeadlineRequestDto {
  return parseRequestBody(cancelDeadlineRequestSchema, body, 'Deadline request validation failed');
}

function parseSortBy(value: string | string[] | undefined): DeadlineListSortBy {
  const sortBy = singleValue(value) ?? 'deadlineAt';

  if (!DEADLINE_LIST_SORT_FIELDS.includes(sortBy as DeadlineListSortBy)) {
    throw validationError('sortBy', 'Unsupported sort field', {
      allowedValues: [...DEADLINE_LIST_SORT_FIELDS],
    });
  }

  return sortBy as DeadlineListSortBy;
}

function parseSortOrder(value: string | string[] | undefined): SortOrder {
  const sortOrder = singleValue(value) ?? 'asc';

  if (sortOrder !== 'asc' && sortOrder !== 'desc') {
    throw validationError('sortOrder', 'sortOrder must be asc or desc');
  }

  return sortOrder;
}

function parseEnum<T extends z.ZodEnum>(
  value: string | string[] | undefined,
  schema: T,
  field: string,
): z.infer<T> | undefined {
  const raw = singleValue(value);
  if (!raw) return undefined;

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw validationError(field, `Unsupported ${field}`);
  }

  return parsed.data;
}

function parseOptionalText(value: string | string[] | undefined, field: string): string | undefined {
  const raw = singleValue(value)?.trim();
  if (!raw) return undefined;
  if (raw.length > 200) {
    throw validationError(field, `${field} must be 200 characters or fewer`);
  }

  return raw;
}

function parseOptionalPositiveInteger(
  value: string | string[] | undefined,
  field: string,
): number | undefined {
  const raw = singleValue(value);
  if (raw === undefined || raw === '') return undefined;

  return parsePositiveInteger(raw, field, undefined, 1, Number.MAX_SAFE_INTEGER);
}

function parsePositivePathInteger(value: string, field: string): number {
  return parsePositiveInteger(value, field, undefined, 1, Number.MAX_SAFE_INTEGER);
}

function parsePositiveInteger(
  value: string | string[] | undefined,
  field: string,
  fallback: number | undefined,
  min: number,
  max: number,
): number {
  const raw = singleValue(value);
  if (raw === undefined || raw === '') {
    if (fallback === undefined) {
      throw validationError(field, `${field} is required`);
    }
    return fallback;
  }

  const numberValue = Number(raw);
  if (!Number.isInteger(numberValue) || numberValue < min || numberValue > max) {
    throw validationError(field, `${field} must be an integer between ${min} and ${max}`);
  }

  return numberValue;
}

function parseOptionalDateOnly(
  value: string | string[] | undefined,
  field: string,
): string | undefined {
  const raw = singleValue(value);
  if (!raw) return undefined;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw validationError(field, `${field} must use YYYY-MM-DD format`);
  }

  return raw;
}

function parseBoolean(
  value: string | string[] | undefined,
  fallback: boolean,
  field: string,
): boolean {
  const raw = singleValue(value);
  if (raw === undefined || raw === '') return fallback;

  if (raw === 'true') return true;
  if (raw === 'false') return false;

  throw validationError(field, `${field} must be true or false`);
}

function parseRequestBody<T extends z.ZodType>(
  schema: T,
  body: unknown,
  message: string,
): z.infer<T> {
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', message, {
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        message: issue.message,
      })),
    });
  }

  return parsed.data;
}

function singleValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function validationError(
  field: string,
  message: string,
  extraDetails: Record<string, unknown> = {},
): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', 'Deadline query validation failed', {
    errors: [{ field, message }],
    ...extraDetails,
  });
}
