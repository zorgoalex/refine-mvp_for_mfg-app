import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { NotificationRuleInput } from '../domain/notification-rule-validation';
import type {
  NotificationRuleConditions,
  NotificationRuleRecipients,
} from '../domain/notification-rule.types';

/**
 * Structural-only parse result for `recipients`. `resolvers` is kept as
 * `string[]` here because checking resolver membership against the event
 * registry is a domain concern owned by `validateNotificationRuleInput`
 * (Task 6), not by this structural request parser.
 */
interface ParsedRecipientsShape {
  resolvers?: string[];
  roleCodes?: string[];
  userIds?: number[];
}

/**
 * Narrows a structurally-parsed recipients object into the
 * `NotificationRuleRecipients` shape expected downstream. This is an
 * intentional type-level widening, not a domain check: resolver-kind
 * membership is validated later by `validateNotificationRuleInput`.
 */
function toNotificationRuleRecipients(
  recipients: ParsedRecipientsShape,
): NotificationRuleRecipients {
  return recipients as NotificationRuleRecipients;
}

const INVALID_PAYLOAD_CODE = 'INVALID_NOTIFICATION_RULE_PAYLOAD';

const levelSchema = z.enum(['info', 'warning', 'error']);
const integerArraySchema = z.array(z.number().int());
const stringArraySchema = z.array(z.string());
const nullableTemplateSchema = z.string().nullable();
const projectIdSchema = z.string().uuid().nullable();

const conditionsSchema = z
  .object({
    allowedFromOrderStatusIds: integerArraySchema.optional(),
    excludeOrderStatusIds: integerArraySchema.optional(),
    excludeCompletedOrders: z.boolean().optional(),
  })
  .strict();

const recipientsSchema = z
  .object({
    resolvers: stringArraySchema.optional(),
    roleCodes: stringArraySchema.optional(),
    userIds: integerArraySchema.optional(),
  })
  .strict();

const createNotificationRuleSchema = z.object({
  ruleCode: z.string().trim().min(1),
  eventType: z.string().trim().min(1),
  projectId: projectIdSchema.optional(),
  level: levelSchema.default('info'),
  priority: z.number().int().default(100),
  isEnabled: z.boolean().default(true),
  conditions: conditionsSchema.default({}),
  recipients: recipientsSchema.default({}),
  titleTemplate: nullableTemplateSchema.optional(),
  messageTemplate: nullableTemplateSchema.optional(),
});

const updateNotificationRuleSchema = z
  .object({
    level: levelSchema.optional(),
    priority: z.number().int().optional(),
    isEnabled: z.boolean().optional(),
    projectId: projectIdSchema.optional(),
    conditions: conditionsSchema.optional(),
    recipients: recipientsSchema.optional(),
    titleTemplate: nullableTemplateSchema.optional(),
    messageTemplate: nullableTemplateSchema.optional(),
    reason: z.string().optional(),
    expectedUpdatedAt: z.string().optional(),
  })
  .superRefine((value, context) => {
    const hasUpdatableField =
      value.level !== undefined ||
      value.priority !== undefined ||
      value.isEnabled !== undefined ||
      value.projectId !== undefined ||
      value.conditions !== undefined ||
      value.recipients !== undefined ||
      value.titleTemplate !== undefined ||
      value.messageTemplate !== undefined;

    if (!hasUpdatableField) {
      context.addIssue({
        code: 'custom',
        path: [],
        message: 'At least one updatable field must be provided',
      });
    }
  });

export interface UpdateNotificationRulePatch {
  projectId?: string | null;
  level?: 'info' | 'warning' | 'error';
  priority?: number;
  isEnabled?: boolean;
  conditions?: NotificationRuleConditions;
  recipients?: NotificationRuleRecipients;
  titleTemplate?: string | null;
  messageTemplate?: string | null;
}

export interface UpdateNotificationRuleParsedRequest {
  patch: UpdateNotificationRulePatch;
  reason?: string;
  expectedUpdatedAt?: string;
}

export function parseCreateNotificationRuleRequest(
  body: unknown,
): NotificationRuleInput & { isEnabled: boolean } {
  const parsed = createNotificationRuleSchema.safeParse(body);

  if (!parsed.success) {
    throw createInvalidPayloadError(parsed.error);
  }

  const data = parsed.data;

  const result: NotificationRuleInput & { isEnabled: boolean } = {
    ruleCode: data.ruleCode,
    eventType: data.eventType,
    level: data.level,
    priority: data.priority,
    isEnabled: data.isEnabled,
    conditions: data.conditions,
    recipients: toNotificationRuleRecipients(data.recipients),
  };

  if (data.projectId !== undefined) {
    result.projectId = data.projectId;
  }
  if (data.titleTemplate !== undefined) {
    result.titleTemplate = data.titleTemplate;
  }
  if (data.messageTemplate !== undefined) {
    result.messageTemplate = data.messageTemplate;
  }

  return result;
}

export function parseUpdateNotificationRuleRequest(body: unknown): UpdateNotificationRuleParsedRequest {
  const parsed = updateNotificationRuleSchema.safeParse(body);

  if (!parsed.success) {
    throw createInvalidPayloadError(parsed.error);
  }

  const data = parsed.data;
  const patch: UpdateNotificationRulePatch = {};

  if (data.level !== undefined) patch.level = data.level;
  if (data.priority !== undefined) patch.priority = data.priority;
  if (data.isEnabled !== undefined) patch.isEnabled = data.isEnabled;
  if (data.projectId !== undefined) patch.projectId = data.projectId;
  if (data.conditions !== undefined) patch.conditions = data.conditions;
  if (data.recipients !== undefined) patch.recipients = toNotificationRuleRecipients(data.recipients);
  if (data.titleTemplate !== undefined) patch.titleTemplate = data.titleTemplate;
  if (data.messageTemplate !== undefined) patch.messageTemplate = data.messageTemplate;

  const result: UpdateNotificationRuleParsedRequest = { patch };

  if (data.reason !== undefined) result.reason = data.reason;
  if (data.expectedUpdatedAt !== undefined) result.expectedUpdatedAt = data.expectedUpdatedAt;

  return result;
}

function createInvalidPayloadError(error: z.ZodError): ApiError {
  return new ApiError(422, INVALID_PAYLOAD_CODE, 'Notification rule payload validation failed', {
    errors: error.issues.map((issue) => ({
      field: issue.path.join('.') || 'body',
      message: issue.message,
    })),
  });
}
