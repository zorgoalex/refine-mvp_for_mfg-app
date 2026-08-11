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
  StatusAutomationActionType,
  StatusAutomationConditions,
  StatusAutomationEventType,
} from '../application/status-automation.types';

const actionTypeSchema = z.enum([
  'change_order_status',
  'change_production_status',
  'change_details_production_status',
]);

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
    targetStatusId: z.number().int().positive(),
    conditions: conditionSchema.default({}),
    priority: z.number().int().default(100),
    isEnabled: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => validateEventSpecificFields(value.eventType, value.actionType, value.conditions, context));

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    eventType: z.string().trim().min(1).optional(),
    actionType: actionTypeSchema.optional(),
    targetStatusId: z.number().int().positive().optional(),
    conditions: conditionSchema.optional(),
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
      value.priority !== undefined ||
      value.isEnabled !== undefined;

    if (!hasUpdatableField) {
      context.addIssue({
        code: 'custom',
        path: [],
        message: 'At least one updatable field must be provided',
      });
    }

    if (value.eventType !== undefined || value.actionType !== undefined || value.conditions !== undefined) {
      validateEventSpecificFields(value.eventType, value.actionType, value.conditions, context);
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

export function parseCreateStatusAutomationRuleRequest(body: unknown): CreateStatusAutomationRuleDto {
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    throw validationError(parsed.error);
  }

  const data = parsed.data;
  return {
    name: data.name,
    eventType: data.eventType as StatusAutomationEventType,
    actionType: data.actionType,
    targetStatusId: data.targetStatusId,
    conditions: normalizeConditions(data.conditions),
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
  if (data.targetStatusId !== undefined) result.targetStatusId = data.targetStatusId;
  if (data.conditions !== undefined) result.conditions = normalizeConditions(data.conditions);
  if (data.priority !== undefined) result.priority = data.priority;
  if (data.isEnabled !== undefined) result.isEnabled = data.isEnabled;

  return result;
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
