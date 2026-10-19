import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { computeDiff } from '../../../common/audit/audit-diff';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { PgNotificationWriteAdapter } from '../../notifications-engine/adapters/pg-notification-write';
import { ONEC_ALERT_NOTIFICATION_SOURCE } from '../../notifications-engine/domain/notification-event-registry';
import { PgOnecAlertNotificationsRepository, type OnecAlertPolicy } from '../adapters/pg-onec-alert-notifications-repository';
import {
  ONEC_ALERT_GROUPS,
  isOnecAlertGroupCode,
  isValidQuietHours,
  onecAlertGroup,
  onecAlertKindLabel,
  onecAlertKindsOf,
  type OnecAlertGroupCode,
} from '../domain/onec-alert-groups';
import { OnecRuntimeConfigService } from '../onec-runtime-config.service';
import { ONEC_ALERT_DISPATCH_ENTITY, chooseRecipients } from './onec-alert-notifier';
import { OnecAuditWriter, type OnecRequestContext } from './onec-audit';

/** External channels arrive with later slices (Telegram — 2, WhatsApp — 3); until then a policy cannot select them. */
export const ONEC_ALERT_EXTERNAL_CHANNELS_AVAILABLE: readonly ('telegram' | 'whatsapp')[] = [];

const policySchema = z
  .object({
    importance: z.enum(['auto', 'critical', 'important', 'info']),
    recipientRoleCodes: z.array(z.string().trim().min(1).max(100)).max(50),
    recipientUserIds: z.array(z.number().int().positive()).max(200),
    externalChannels: z.array(z.enum(['telegram', 'whatsapp'])).max(2),
    delayMinutes: z.number().int().min(0).max(120),
    repeatMinutes: z.number().int().min(30).max(1440).nullable(),
    notifyResolved: z.boolean(),
    quietHours: z.string().max(11).nullable(),
    criticalIgnoresQuietHours: z.boolean(),
  })
  .strict();
type PolicyInput = z.infer<typeof policySchema>;

function parsePolicy(body: unknown): PolicyInput {
  // The bell and the mandatory balloon cannot be switched off (plan §2.7): any attempt is a validation error.
  if (body && typeof body === 'object' && ('inApp' in body || 'balloon' in body || 'channels' in body)) {
    throw new ApiError(422, 'ONEC_ALERT_MANDATORY_CHANNELS', 'Колокольчик и балун оповещений 1С отключить нельзя');
  }
  const parsed = policySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_FAILED', 'Некорректные данные', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
    });
  }
  const value = parsed.data;
  if (value.quietHours !== null && !isValidQuietHours(value.quietHours)) {
    throw new ApiError(422, 'VALIDATION_FAILED', 'Тихие часы — в виде ЧЧ:ММ-ЧЧ:ММ, начало не равно концу', { issues: [{ path: 'quietHours', message: 'invalid' }] });
  }
  const unavailable = value.externalChannels.filter((channel) => !ONEC_ALERT_EXTERNAL_CHANNELS_AVAILABLE.includes(channel));
  if (unavailable.length > 0) {
    throw new ApiError(422, 'ONEC_ALERT_CHANNEL_UNAVAILABLE', 'Этот канал для оповещений 1С пока недоступен', { channels: unavailable });
  }
  return {
    ...value,
    recipientRoleCodes: [...new Set(value.recipientRoleCodes)].sort(),
    recipientUserIds: [...new Set(value.recipientUserIds)].sort((a, b) => a - b),
    externalChannels: [...new Set(value.externalChannels)].sort(),
  };
}

function parseVersion(ifMatch: string | undefined): number {
  const text = (ifMatch ?? '').replace(/^W\//, '').replace(/"/g, '').trim();
  if (!/^[0-9]{1,9}$/.test(text)) throw new ApiError(428, 'IF_MATCH_REQUIRED', 'Нужен заголовок If-Match с версией настройки');
  return Number(text);
}

function groupCode(value: string): OnecAlertGroupCode {
  if (!isOnecAlertGroupCode(value)) throw new ApiError(404, 'ONEC_ALERT_GROUP_NOT_FOUND', 'Группа оповещений 1С не найдена');
  return value;
}

/** Audit view of a policy: settings only (no texts, no phones). */
function auditView(policy: Pick<OnecAlertPolicy, keyof PolicyInput>): Record<string, unknown> {
  return {
    importance: policy.importance,
    recipientRoleCodes: policy.recipientRoleCodes,
    recipientUserIds: policy.recipientUserIds,
    externalChannels: policy.externalChannels,
    delayMinutes: policy.delayMinutes,
    repeatMinutes: policy.repeatMinutes,
    notifyResolved: policy.notifyResolved,
    quietHours: policy.quietHours,
    criticalIgnoresQuietHours: policy.criticalIgnoresQuietHours,
  };
}

const TEST_BUCKET_MS = 60_000;

/**
 * «Конфигурация → Оповещения 1С» (plan §3, §4): view — onec.view, change and «Проверить» — onec.manage (the
 * controller's guard checks the literal permission). Changes go under the policy row FOR UPDATE with an optimistic
 * version (If-Match) and are audited in the same transaction.
 */
@Injectable()
export class OnecAlertNotificationSettingsService {
  private readonly write = new PgNotificationWriteAdapter();

  constructor(
    @Inject(PgOnecAlertNotificationsRepository) private readonly repository: PgOnecAlertNotificationsRepository,
    @Inject(OnecAuditWriter) private readonly audit: OnecAuditWriter,
    @Inject(OnecRuntimeConfigService) private readonly runtime: OnecRuntimeConfigService,
  ) {}

  async overview() {
    const config = this.runtime.get();
    const [state, policies, options] = await Promise.all([
      this.repository.readState(),
      this.repository.listPolicies(),
      this.repository.recipientOptions(),
    ]);
    const byGroup = new Map(policies.map((policy) => [policy.groupCode, policy] as const));
    const groups = [];
    for (const group of ONEC_ALERT_GROUPS) {
      const policy = byGroup.get(group.code);
      if (!policy) continue;
      const chosen = chooseRecipients(await this.repository.previewRecipientCandidates(policy));
      groups.push({
        code: group.code,
        label: group.label,
        windowSeconds: group.windowSeconds,
        kinds: onecAlertKindsOf(group.code).map((kind) => ({ kind, label: onecAlertKindLabel(kind) })),
        policy,
        recipients: chosen ? { fallbackLevel: chosen.level, users: chosen.users.map((user) => ({ id: user.userId, name: user.username })) } : null,
        filteredOut: await this.repository.filteredOutConfigured(policy),
      });
    }
    return {
      flagEnabled: config.alertNotifications === true,
      monitorOwner: config.monitorOwner,
      active: state.active,
      enabledAt: state.enabledAt?.toISOString() ?? null,
      lastTickAt: state.lastTickAt?.toISOString() ?? null,
      lastTickError: state.lastTickError,
      mandatoryChannels: ['in_app', 'balloon'],
      externalChannelsAvailable: ONEC_ALERT_EXTERNAL_CHANNELS_AVAILABLE,
      groups,
      recipientOptions: options,
    };
  }

  async updatePolicy(group: string, ifMatch: string | undefined, body: unknown, actor: CurrentUser, context: OnecRequestContext) {
    const code = groupCode(group);
    const expected = parseVersion(ifMatch);
    const next = parsePolicy(body);
    return this.repository.transaction(async (tx) => {
      const current = await this.repository.lockPolicyForUpdate(tx, code);
      if (!current) throw new ApiError(404, 'ONEC_ALERT_GROUP_NOT_FOUND', 'Группа оповещений 1С не найдена');
      if (current.version !== expected) {
        throw new ApiError(409, 'ONEC_ALERT_POLICY_VERSION_CONFLICT', 'Настройку уже изменили — обновите экран', { current });
      }
      const roles = await this.repository.existingRoleCodes(tx, next.recipientRoleCodes);
      const missingRoles = next.recipientRoleCodes.filter((role) => !roles.includes(role));
      const users = await this.repository.existingUserIds(tx, next.recipientUserIds);
      const missingUsers = next.recipientUserIds.filter((id) => !users.includes(id));
      if (missingRoles.length > 0 || missingUsers.length > 0) {
        throw new ApiError(422, 'ONEC_ALERT_RECIPIENT_UNKNOWN', 'Неизвестная роль или пользователь', { roles: missingRoles, users: missingUsers });
      }
      await this.repository.updatePolicy(tx, code, next, Number(actor.id));
      const before = auditView(current);
      const after = auditView(next);
      await this.audit.byUser(
        tx,
        actor,
        context,
        {
          event: 'onec.alert_notification_policy.updated',
          entityType: 'onec_alert_notification_policy',
          entityId: code,
          before,
          after,
          diff: computeDiff(before, after),
          metadata: { version: { from: current.version, to: current.version + 1 }, correlationId: context.correlationId },
        },
        {},
      );
      const updated = (await this.repository.listPolicies(tx)).find((policy) => policy.groupCode === code);
      return { policy: updated };
    });
  }

  /**
   * «Проверить»: one bell row with the mandatory balloon to the caller (in-app + balloon; external channels with
   * their slices). At most one per minute per caller and group (the key carries the minute).
   */
  async sendTest(group: string, actor: CurrentUser, context: OnecRequestContext) {
    const code = groupCode(group);
    const label = onecAlertGroup(code).label;
    const bucket = Math.floor(Date.now() / TEST_BUCKET_MS);
    return this.repository.transaction(async (tx) => {
      const { created, notificationId } = await this.write.insertIfAbsent(tx, {
        userId: Number(actor.id),
        level: 'info',
        title: `1С — Проверка оповещения: ${label}`,
        message: 'Так будут приходить оповещения этой группы: в колокольчик и балуном, который закрывается только крестиком.',
        entityType: ONEC_ALERT_DISPATCH_ENTITY,
        entityId: 'test',
        sourceType: ONEC_ALERT_NOTIFICATION_SOURCE,
        sourceId: null,
        idempotencyKey: `onec_alert_test:${code}:${actor.id}:${bucket}`,
        balloonMode: 'mandatory',
      });
      if (!created) throw new ApiError(429, 'ONEC_ALERT_TEST_RATE_LIMITED', 'Проверку этой группы можно повторить через минуту');
      await this.audit.byUser(
        tx,
        actor,
        context,
        {
          event: 'onec.alert_notification.test_sent',
          entityType: 'onec_alert_notification_policy',
          entityId: code,
          after: { channels: ['in_app', 'balloon'], notificationId },
          relatedUserId: Number(actor.id),
        },
        {},
      );
      // The bell shows 1C alert rows only with the literal onec.view (onec.manage alone implies it only for the API).
      return { notificationId, channels: ['in_app', 'balloon'], visibleInBell: actor.permissions.includes('onec.view') };
    });
  }

  async recent(limit: string | undefined) {
    const n = Number(limit ?? 50);
    const bounded = Number.isInteger(n) && n > 0 ? Math.min(n, 200) : 50;
    const rows = await this.repository.recentDispatches(bounded);
    return {
      data: rows.map((row) => ({
        ...row,
        groupLabel: onecAlertGroup(row.groupCode).label,
        kindLabels: row.kinds.map(onecAlertKindLabel),
      })),
    };
  }
}
