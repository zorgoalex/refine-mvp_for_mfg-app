import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { z } from 'zod';
import { computeDiff } from '../../../common/audit/audit-diff';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { PgNotificationWriteAdapter } from '../../notifications-engine/adapters/pg-notification-write';
import { ONEC_ALERT_NOTIFICATION_SOURCE } from '../../notifications-engine/domain/notification-event-registry';
import { WHATSAPP_GROUP_ID_PATTERN } from '../../whatsapp/whatsapp-groups';
import { WhatsAppNotificationPort } from '../../whatsapp/notifications/whatsapp-notification.port';
import {
  PgOnecAlertNotificationsRepository,
  type ExternalRecipientRow,
  type OnecAlertExternalChannel,
  type OnecAlertPolicy,
} from '../adapters/pg-onec-alert-notifications-repository';
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

/** WhatsApp personally and to a chat (slice 3); Telegram comes later and cannot be selected until then. */
export const ONEC_ALERT_EXTERNAL_CHANNELS_AVAILABLE: readonly OnecAlertExternalChannel[] = ['whatsapp', 'whatsapp_chat'];

const policySchema = z
  .object({
    importance: z.enum(['auto', 'critical', 'important', 'info']),
    recipientRoleCodes: z.array(z.string().trim().min(1).max(100)).max(50),
    recipientUserIds: z.array(z.number().int().positive()).max(200),
    externalChannels: z.array(z.enum(['telegram', 'whatsapp', 'whatsapp_chat'])).max(3),
    /** Absent — unchanged; null — no chat. Changing it needs whatsapp.manage too (plan §3, R2-9). */
    whatsappChatId: z.string().trim().max(64).nullable().optional(),
    whatsappChatName: z.string().trim().max(200).nullable().optional(),
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
  if (value.whatsappChatId != null && !WHATSAPP_GROUP_ID_PATTERN.test(value.whatsappChatId)) {
    throw new ApiError(422, 'VALIDATION_FAILED', 'Некорректный чат WhatsApp', { issues: [{ path: 'whatsappChatId', message: 'invalid' }] });
  }
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

/** Audit view of a policy: settings only (no texts, no phones; the chat id and name are not secret — plan §2.6). */
function auditView(policy: Omit<PolicyInput, 'whatsappChatId' | 'whatsappChatName'> & Pick<OnecAlertPolicy, 'whatsappChatId' | 'whatsappChatName'>): Record<string, unknown> {
  return {
    importance: policy.importance,
    recipientRoleCodes: policy.recipientRoleCodes,
    recipientUserIds: policy.recipientUserIds,
    externalChannels: policy.externalChannels,
    whatsappChatId: policy.whatsappChatId,
    whatsappChatName: policy.whatsappChatName,
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
  private readonly logger = new Logger(OnecAlertNotificationSettingsService.name);
  private readonly write = new PgNotificationWriteAdapter();

  constructor(
    @Inject(PgOnecAlertNotificationsRepository) private readonly repository: PgOnecAlertNotificationsRepository,
    @Inject(OnecAuditWriter) private readonly audit: OnecAuditWriter,
    @Inject(OnecRuntimeConfigService) private readonly runtime: OnecRuntimeConfigService,
    @Optional() @Inject(WhatsAppNotificationPort) private readonly whatsapp?: WhatsAppNotificationPort,
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
      const noWorkPhone = chosen && policy.externalChannels.includes('whatsapp')
        ? await this.repository.withoutWorkPhone(chosen.users.map((user) => user.userId))
        : [];
      groups.push({
        code: group.code,
        label: group.label,
        windowSeconds: group.windowSeconds,
        kinds: onecAlertKindsOf(group.code).map((kind) => ({ kind, label: onecAlertKindLabel(kind) })),
        policy,
        recipients: chosen ? { fallbackLevel: chosen.level, users: chosen.users.map((user) => ({ id: user.userId, name: user.username })) } : null,
        filteredOut: await this.repository.filteredOutConfigured(policy),
        withoutWorkPhone: chosen ? chosen.users.filter((user) => noWorkPhone.includes(user.userId)).map((user) => ({ id: user.userId, name: user.username })) : [],
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
    const input = parsePolicy(body);
    return this.repository.transaction(async (tx) => {
      const current = await this.repository.lockPolicyForUpdate(tx, code);
      if (!current) throw new ApiError(404, 'ONEC_ALERT_GROUP_NOT_FOUND', 'Группа оповещений 1С не найдена');
      if (current.version !== expected) {
        throw new ApiError(409, 'ONEC_ALERT_POLICY_VERSION_CONFLICT', 'Настройку уже изменили — обновите экран', { current });
      }
      const chatId = input.whatsappChatId === undefined ? current.whatsappChatId : input.whatsappChatId || null;
      const chatName = chatId === null ? null : input.whatsappChatId === undefined || input.whatsappChatId === current.whatsappChatId
        ? input.whatsappChatName === undefined ? current.whatsappChatName : input.whatsappChatName || null
        : input.whatsappChatName || null;
      // The chat is chosen from the WhatsApp groups list, which only whatsapp.manage may read (plan §3, R2-9).
      if (chatId !== current.whatsappChatId && !actor.permissions.includes('whatsapp.manage')) {
        throw new ApiError(403, 'ONEC_ALERT_WHATSAPP_MANAGE_REQUIRED', 'Выбрать чат WhatsApp может только тот, у кого есть право управлять WhatsApp');
      }
      if (input.externalChannels.includes('whatsapp_chat') && chatId === null) {
        throw new ApiError(422, 'ONEC_ALERT_WHATSAPP_CHAT_REQUIRED', 'Для отправки в чат WhatsApp выберите чат', { issues: [{ path: 'whatsappChatId', message: 'required' }] });
      }
      const next = { ...input, whatsappChatId: chatId, whatsappChatName: chatName };
      const roles = await this.repository.existingRoleCodes(tx, next.recipientRoleCodes);
      const missingRoles = next.recipientRoleCodes.filter((role) => !roles.includes(role));
      const users = await this.repository.existingUserIds(tx, next.recipientUserIds);
      const missingUsers = next.recipientUserIds.filter((id) => !users.includes(id));
      if (missingRoles.length > 0 || missingUsers.length > 0) {
        throw new ApiError(422, 'ONEC_ALERT_RECIPIENT_UNKNOWN', 'Неизвестная роль или пользователь', { roles: missingRoles, users: missingUsers });
      }
      await this.repository.updatePolicy(tx, code, next, Number(actor.id));
      const cancelled = await this.cancelDropped(tx, code, current, next);
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
          metadata: { version: { from: current.version, to: current.version + 1 }, correlationId: context.correlationId, whatsappCancelled: cancelled },
        },
        {},
      );
      const updated = (await this.repository.listPolicies(tx)).find((policy) => policy.groupCode === code);
      return { policy: updated };
    });
  }

  /**
   * Unstarted WhatsApp deliveries the policy no longer wants (plan §5): a removed channel, a changed or cleared chat —
   * cancelled in the PATCH transaction, under the policy row FOR UPDATE. Returns how many were cancelled.
   */
  private async cancelDropped(
    tx: Parameters<Parameters<PgOnecAlertNotificationsRepository['transaction']>[0]>[0],
    code: OnecAlertGroupCode,
    before: OnecAlertPolicy,
    after: Pick<OnecAlertPolicy, 'externalChannels' | 'whatsappChatId'>,
  ): Promise<number> {
    const port = this.whatsapp;
    if (!port) return 0;
    const personalDropped = before.externalChannels.includes('whatsapp') && !after.externalChannels.includes('whatsapp');
    const chatDropped = (row: ExternalRecipientRow) =>
      row.chatId !== null && (!after.externalChannels.includes('whatsapp_chat') || row.chatId !== after.whatsappChatId);
    let cancelled = 0;
    for (const row of await this.repository.watchedRowsOfGroup(tx, code)) {
      if (!row.deliveryId || !((row.userId !== null && personalDropped) || chatDropped(row))) continue;
      const result = await port.cancel(tx, { deliveryId: row.deliveryId });
      // A delivery that had already finished stays watched: the dispatcher records its state with the reason.
      if (result?.cancelled) {
        cancelled += 1;
        await this.repository.recordChannelState(tx, row.recipientRowId, 'cancelled', 'cancelled_by_source');
      }
    }
    return cancelled;
  }

  /**
   * «Проверить»: one bell row with the mandatory balloon to the caller, plus the policy's WhatsApp channels — the
   * caller personally and the chat. At most one per minute per caller and group (the key carries the minute).
   */
  async sendTest(group: string, actor: CurrentUser, context: OnecRequestContext) {
    const code = groupCode(group);
    const label = onecAlertGroup(code).label;
    const bucket = Math.floor(Date.now() / TEST_BUCKET_MS);
    return this.repository.transaction(async (tx) => {
      const title = `1С — Проверка оповещения: ${label}`;
      const { created, notificationId } = await this.write.insertIfAbsent(tx, {
        userId: Number(actor.id),
        level: 'info',
        title,
        message: 'Так будут приходить оповещения этой группы: в колокольчик и балуном, который закрывается только крестиком.',
        entityType: ONEC_ALERT_DISPATCH_ENTITY,
        entityId: 'test',
        sourceType: ONEC_ALERT_NOTIFICATION_SOURCE,
        sourceId: null,
        idempotencyKey: `onec_alert_test:${code}:${actor.id}:${bucket}`,
        balloonMode: 'mandatory',
      });
      if (!created) throw new ApiError(429, 'ONEC_ALERT_TEST_RATE_LIMITED', 'Проверку этой группы можно повторить через минуту');
      const policy = (await this.repository.listPolicies(tx)).find((item) => item.groupCode === code);
      const whatsapp: { target: 'self' | 'chat'; state: string; reason: string | null; deliveryId: string | null }[] = [];
      // The channel's own audit and this command's audit share the request's correlation id (R1-3).
      const correlationId = context.correlationId ?? context.requestId;
      if (this.whatsapp && policy) {
        const targets: { target: 'self' | 'chat'; recipient: { userId: number } | { chatId: string } }[] = [];
        if (policy.externalChannels.includes('whatsapp')) targets.push({ target: 'self', recipient: { userId: Number(actor.id) } });
        if (policy.externalChannels.includes('whatsapp_chat') && policy.whatsappChatId) targets.push({ target: 'chat', recipient: { chatId: policy.whatsappChatId } });
        for (const item of targets) {
          await tx.query('SAVEPOINT onec_alert_test_whatsapp');
          try {
            const result = await this.whatsapp.enqueue(tx, {
              idempotencyKey: `onec-alert-test:${code}:${actor.id}:${bucket}:whatsapp:${item.target}`,
              recipient: item.recipient,
              title,
              text: `Так будут приходить оповещения группы «${label}» в WhatsApp${item.target === 'chat' ? ' в этот чат' : ''}.`,
              level: 'info',
              sourceType: ONEC_ALERT_NOTIFICATION_SOURCE,
              sourceId: `test:${code}:${actor.id}:${bucket}`,
              correlationId,
            });
            await tx.query('RELEASE SAVEPOINT onec_alert_test_whatsapp');
            whatsapp.push({ target: item.target, state: result.state, reason: result.reason, deliveryId: result.deliveryId });
          } catch (error) {
            await tx.query('ROLLBACK TO SAVEPOINT onec_alert_test_whatsapp');
            this.logger.error(`1C alert test ${code}: WhatsApp enqueue failed: ${error instanceof Error ? error.message : String(error)}`);
            whatsapp.push({ target: item.target, state: 'skipped', reason: 'ENQUEUE_FAILED', deliveryId: null });
          }
        }
      }
      await this.audit.byUser(
        tx,
        actor,
        context,
        {
          event: 'onec.alert_notification.test_sent',
          entityType: 'onec_alert_notification_policy',
          entityId: code,
          after: { channels: ['in_app', 'balloon', ...whatsapp.map((item) => `whatsapp:${item.target}`)], notificationId, whatsapp },
          relatedUserId: Number(actor.id),
        },
        {},
      );
      // The bell shows 1C alert rows only with the literal onec.view (onec.manage alone implies it only for the API).
      return { notificationId, channels: ['in_app', 'balloon'], visibleInBell: actor.permissions.includes('onec.view'), whatsapp };
    });
  }

  async recent(limit: string | undefined) {
    const n = Number(limit ?? 50);
    const bounded = Number.isInteger(n) && n > 0 ? Math.min(n, 200) : 50;
    const rows = await this.repository.recentDispatches(bounded);
    // Live state of the WhatsApp rows still in flight (final ones carry the state the dispatcher recorded).
    const inFlight = rows.flatMap((row) => row.external).filter((r) => r.channelState === null && r.deliveryId).map((r) => r.deliveryId as string);
    const live = new Map<string, { state: string; reason: string | null }>();
    // The channel answers at most 500 ids per call (R4-1): ask in batches.
    for (let i = 0; this.whatsapp && i < inFlight.length; i += 500) {
      for (const status of await this.whatsapp.statuses(this.repository.db, inFlight.slice(i, i + 500))) live.set(status.deliveryId, status);
    }
    return {
      data: rows.map((row) => ({
        ...row,
        groupLabel: onecAlertGroup(row.groupCode).label,
        kindLabels: row.kinds.map(onecAlertKindLabel),
        external: row.external.map((r) => {
          const status = r.deliveryId ? live.get(r.deliveryId) : undefined;
          return { ...r, state: r.channelState ?? status?.state ?? (r.status === 'skipped' ? 'skipped' : null), reason: r.channelReason ?? status?.reason ?? r.skipReason };
        }),
      })),
    };
  }
}
