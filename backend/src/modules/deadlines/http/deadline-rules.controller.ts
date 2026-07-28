import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { DeadlineCommandService } from '../application/deadline-command.service';
import { DeadlineQueryService } from '../application/deadline-query.service';
import { isUuid } from '../domain/deadline-validation';
import type {
  CreateGlobalTransitionRuleRequestDto,
  DeleteGlobalTransitionRuleRequestDto,
  PreviewOrderDeadlineActionRulesRequestDto,
  UpdateGlobalTransitionRuleRequestDto,
  UpsertDeadlineOrderOverrideInput,
} from '../dto/deadline-action-rule.dto';
import { DeadlinesRuntimeConfigService } from './deadlines-runtime-config.service';

const uuidSchema = z.string().trim().refine(isUuid, { message: 'Invalid UUID' });
const positiveIntSchema = z.number().int().positive();
const reasonSchema = z.string().trim().min(1).max(1000);
const deadlineTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('all_order_deadlines') }),
  z.object({ type: z.literal('final_order') }),
  z.object({
    type: z.literal('production_stage'),
    productionStatusId: positiveIntSchema,
  }),
]);
const delayAfterDeadlineSchema = z
  .object({
    days: z.number().int().min(0).max(3650).default(0),
    hours: z.number().int().min(0).max(23).default(0),
    minutes: z.number().int().min(0).max(59).default(0),
  })
  .superRefine((value, context) => {
    if (value.days + value.hours + value.minutes === 0) {
      context.addIssue({
        code: 'custom',
        path: ['days'],
        message: 'At least one delay value must be greater than zero',
      });
    }
  });
const isoTimestampSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Invalid timestamp' });

const previewRequestSchema = z
  .object({
    eventType: z.literal('DEADLINE_EXPIRED').default('DEADLINE_EXPIRED'),
    deadlineId: uuidSchema.nullable().optional(),
    deadlineEventId: uuidSchema.nullable().optional(),
    fixtureKey: z.string().trim().min(1).nullable().optional(),
  })
  .superRefine((value, context) => {
    if (value.deadlineEventId && !value.deadlineId) {
      context.addIssue({
        code: 'custom',
        path: ['deadlineId'],
        message: 'deadlineId is required when deadlineEventId is provided',
      });
    }
  });

const overrideConfigSchema = z
  .object({
    conditions: z.record(z.string(), z.unknown()).optional(),
    actionConfig: z.record(z.string(), z.unknown()).optional(),
    timerConfig: z
      .object({
        durationValue: positiveIntSchema.optional(),
        durationUnit: z.enum(['minute', 'hour', 'day', 'working_hour', 'working_day']).optional(),
      })
      .optional(),
  })
  .optional();

const upsertOrderOverrideSchema = z
  .object({
    targetType: z.enum(['policy', 'action_rule']),
    policyId: uuidSchema.optional(),
    actionRuleId: uuidSchema.optional(),
    isDisabled: z.boolean().optional(),
    overrideConfig: overrideConfigSchema,
    reason: reasonSchema,
  })
  .superRefine((value, context) => {
    if (value.targetType === 'policy' && !value.policyId) {
      context.addIssue({ code: 'custom', path: ['policyId'], message: 'policyId is required' });
    }
    if (value.targetType === 'action_rule' && !value.actionRuleId) {
      context.addIssue({ code: 'custom', path: ['actionRuleId'], message: 'actionRuleId is required' });
    }
    if (value.policyId && value.actionRuleId) {
      context.addIssue({
        code: 'custom',
        path: ['targetType'],
        message: 'Exactly one override target must be provided',
      });
    }
  });

const retireOverrideSchema = z.object({
  reason: reasonSchema,
});

const createGlobalTransitionRuleSchema = z
  .object({
    ruleName: z.string().trim().min(1).max(160),
    ruleCode: z.string().trim().min(1).max(100).optional(),
    policyId: uuidSchema.nullable().optional(),
    isEnabled: z.boolean().default(false),
    priority: z.number().int().min(0).max(100000).default(100),
    eventType: z.literal('DEADLINE_EXPIRED').default('DEADLINE_EXPIRED'),
    actionType: z.literal('change_order_status').default('change_order_status'),
    deadlineTarget: deadlineTargetSchema.default({ type: 'all_order_deadlines' }),
    delayAfterDeadline: delayAfterDeadlineSchema.optional(),
    targetOrderStatusId: positiveIntSchema,
    allowedFromOrderStatusIds: z.array(positiveIntSchema).min(1),
    excludeOrderStatusIds: z.array(positiveIntSchema).default([]),
    excludeCompletedOrders: z.boolean().default(true),
    requireCurrentDeadlineEvent: z.boolean().default(true),
    reason: reasonSchema,
    comment: z.string().trim().max(2000).nullable().optional(),
  })
  .superRefine((value, context) => {
    validateTransitionRuleStatuses(value, context);
    validateTransitionRuleDeadlineTarget(value, context);
  });

const updateGlobalTransitionRuleSchema = z
  .object({
    expectedUpdatedAt: isoTimestampSchema,
    ruleName: z.string().trim().min(1).max(160).optional(),
    ruleCode: z.string().trim().min(1).max(100).nullable().optional(),
    policyId: uuidSchema.nullable().optional(),
    isEnabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(100000).optional(),
    eventType: z.literal('DEADLINE_EXPIRED').optional(),
    actionType: z.literal('change_order_status').optional(),
    deadlineTarget: deadlineTargetSchema.optional(),
    delayAfterDeadline: delayAfterDeadlineSchema.nullable().optional(),
    targetOrderStatusId: positiveIntSchema.optional(),
    allowedFromOrderStatusIds: z.array(positiveIntSchema).optional(),
    excludeOrderStatusIds: z.array(positiveIntSchema).optional(),
    excludeCompletedOrders: z.boolean().optional(),
    requireCurrentDeadlineEvent: z.boolean().optional(),
    reason: reasonSchema,
    comment: z.string().trim().max(2000).nullable().optional(),
  })
  .superRefine((value, context) => {
    if (value.allowedFromOrderStatusIds && value.allowedFromOrderStatusIds.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['allowedFromOrderStatusIds'],
        message: 'allowedFromOrderStatusIds is required for status rules',
      });
    }
    validateTransitionRuleStatuses(value, context);
    validateTransitionRuleDeadlineTarget(value, context);
  });

const deleteGlobalTransitionRuleSchema = z.object({
  expectedUpdatedAt: isoTimestampSchema,
  reason: reasonSchema,
  comment: z.string().trim().max(2000).nullable().optional(),
});

@ApiTags('Deadline Rules')
@ApiBearerAuth()
@Controller('')
export class DeadlineRulesController {
  constructor(
    @Inject(DeadlineCommandService)
    private readonly commands: DeadlineCommandService,
    @Inject(DeadlineQueryService)
    private readonly queries: DeadlineQueryService,
    @Inject(DeadlinesRuntimeConfigService)
    private readonly runtimeConfig: DeadlinesRuntimeConfigService,
  ) {}

  @ApiParam({ name: 'orderId', type: Number })
  @ApiResponse({ status: 200, description: 'Effective deadline rules for an order' })
  @ApiOperation({ operationId: 'listOrderEffectiveDeadlineRules', summary: 'List effective deadline rules for an order' })
  @Get('orders/:orderId/deadline-effective-rules')
  async listOrderEffectiveRules(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
  ) {
    this.assertReadEnabled();

    return this.queries.listOrderEffectiveRules({
      currentUser: this.requireCurrentUser(request),
      orderId: parsePositivePathInteger(orderIdParam, 'orderId'),
    });
  }

  @ApiParam({ name: 'orderId', type: Number })
  @ApiResponse({ status: 200, description: 'Dry-run action rule preview for an order/event' })
  @ApiOperation({ operationId: 'previewOrderDeadlineActionRules', summary: 'Preview order action rule decisions' })
  @Post('orders/:orderId/deadline-action-preview')
  @HttpCode(200)
  async previewOrderActionRules(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Body() body: unknown,
  ) {
    this.assertReadEnabled();

    return this.queries.previewOrderActionRules({
      currentUser: this.requireCurrentUser(request),
      orderId: parsePositivePathInteger(orderIdParam, 'orderId'),
      dto: parseOrderDeadlineActionPreviewRequest(body),
    });
  }

  @ApiParam({ name: 'orderId', type: Number })
  @ApiResponse({ status: 200, description: 'Created or updated order override' })
  @ApiOperation({ operationId: 'upsertDeadlineOrderOverride', summary: 'Create or update an order-level deadline override' })
  @Post('orders/:orderId/deadline-overrides')
  async upsertOrderOverride(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Body() body: unknown,
  ) {
    this.assertWriteEnabled();

    return this.commands.upsertOrderOverride({
      currentUser: this.requireCurrentUser(request),
      requestId: request.requestId,
      dto: parseUpsertDeadlineOrderOverrideRequest(
        parsePositivePathInteger(orderIdParam, 'orderId'),
        body,
      ),
    });
  }

  @ApiParam({ name: 'orderId', type: Number })
  @ApiParam({ name: 'overrideId', type: String })
  @ApiResponse({ status: 200, description: 'Soft-retired order override' })
  @ApiOperation({ operationId: 'retireDeadlineOrderOverride', summary: 'Remove an order-level deadline override' })
  @Delete('orders/:orderId/deadline-overrides/:overrideId')
  @HttpCode(200)
  async retireOrderOverride(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Param('overrideId') overrideIdParam: string,
    @Body() body: unknown,
  ) {
    this.assertWriteEnabled();
    parsePositivePathInteger(orderIdParam, 'orderId');
    const dto = parseRetireDeadlineOrderOverrideRequest(body);

    return this.commands.retireOrderOverride({
      currentUser: this.requireCurrentUser(request),
      requestId: request.requestId,
      orderId: parsePositivePathInteger(orderIdParam, 'orderId'),
      overrideId: parseDeadlineActionRuleId(overrideIdParam),
      reason: dto.reason,
    });
  }

  @ApiResponse({ status: 200, description: 'Global status transition rules' })
  @ApiOperation({ operationId: 'listGlobalDeadlineTransitionRules', summary: 'List global deadline transition rules' })
  @Get('deadline-transition-rules')
  async listGlobalTransitionRules(@Req() request: RequestWithCurrentUser) {
    this.assertReadEnabled();

    const result = await this.queries.listGlobalTransitionRules({
      currentUser: this.requireCurrentUser(request),
    });

    return {
      ...result,
      readiness: this.runtimeConfig.getTransitionRulesReadiness(),
    };
  }

  @ApiResponse({ status: 201, description: 'Created global status transition rule' })
  @ApiOperation({ operationId: 'createGlobalDeadlineTransitionRule', summary: 'Create a global deadline transition rule' })
  @Post('deadline-transition-rules')
  async createGlobalTransitionRule(
    @Req() request: RequestWithCurrentUser,
    @Body() body: unknown,
  ) {
    this.assertWriteEnabled();

    return this.commands.createGlobalTransitionRule({
      currentUser: this.requireCurrentUser(request),
      requestId: requireDeadlineRuleRequestId(request),
      dto: parseCreateGlobalTransitionRuleRequest(body),
    });
  }

  @ApiParam({ name: 'actionRuleId', type: String })
  @ApiResponse({ status: 200, description: 'Updated global status transition rule' })
  @ApiResponse({ status: 409, description: 'Stale or conflicting global status transition rule update' })
  @ApiOperation({ operationId: 'updateGlobalDeadlineTransitionRule', summary: 'Update a global deadline transition rule' })
  @Patch('deadline-transition-rules/:actionRuleId')
  async updateGlobalTransitionRule(
    @Req() request: RequestWithCurrentUser,
    @Param('actionRuleId') actionRuleIdParam: string,
    @Body() body: unknown,
  ) {
    this.assertWriteEnabled();

    return this.commands.updateGlobalTransitionRule({
      currentUser: this.requireCurrentUser(request),
      requestId: requireDeadlineRuleRequestId(request),
      actionRuleId: parseDeadlineActionRuleId(actionRuleIdParam),
      dto: parseUpdateGlobalTransitionRuleRequest(body),
    });
  }

  @ApiParam({ name: 'actionRuleId', type: String })
  @ApiResponse({ status: 200, description: 'Deleted global status transition rule' })
  @ApiResponse({ status: 409, description: 'Stale or referenced global status transition rule' })
  @ApiOperation({ operationId: 'deleteGlobalDeadlineTransitionRule', summary: 'Delete a global deadline transition rule' })
  @Delete('deadline-transition-rules/:actionRuleId')
  @HttpCode(200)
  async deleteGlobalTransitionRule(
    @Req() request: RequestWithCurrentUser,
    @Param('actionRuleId') actionRuleIdParam: string,
    @Body() body: unknown,
  ) {
    this.assertWriteEnabled();

    return this.commands.deleteGlobalTransitionRule({
      currentUser: this.requireCurrentUser(request),
      requestId: requireDeadlineRuleRequestId(request),
      actionRuleId: parseDeadlineActionRuleId(actionRuleIdParam),
      dto: parseDeleteGlobalTransitionRuleRequest(body),
    });
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
      throw new ApiError(503, 'DEADLINES_READ_ONLY', 'Deadline rules are read-only', {
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

function validateTransitionRuleStatuses(
  value: {
    targetOrderStatusId?: number;
    allowedFromOrderStatusIds?: number[];
    excludeOrderStatusIds?: number[];
  },
  context: z.RefinementCtx,
): void {
  const allowed = value.allowedFromOrderStatusIds ?? [];
  const excluded = value.excludeOrderStatusIds ?? [];

  addDuplicateStatusIssue(allowed, 'allowedFromOrderStatusIds', context);
  addDuplicateStatusIssue(excluded, 'excludeOrderStatusIds', context);

  if (value.targetOrderStatusId && allowed.includes(value.targetOrderStatusId)) {
    context.addIssue({
      code: 'custom',
      path: ['targetOrderStatusId'],
      message: 'Target status must differ from allowed source statuses',
    });
  }
  if (value.targetOrderStatusId && excluded.includes(value.targetOrderStatusId)) {
    context.addIssue({
      code: 'custom',
      path: ['targetOrderStatusId'],
      message: 'Target status must not be excluded',
    });
  }
  if (allowed.some((statusId) => excluded.includes(statusId))) {
    context.addIssue({
      code: 'custom',
      path: ['excludeOrderStatusIds'],
      message: 'Allowed and excluded statuses must not overlap',
    });
  }
  const safetyValue = value as {
    excludeCompletedOrders?: boolean;
    requireCurrentDeadlineEvent?: boolean;
  };
  if (safetyValue.excludeCompletedOrders === false) {
    context.addIssue({
      code: 'custom',
      path: ['excludeCompletedOrders'],
      message: 'Completed-order protection is mandatory',
    });
  }
  if (safetyValue.requireCurrentDeadlineEvent === false) {
    context.addIssue({
      code: 'custom',
      path: ['requireCurrentDeadlineEvent'],
      message: 'Current-deadline-event protection is mandatory',
    });
  }
}

function validateTransitionRuleDeadlineTarget(
  value: {
    policyId?: string | null;
    deadlineTarget?: {
      type: 'all_order_deadlines' | 'final_order' | 'production_stage';
      productionStatusId?: number;
    };
  },
  context: z.RefinementCtx,
): void {
  if (value.policyId && value.deadlineTarget?.type !== 'all_order_deadlines') {
    context.addIssue({
      code: 'custom',
      path: ['deadlineTarget'],
      message: 'deadlineTarget cannot be combined with policyId',
    });
  }
}

function addDuplicateStatusIssue(
  statusIds: number[],
  field: string,
  context: z.RefinementCtx,
): void {
  if (new Set(statusIds).size !== statusIds.length) {
    context.addIssue({
      code: 'custom',
      path: [field],
      message: 'Status list must not contain duplicates',
    });
  }
}

export function parseOrderDeadlineActionPreviewRequest(
  body: unknown,
): PreviewOrderDeadlineActionRulesRequestDto {
  return parseRequestBody(previewRequestSchema, body);
}

export function parseUpsertDeadlineOrderOverrideRequest(
  orderId: number,
  body: unknown,
): UpsertDeadlineOrderOverrideInput {
  const parsed = parseRequestBody(upsertOrderOverrideSchema, body);

  return parsed.targetType === 'policy'
    ? {
        orderId,
        targetType: 'policy',
        policyId: parsed.policyId as string,
        isDisabled: parsed.isDisabled,
        overrideConfig: parsed.overrideConfig,
        reason: parsed.reason,
      }
    : {
        orderId,
        targetType: 'action_rule',
        actionRuleId: parsed.actionRuleId as string,
        isDisabled: parsed.isDisabled,
        overrideConfig: parsed.overrideConfig,
        reason: parsed.reason,
      };
}

export function parseRetireDeadlineOrderOverrideRequest(body: unknown): { reason: string } {
  return parseRequestBody(retireOverrideSchema, body);
}

export function parseCreateGlobalTransitionRuleRequest(
  body: unknown,
): CreateGlobalTransitionRuleRequestDto {
  return parseRequestBody(createGlobalTransitionRuleSchema, body);
}

export function parseUpdateGlobalTransitionRuleRequest(
  body: unknown,
): UpdateGlobalTransitionRuleRequestDto {
  return parseRequestBody(updateGlobalTransitionRuleSchema, body);
}

export function parseDeleteGlobalTransitionRuleRequest(
  body: unknown,
): DeleteGlobalTransitionRuleRequestDto {
  return parseRequestBody(deleteGlobalTransitionRuleSchema, body);
}

export function parseDeadlineActionRuleId(value: string): string {
  if (!isUuid(value)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid deadline rule id', { field: 'actionRuleId' });
  }

  return value;
}

function parsePositivePathInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid path integer', { field });
  }

  return parsed;
}

function parseRequestBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body ?? {});

  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Deadline rule validation failed', {
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        message: issue.message,
      })),
    });
  }

  return parsed.data;
}

function requireDeadlineRuleRequestId(request: RequestWithCurrentUser): string {
  if (!request.requestId) {
    throw new ApiError(500, 'REQUEST_ID_MISSING', 'Request id is missing');
  }

  return request.requestId;
}
