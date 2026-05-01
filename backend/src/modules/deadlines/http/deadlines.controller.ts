import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
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

@Controller()
export class DeadlinesController {
  constructor(
    private readonly commands: DeadlineCommandService,
    private readonly queries: DeadlineQueryService,
    private readonly runtimeConfig: DeadlinesRuntimeConfigService,
  ) {}

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

  @Post('deadlines')
  async create(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    this.assertWriteEnabled();

    return {
      deadline: await this.commands.create({
        currentUser: this.requireCurrentUser(request),
        dto: parseCreateDeadlineRequest(body),
      }),
    };
  }

  @Patch('deadlines/:deadlineId')
  async override(
    @Req() request: RequestWithCurrentUser,
    @Param('deadlineId') deadlineIdParam: string,
    @Body() body: unknown,
  ) {
    this.assertWriteEnabled();

    return {
      deadline: await this.commands.override({
        currentUser: this.requireCurrentUser(request),
        deadlineId: parseDeadlineId(deadlineIdParam),
        dto: parseOverrideDeadlineRequest(body),
      }),
    };
  }

  @Post('deadlines/:deadlineId/pause')
  @HttpCode(200)
  async pause(
    @Req() request: RequestWithCurrentUser,
    @Param('deadlineId') deadlineIdParam: string,
    @Body() body: unknown,
  ) {
    this.assertWriteEnabled();

    return {
      deadline: await this.commands.pause({
        currentUser: this.requireCurrentUser(request),
        deadlineId: parseDeadlineId(deadlineIdParam),
        dto: parsePauseDeadlineRequest(body),
      }),
    };
  }

  @Post('deadlines/:deadlineId/resume')
  @HttpCode(200)
  async resume(
    @Req() request: RequestWithCurrentUser,
    @Param('deadlineId') deadlineIdParam: string,
    @Body() body: unknown,
  ) {
    this.assertWriteEnabled();

    return {
      deadline: await this.commands.resume({
        currentUser: this.requireCurrentUser(request),
        deadlineId: parseDeadlineId(deadlineIdParam),
        dto: parseResumeDeadlineRequest(body),
      }),
    };
  }

  @Post('deadlines/:deadlineId/cancel')
  @HttpCode(200)
  async cancel(
    @Req() request: RequestWithCurrentUser,
    @Param('deadlineId') deadlineIdParam: string,
    @Body() body: unknown,
  ) {
    this.assertWriteEnabled();

    return {
      deadline: await this.commands.cancel({
        currentUser: this.requireCurrentUser(request),
        deadlineId: parseDeadlineId(deadlineIdParam),
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
