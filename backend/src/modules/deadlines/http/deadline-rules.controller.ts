import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { DeadlineCommandService } from '../application/deadline-command.service';
import { DeadlineQueryService } from '../application/deadline-query.service';
import { isUuid } from '../domain/deadline-validation';
import type {
  PreviewOrderDeadlineActionRulesRequestDto,
  UpdateGlobalTransitionRuleRequestDto,
  UpsertDeadlineOrderOverrideInput,
} from '../dto/deadline-action-rule.dto';
import { DeadlinesRuntimeConfigService } from './deadlines-runtime-config.service';

const uuidSchema = z.string().trim().refine(isUuid, { message: 'Invalid UUID' });
const positiveIntSchema = z.number().int().positive();
const reasonSchema = z.string().trim().min(1).max(1000);

const previewRequestSchema = z.object({
  eventType: z.literal('DEADLINE_EXPIRED').default('DEADLINE_EXPIRED'),
  deadlineId: uuidSchema.nullable().optional(),
  deadlineEventId: uuidSchema.nullable().optional(),
  fixtureKey: z.string().trim().min(1).nullable().optional(),
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

const updateGlobalTransitionRuleSchema = z
  .object({
    enabled: z.boolean().optional(),
    isEnabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(100000).optional(),
    eventType: z.literal('DEADLINE_EXPIRED').optional(),
    actionType: z.literal('change_order_status').optional(),
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

    return this.queries.listGlobalTransitionRules({
      currentUser: this.requireCurrentUser(request),
    });
  }

  @ApiParam({ name: 'actionRuleId', type: String })
  @ApiResponse({ status: 200, description: 'Updated global status transition rule' })
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
      requestId: request.requestId,
      actionRuleId: parseDeadlineActionRuleId(actionRuleIdParam),
      dto: parseUpdateGlobalTransitionRuleRequest(body),
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

export function parseUpdateGlobalTransitionRuleRequest(
  body: unknown,
): UpdateGlobalTransitionRuleRequestDto {
  return parseRequestBody(updateGlobalTransitionRuleSchema, body);
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
