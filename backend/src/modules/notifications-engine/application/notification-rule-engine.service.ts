import type { DatabaseClient } from '../../../database/database.types';
import { resolveEffectiveEventType } from '../domain/deadline-event-extractor';
import { evaluateRuleConditions } from '../domain/notification-condition-evaluator';
import { getEventDefinition, withOwnerOverride, type NotificationFeatureFlag } from '../domain/notification-event-registry';
import { buildNotificationDeliveryKey } from '../domain/notification-idempotency';
import type { NotificationEventContext, NotificationRule } from '../domain/notification-rule.types';
import type { OutboxEventRecord } from '../domain/outbox-event.types';
import type { NotificationContextBuilderPort } from '../ports/notification-context.port';
import type { NotificationChannelDeliveryPort } from '../ports/notification-channel-delivery.port';
import type { NotificationRuleRepositoryPort } from '../ports/notification-rule-repository.port';
import type { NotificationWritePort } from '../ports/notification-write.port';
import type { VisibilityPort } from '../ports/visibility.port';
import type { RecipientResolverService } from './recipient-resolver.service';

const SOURCE_TYPE = 'notification_rule';

const DEADLINE_EVENT_TYPES = new Set(['DEADLINE_EXPIRED']);

export interface NotificationRuleEngineRuntimeConfig {
  isEngineOwnsDeadline(): boolean;
  /** Флаг семейства событий; без реализации — выключен (fail closed). */
  isFeatureEnabled?(flag: NotificationFeatureFlag): boolean;
}

export interface NotificationRuleEngineDeps {
  ruleRepo: Pick<NotificationRuleRepositoryPort, 'listEnabledByEvent'>;
  contextBuilder: NotificationContextBuilderPort;
  recipientResolver: Pick<RecipientResolverService, 'resolve'>;
  notificationWrite: NotificationWritePort;
  channelDelivery: NotificationChannelDeliveryPort;
  /**
   * Optional runtime configuration for flag-driven event-type ownership.
   * When omitted, the engine falls back to the static registry defaults
   * (`legacy_inline` for deadline events). Provided by the
   * `NotificationsRuntimeConfigService` at module wiring time.
   */
  runtimeConfig?: NotificationRuleEngineRuntimeConfig;
  /** Видимость получателей событий закупа (текущая матрица ролей); без неё такие события никому не доставляются. */
  procurementVisibility?: VisibilityPort;
  /** Часы для отсечки устаревших событий (тесты). */
  now?: () => Date;
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
    const effectiveType = resolveEffectiveEventType(event);
    const ownsDeadline = this.deps.runtimeConfig?.isEngineOwnsDeadline() ?? false;
    const ownershipOverride = ownsDeadline && DEADLINE_EVENT_TYPES.has(effectiveType)
      ? 'engine' as const
      : undefined;
    const definition = withOwnerOverride(effectiveType, ownershipOverride) ?? getEventDefinition(effectiveType);
    if (!definition || definition.owner !== 'engine') {
      return { matched: 0, created: 0, skipped: 'not_engine_owned' };
    }

    // Флаг — в момент обработки (§5.7 R5-3): выключен → событие обработано без уведомлений; включение флага не
    // переигрывает такие события. Устаревшие события (реле было выключено) тоже не порождают уведомлений.
    if (definition.featureFlag && this.deps.runtimeConfig?.isFeatureEnabled?.(definition.featureFlag) !== true) {
      return { matched: 0, created: 0, skipped: 'skipped_disabled' };
    }
    if (definition.maxEventAgeHours !== undefined) {
      const createdAt = event.createdAt ? Date.parse(event.createdAt) : Number.NaN;
      const now = this.deps.now?.() ?? new Date();
      if (!Number.isFinite(createdAt) || now.getTime() - createdAt > definition.maxEventAgeHours * 3_600_000) {
        return { matched: 0, created: 0, skipped: 'skipped_stale' };
      }
    }
    const sourceType = definition.sourceType ?? SOURCE_TYPE;

    const ctx = await this.deps.contextBuilder.buildContext(client, event);
    const rules = await this.deps.ruleRepo.listEnabledByEvent(client, effectiveType);
    const groupIds = new Set(ctx.groupIds.map((groupId) => groupId.toLowerCase()));
    const matchingRules = rules.filter((rule) => {
      if (rule.groupId == null) return true;
      return groupIds.has(rule.groupId.toLowerCase());
    });

    let matched = 0;
    let created = 0;

    for (const rule of matchingRules) {
      const { matched: ruleMatched } = evaluateRuleConditions(rule.conditions, ctx);
      if (!ruleMatched) continue;
      // Правило со старым каналом (сохранено до ограничения) не доставляется вне допустимых каналов события.
      const channels = definition.allowedChannels
        ? rule.channels.filter((channel) => definition.allowedChannels!.includes(channel))
        : rule.channels;
      matched += 1;

      const { title, message } = renderNotificationText(rule, ctx);
      const recipientUserIds = definition.recipientVisibility === 'procurement'
        ? (this.deps.procurementVisibility
          ? await this.deps.recipientResolver.resolve(client, rule.recipients, ctx, this.deps.procurementVisibility)
          : [])
        : await this.deps.recipientResolver.resolve(client, rule.recipients, ctx);

      for (const userId of recipientUserIds) {
        for (const channel of channels) {
          const idempotencyKey = buildNotificationDeliveryKey({
            outboxEventId: event.outboxEventId,
            ruleId: rule.notificationRuleId,
            userId,
            channel,
          });

          if (channel === 'in_app') {
            const result = await this.deps.notificationWrite.insertIfAbsent(client, {
              userId,
              level: rule.level,
              title,
              message,
              entityType: 'order',
              entityId: ctx.orderId != null ? String(ctx.orderId) : null,
              sourceType,
              sourceId: rule.notificationRuleId,
              idempotencyKey,
            });
            if (result.created) created += 1;
            continue;
          }

          const result = await this.deps.channelDelivery.enqueueIfAbsent(client, {
            notificationRuleId: rule.notificationRuleId,
            outboxEventId: event.outboxEventId,
            userId,
            channel,
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
    }

    return { matched, created };
  }
}
