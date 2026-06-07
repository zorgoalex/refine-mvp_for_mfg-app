import type { DatabaseClient } from '../../../database/database.types';
import { evaluateRuleConditions } from '../domain/notification-condition-evaluator';
import { getEventDefinition } from '../domain/notification-event-registry';
import { buildNotificationDeliveryKey } from '../domain/notification-idempotency';
import type { NotificationEventContext, NotificationRule } from '../domain/notification-rule.types';
import type { OutboxEventRecord } from '../domain/outbox-event.types';
import type { NotificationContextBuilderPort } from '../ports/notification-context.port';
import type { NotificationRuleRepositoryPort } from '../ports/notification-rule-repository.port';
import type { NotificationWritePort } from '../ports/notification-write.port';
import type { RecipientResolverService } from './recipient-resolver.service';

const SOURCE_TYPE = 'notification_rule';

export interface NotificationRuleEngineDeps {
  ruleRepo: Pick<NotificationRuleRepositoryPort, 'listEnabledByEvent'>;
  contextBuilder: NotificationContextBuilderPort;
  recipientResolver: Pick<RecipientResolverService, 'resolve'>;
  notificationWrite: NotificationWritePort;
}

export interface ProcessEventResult {
  matched: number;
  created: number;
  skipped?: string;
}

/**
 * Whitelist of context fields that may be interpolated into rule templates.
 * SECURITY: never extend this with `payload` or any finance/phone/secret
 * field — templates are operator-authored but context can carry sensitive
 * producer payload data that must never be echoed back into a notification.
 */
const TEMPLATE_FIELD_WHITELIST = ['orderId', 'clientId', 'orderStatusId', 'eventType'] as const;
type TemplateField = (typeof TEMPLATE_FIELD_WHITELIST)[number];

function whitelistedValues(ctx: NotificationEventContext): Record<TemplateField, string> {
  return {
    orderId: ctx.orderId != null ? String(ctx.orderId) : '',
    clientId: ctx.clientId != null ? String(ctx.clientId) : '',
    orderStatusId: ctx.orderStatusId != null ? String(ctx.orderStatusId) : '',
    eventType: ctx.eventType,
  };
}

function isTemplateField(name: string): name is TemplateField {
  return (TEMPLATE_FIELD_WHITELIST as readonly string[]).includes(name);
}

/**
 * Interpolates ONLY whitelisted context fields into a template string.
 * Unknown `{placeholder}` tokens (including `{payload}` and any field not in
 * the whitelist) are stripped/blanked — never echoed with arbitrary data.
 */
function interpolateWhitelisted(template: string, values: Record<TemplateField, string>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name: string) => {
    if (isTemplateField(name)) return values[name];
    return '';
  });
}

function defaultTitle(values: Record<TemplateField, string>): string {
  return `Order ${values.orderId} — ${values.eventType}`;
}

function defaultMessage(ctx: NotificationEventContext, values: Record<TemplateField, string>): string {
  const statusSuffix = ctx.orderStatusId != null ? ` (status ${values.orderStatusId})` : '';
  return `Order ${values.orderId} event ${values.eventType}${statusSuffix}`;
}

/**
 * Renders rule title/message using ONLY a fixed whitelist of context fields
 * (`orderId`, `clientId`, `orderStatusId`, `eventType`). Never reads
 * `ctx.payload` or any finance/phone/secret field — this is the redaction
 * boundary that keeps producer payload data out of user-facing notifications.
 */
export function renderNotificationText(
  rule: Pick<NotificationRule, 'titleTemplate' | 'messageTemplate'>,
  ctx: NotificationEventContext,
): { title: string; message: string } {
  const values = whitelistedValues(ctx);
  const title = rule.titleTemplate != null ? interpolateWhitelisted(rule.titleTemplate, values) : defaultTitle(values);
  const message = rule.messageTemplate != null
    ? interpolateWhitelisted(rule.messageTemplate, values)
    : defaultMessage(ctx, values);
  return { title, message };
}

export class NotificationRuleEngineService {
  constructor(private readonly deps: NotificationRuleEngineDeps) {}

  async processEvent(client: DatabaseClient, event: OutboxEventRecord): Promise<ProcessEventResult> {
    const definition = getEventDefinition(event.eventType);
    if (!definition || definition.owner !== 'engine') {
      return { matched: 0, created: 0, skipped: 'not_engine_owned' };
    }

    const ctx = await this.deps.contextBuilder.buildContext(client, event);
    const rules = await this.deps.ruleRepo.listEnabledByEvent(client, event.eventType);

    let matched = 0;
    let created = 0;

    for (const rule of rules) {
      const { matched: ruleMatched } = evaluateRuleConditions(rule.conditions, ctx);
      if (!ruleMatched) continue;
      matched += 1;

      const { title, message } = renderNotificationText(rule, ctx);
      const recipientUserIds = await this.deps.recipientResolver.resolve(client, rule.recipients, ctx);

      for (const userId of recipientUserIds) {
        const idempotencyKey = buildNotificationDeliveryKey({
          outboxEventId: event.outboxEventId,
          ruleId: rule.notificationRuleId,
          userId,
        });
        const result = await this.deps.notificationWrite.insertIfAbsent(client, {
          userId,
          level: rule.level,
          title,
          message,
          entityType: 'order',
          entityId: ctx.orderId != null ? String(ctx.orderId) : null,
          sourceType: SOURCE_TYPE,
          sourceId: rule.notificationRuleId,
          idempotencyKey,
        });
        if (result.created) created += 1;
      }
    }

    return { matched, created };
  }
}
