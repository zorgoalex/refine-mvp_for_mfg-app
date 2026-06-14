import { getEventDefinition } from './notification-event-registry';
import type { NotificationRuleConditions, NotificationRuleRecipients } from './notification-rule.types';

export interface ValidateRuleContext {
  knownRoleCodes: readonly string[];
}

export interface NotificationRuleInput {
  ruleCode: string;
  eventType: string;
  projectId?: string | null;
  level: 'info' | 'warning' | 'error';
  priority: number;
  conditions: NotificationRuleConditions;
  recipients: NotificationRuleRecipients;
  titleTemplate?: string | null;
  messageTemplate?: string | null;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: string; detail?: string };

export function validateNotificationRuleInput(
  input: NotificationRuleInput,
  ctx: ValidateRuleContext,
): ValidationResult {
  const def = getEventDefinition(input.eventType);
  if (!def) return { ok: false, code: 'UNKNOWN_EVENT_TYPE' };

  if (!['info', 'warning', 'error'].includes(input.level)) {
    return { ok: false, code: 'INVALID_LEVEL' };
  }
  if (!Number.isInteger(input.priority)) {
    return { ok: false, code: 'INVALID_PRIORITY' };
  }

  const { resolvers = [], roleCodes = [], userIds = [] } = input.recipients ?? {};
  if (resolvers.length === 0 && roleCodes.length === 0 && userIds.length === 0) {
    return { ok: false, code: 'EMPTY_RECIPIENTS' };
  }
  for (const resolver of resolvers) {
    if (!def.supportedResolvers.includes(resolver)) {
      return { ok: false, code: 'UNSUPPORTED_RESOLVER', detail: resolver };
    }
  }
  for (const roleCode of roleCodes) {
    if (!ctx.knownRoleCodes.includes(roleCode)) {
      return { ok: false, code: 'UNKNOWN_ROLE_CODE', detail: roleCode };
    }
  }
  for (const userId of userIds) {
    if (!Number.isInteger(userId) || userId <= 0) {
      return { ok: false, code: 'INVALID_USER_ID', detail: String(userId) };
    }
  }

  const usesOrderConditions =
    (input.conditions.allowedFromOrderStatusIds?.length ?? 0) > 0 ||
    (input.conditions.excludeOrderStatusIds?.length ?? 0) > 0 ||
    input.conditions.excludeCompletedOrders === true;
  if (usesOrderConditions && !def.supportsOrderConditions) {
    return { ok: false, code: 'ORDER_CONDITION_UNSUPPORTED' };
  }

  return { ok: true };
}
