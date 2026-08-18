import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type {
  CreateStatusAutomationRuleDto,
  UpdateStatusAutomationRuleDto,
} from '../adapters/pg-status-automation-repository';
import {
  getEventDescriptor,
  STATUS_AUTOMATION_EVENTS,
} from '../domain/status-automation-events';
import type {
  StatusAutomationActionConfig,
  StatusAutomationActionType,
  StatusAutomationConditions,
  StatusAutomationEventType,
} from '../application/status-automation.types';

const actionTypeSchema = z.enum([
  'change_order_status',
  'change_production_status',
  'change_details_production_status',
  'map_order_status_to_details_production_status',
  'map_production_status_to_order_status',
]);

const statusMappingEntrySchema = z
  .object({
    sourceStatusIds: z.array(z.number().int().positive()).min(1),
    targetStatusId: z.number().int().positive(),
  })
  .strict();

const actionConfigSchema = z
  .object({
    statusMapping: z
      .object({ entries: z.array(statusMappingEntrySchema).min(1) })
      .strict()
      .optional(),
  })
  .strict();

const conditionSchema = z
  .object({
    currentOrderStatusIn: z.array(z.number().int().positive()).optional(),
    currentOrderStatusNotIn: z.array(z.number().int().positive()).optional(),
    currentPaymentStatusIn: z.array(z.number().int().positive()).optional(),
    currentPaymentStatusNotIn: z.array(z.number().int().positive()).optional(),
    currentProductionStatusIn: z.array(z.number().int().positive()).optional(),
    currentProductionStatusNotIn: z.array(z.number().int().positive()).optional(),
    paidShareGte: z.number().min(0).max(100).optional(),
    orderSourceIn: z.array(z.enum(['manual', 'bazis', 'import'])).optional(),
    firstPaymentOnly: z.boolean().optional(),
  })
  .strict();

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    eventType: z.string().trim().min(1),
    actionType: actionTypeSchema,
    targetStatusId: z.number().int().positive().nullable().optional(),
    conditions: conditionSchema.default({}),
    actionConfig: actionConfigSchema.default({}),
    priority: z.number().int().default(100),
    isEnabled: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => validateRuleShape(value, context));

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    eventType: z.string().trim().min(1).optional(),
    actionType: actionTypeSchema.optional(),
    targetStatusId: z.number().int().positive().nullable().optional(),
    conditions: conditionSchema.optional(),
    actionConfig: actionConfigSchema.optional(),
    priority: z.number().int().optional(),
    isEnabled: z.boolean().optional(),
    version: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasUpdatableField =
      value.name !== undefined ||
      value.eventType !== undefined ||
      value.actionType !== undefined ||
      value.targetStatusId !== undefined ||
      value.conditions !== undefined ||
      value.actionConfig !== undefined ||
      value.priority !== undefined ||
      value.isEnabled !== undefined;

    if (!hasUpdatableField) {
      context.addIssue({
        code: 'custom',
        path: [],
        message: 'At least one updatable field must be provided',
      });
    }

    if (
      value.eventType !== undefined ||
      value.actionType !== undefined ||
      value.targetStatusId !== undefined ||
      value.conditions !== undefined ||
      value.actionConfig !== undefined
    ) {
      validateRuleShape(value, context);
    }
  });

export interface StatusAutomationEventTypeDto {
  eventType: StatusAutomationEventType;
  title: string;
  group: 'order' | 'dates' | 'statuses' | 'payments' | 'production';
  description: string;
  allowedConditions: Array<keyof StatusAutomationConditions>;
  allowedActions: StatusAutomationActionType[];
}

export interface StatusAutomationOrderRefreshSummaryDto {
  orderId: number;
  orderFound: boolean;
  evaluatedRuleCount: number;
  matchedRuleCount: number;
  executedActionCount: number;
  skippedRuleCount: number;
  skippedActionCount: number;
}

export interface StatusAutomationRefreshFailureDto {
  orderId: number;
  code: string;
  message: string;
}

export interface StatusAutomationRecentOrdersRefreshResponseDto {
  cutoffDate: string;
  orderCount: number;
  processedOrderCount: number;
  failedOrderCount: number;
  failures: StatusAutomationRefreshFailureDto[];
  totals: Omit<StatusAutomationOrderRefreshSummaryDto, 'orderId' | 'orderFound'>;
  refreshedAt: string;
  requestId: string;
}

export function parseCreateStatusAutomationRuleRequest(body: unknown): CreateStatusAutomationRuleDto {
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    throw validationError(parsed.error);
  }

  const data = parsed.data;
  const actionConfig = normalizeActionConfig(data.actionConfig);
  return {
    name: data.name,
    eventType: data.eventType as StatusAutomationEventType,
    actionType: data.actionType,
    targetStatusId: data.targetStatusId ?? null,
    conditions: normalizeConditions(data.conditions),
    ...(actionConfig.statusMapping ? { actionConfig } : {}),
    priority: data.priority,
    isEnabled: data.isEnabled,
  };
}

export function parseUpdateStatusAutomationRuleRequest(body: unknown): UpdateStatusAutomationRuleDto {
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    throw validationError(parsed.error);
  }

  const data = parsed.data;
  const result: UpdateStatusAutomationRuleDto = { version: data.version };

  if (data.name !== undefined) result.name = data.name;
  if (data.eventType !== undefined) result.eventType = data.eventType as StatusAutomationEventType;
  if (data.actionType !== undefined) result.actionType = data.actionType;
  if (data.targetStatusId !== undefined) result.targetStatusId = data.targetStatusId ?? null;
  if (data.conditions !== undefined) result.conditions = normalizeConditions(data.conditions);
  if (data.actionConfig !== undefined) result.actionConfig = normalizeActionConfig(data.actionConfig);
  if (data.priority !== undefined) result.priority = data.priority;
  if (data.isEnabled !== undefined) result.isEnabled = data.isEnabled;

  return result;
}

function validateRuleShape(
  value: {
    eventType?: string;
    actionType?: StatusAutomationActionType;
    targetStatusId?: number | null;
    conditions?: z.infer<typeof conditionSchema>;
    actionConfig?: z.infer<typeof actionConfigSchema>;
  },
  context: z.RefinementCtx,
): void {
  validateEventSpecificFields(value.eventType, value.actionType, value.conditions, context);
  validateActionSpecificFields(value.actionType, value.targetStatusId, value.actionConfig, context);
}

function validateEventSpecificFields(
  eventType: string | undefined,
  actionType: StatusAutomationActionType | undefined,
  conditions: z.infer<typeof conditionSchema> | undefined,
  context: z.RefinementCtx,
): void {
  if (eventType === undefined) {
    return;
  }

  const descriptor = getEventDescriptor(eventType);
  if (descriptor === null) {
    context.addIssue({
      code: 'custom',
      path: ['eventType'],
      message: 'Unknown status automation event type',
    });
    return;
  }

  if (actionType !== undefined && !descriptor.allowedActions.includes(actionType)) {
    context.addIssue({
      code: 'custom',
      path: ['actionType'],
      message: 'Action type is not allowed for this event',
    });
  }

  if (conditions !== undefined) {
    for (const key of Object.keys(conditions) as Array<keyof StatusAutomationConditions>) {
      if (!descriptor.allowedConditions.includes(key)) {
        context.addIssue({
          code: 'custom',
          path: ['conditions', key],
          message: 'Condition is not allowed for this event',
        });
      }
    }
  }
}

function normalizeConditions(value: z.infer<typeof conditionSchema>): StatusAutomationConditions {
  const conditions: StatusAutomationConditions = {};

  if (value.currentOrderStatusIn !== undefined && value.currentOrderStatusIn.length > 0) {
    conditions.currentOrderStatusIn = value.currentOrderStatusIn;
  }
  if (value.currentOrderStatusNotIn !== undefined && value.currentOrderStatusNotIn.length > 0) {
    conditions.currentOrderStatusNotIn = value.currentOrderStatusNotIn;
  }
  if (value.currentPaymentStatusIn !== undefined && value.currentPaymentStatusIn.length > 0) {
    conditions.currentPaymentStatusIn = value.currentPaymentStatusIn;
  }
  if (value.currentPaymentStatusNotIn !== undefined && value.currentPaymentStatusNotIn.length > 0) {
    conditions.currentPaymentStatusNotIn = value.currentPaymentStatusNotIn;
  }
  if (value.currentProductionStatusIn !== undefined && value.currentProductionStatusIn.length > 0) {
    conditions.currentProductionStatusIn = value.currentProductionStatusIn;
  }
  if (
    value.currentProductionStatusNotIn !== undefined &&
    value.currentProductionStatusNotIn.length > 0
  ) {
    conditions.currentProductionStatusNotIn = value.currentProductionStatusNotIn;
  }
  if (value.paidShareGte !== undefined) conditions.paidShareGte = value.paidShareGte;
  if (value.orderSourceIn !== undefined && value.orderSourceIn.length > 0) {
    conditions.orderSourceIn = value.orderSourceIn;
  }
  if (value.firstPaymentOnly !== undefined) conditions.firstPaymentOnly = value.firstPaymentOnly;

  return conditions;
}

function validateActionSpecificFields(
  actionType: StatusAutomationActionType | undefined,
  targetStatusId: number | null | undefined,
  actionConfig: z.infer<typeof actionConfigSchema> | undefined,
  context: z.RefinementCtx,
): void {
  if (actionType === undefined) return;

  const isMappingAction =
    actionType === 'map_order_status_to_details_production_status' ||
    actionType === 'map_production_status_to_order_status';
  const entries = actionConfig?.statusMapping?.entries ?? [];

  if (isMappingAction) {
    if (entries.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['actionConfig', 'statusMapping', 'entries'],
        message: 'Status mapping entries are required for mapping actions',
      });
    }
    const seen = new Set<number>();
    const duplicates = new Set<number>();
    for (const entry of entries) {
      for (const sourceStatusId of entry.sourceStatusIds) {
        if (seen.has(sourceStatusId)) duplicates.add(sourceStatusId);
        seen.add(sourceStatusId);
      }
    }
    if (duplicates.size > 0) {
      context.addIssue({
        code: 'custom',
        path: ['actionConfig', 'statusMapping', 'entries'],
        message: `Source statuses are mapped more than once: ${[...duplicates].join(', ')}`,
      });
    }
    return;
  }

  if (targetStatusId === undefined || targetStatusId === null) {
    context.addIssue({
      code: 'custom',
      path: ['targetStatusId'],
      message: 'Target status is required for this action',
    });
  }
  if (entries.length > 0) {
    context.addIssue({
      code: 'custom',
      path: ['actionConfig', 'statusMapping'],
      message: 'Status mapping is allowed only for mapping actions',
    });
  }
}

function normalizeActionConfig(value: z.infer<typeof actionConfigSchema>): StatusAutomationActionConfig {
  const entries = value.statusMapping?.entries.map((entry) => ({
    sourceStatusIds: Array.from(new Set(entry.sourceStatusIds)),
    targetStatusId: entry.targetStatusId,
  }));
  return entries?.length ? { statusMapping: { entries } } : {};
}

function validationError(error: z.ZodError): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', 'Status automation rule payload validation failed', {
    errors: error.issues.map((issue) => ({
      field: issue.path.join('.') || 'body',
      message: issue.message,
    })),
  });
}

export function listStatusAutomationEventTypes(): StatusAutomationEventTypeDto[] {
  return STATUS_AUTOMATION_EVENTS.map((descriptor) => ({
    eventType: descriptor.eventType,
    title: descriptor.title,
    group: descriptor.group,
    description: descriptor.description,
    allowedConditions: [...descriptor.allowedConditions],
    allowedActions: [...descriptor.allowedActions],
  }));
}
