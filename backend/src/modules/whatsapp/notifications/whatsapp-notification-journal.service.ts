import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../database/database.service';
import type { PermissionName } from '../../../permissions/permissions';
import { maskContact } from '../../employees/employee-contacts';
import { WhatsAppRuntimeConfigService } from '../whatsapp-runtime-config.service';
import type { WhatsAppNotificationJournalQuery } from './whatsapp-notification-journal.dto';
import { WHATSAPP_NOTIFICATION_LIMITS } from './whatsapp-notification.types';

/**
 * Who may read deliveries of a source in the journal, besides whatsapp.manage: literal membership at read time,
 * as the bell does for the same source. A source missing here is not shown at all — a new consumer adds its line.
 */
export const WHATSAPP_NOTIFICATION_SOURCE_READ_PERMISSIONS: Readonly<Record<string, PermissionName>> = {
  onec_alert: 'onec.view',
};

export interface WhatsAppNotificationJournalViewer {
  permissions: readonly PermissionName[];
}

/** Journal row access for the viewer (alias `d`): a readable source, and the row's required permission if it has one. */
export function journalVisibilitySql(viewer: WhatsAppNotificationJournalViewer, params: unknown[]): string {
  const sources = Object.entries(WHATSAPP_NOTIFICATION_SOURCE_READ_PERMISSIONS)
    .filter(([, permission]) => viewer.permissions.includes(permission)).map(([source]) => source);
  const sourcesIndex = params.push(sources);
  const permissionsIndex = params.push([...viewer.permissions]);
  return `d.source_type = ANY($${sourcesIndex}::text[])
    AND (d.required_permission IS NULL OR d.required_permission = ANY($${permissionsIndex}::text[]))`;
}

/** Totals above this are shown as «больше»: the journal never counts the whole history on a refresh. */
export const JOURNAL_COUNT_CAP = 10_000;

interface JournalRow {
  delivery_id: string;
  created_at: Date;
  updated_at: Date;
  source_type: string;
  source_id: string | null;
  correlation_id: string;
  idempotency_key: string;
  level: string;
  title: string | null;
  body: string | null;
  recipient_kind: 'user' | 'chat';
  recipient_user_id: string | null;
  recipient_username: string | null;
  employee_name: string | null;
  phone_normalized: string | null;
  chat_id: string | null;
  required_permission: string | null;
  state: string;
  reason: string | null;
  attempts: number;
  not_before: Date;
  expires_at: Date;
  sent_at: Date | null;
  finished_at: Date | null;
  purged_at: Date | null;
}

/**
 * The read side of the channel for the «Канал WhatsApp» item of «Уведомления» in «Конфигурация»:
 * the delivery journal and the channel state. Reads only; the phone is shown as a mask, as in the audit.
 */
@Injectable()
export class WhatsAppNotificationJournalService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(WhatsAppRuntimeConfigService) private readonly runtimeConfig: WhatsAppRuntimeConfigService,
  ) {}

  async channel() {
    const config = this.runtimeConfig.getConfig();
    const state = (await this.database.query<{
      epoch: string; epoch_started_at: Date | null; paused: boolean | null;
      queued: string; last_sent_at: Date | null;
    }>(
      `SELECT w.epoch::text epoch, w.epoch_started_at,
              (SELECT c.paused FROM whatsapp_broadcast_control c WHERE c.singleton_id = 1) paused,
              (SELECT count(*)::text FROM whatsapp_notification_deliveries d WHERE d.state IN ('queued', 'sending')) queued,
              (SELECT max(d.sent_at) FROM whatsapp_notification_deliveries d
                WHERE d.state = 'sent' AND d.created_at >= now() - interval '7 days') last_sent_at
         FROM whatsapp_notification_worker_state w WHERE w.singleton`,
    )).rows[0];
    const day = await this.database.query<{ state: string; total: string }>(
      `SELECT state, count(*)::text total FROM whatsapp_notification_deliveries
        WHERE created_at >= now() - interval '24 hours' GROUP BY state`,
    );
    return {
      enabled: config.enabled,
      relayOwner: config.relayOwner,
      deliverable: config.enabled && config.relayOwner === 'in_process',
      paused: state?.paused === true,
      epoch: state ? Number(state.epoch) : null,
      epochStartedAt: state?.epoch_started_at?.toISOString() ?? null,
      queued: Number(state?.queued ?? 0),
      lastSentAt: state?.last_sent_at?.toISOString() ?? null,
      last24h: Object.fromEntries(day.rows.map((row) => [row.state, Number(row.total)])),
      limits: {
        globalGapSeconds: WHATSAPP_NOTIFICATION_LIMITS.globalGapMs / 1000,
        perRecipientHourly: WHATSAPP_NOTIFICATION_LIMITS.perRecipientHourly,
        purgeAfterDays: WHATSAPP_NOTIFICATION_LIMITS.purgeAfterMs / 86_400_000,
      },
    };
  }

  async list(query: WhatsAppNotificationJournalQuery, viewer: WhatsAppNotificationJournalViewer) {
    const params: unknown[] = [];
    const where: string[] = [journalVisibilitySql(viewer, params)];
    const equal = (column: string, value: string | undefined) => {
      if (value === undefined) return;
      params.push(value);
      where.push(`d.${column} = $${params.length}`);
    };
    equal('state', query.state);
    equal('level', query.level);
    equal('recipient_kind', query.recipientKind);
    equal('source_type', query.sourceType);
    if (query.from) {
      params.push(query.from);
      where.push(`d.created_at >= $${params.length}::date`);
    }
    if (query.to) {
      params.push(query.to);
      where.push(`d.created_at < $${params.length}::date + 1`);
    }
    if (query.search) {
      params.push(`%${query.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
      const p = `$${params.length}`;
      where.push(`(d.title ILIKE ${p} OR d.source_id ILIKE ${p} OR d.correlation_id ILIKE ${p}
        OR d.idempotency_key ILIKE ${p} OR d.delivery_id::text ILIKE ${p} OR u.username::text ILIKE ${p} OR e.full_name ILIKE ${p})`);
    }
    const from = `FROM whatsapp_notification_deliveries d
      LEFT JOIN users u ON u.user_id = d.recipient_user_id
      LEFT JOIN employees e ON e.employee_id = d.employee_id
      WHERE ${where.join(' AND ')}`;
    const count = await this.database.query<{ total: string }>(
      `SELECT count(*)::text total FROM (SELECT 1 ${from} LIMIT ${JOURNAL_COUNT_CAP + 1}) capped`, [...params]);
    params.push(query.pageSize, (query.page - 1) * query.pageSize);
    const rows = await this.database.query<JournalRow>(
      `SELECT d.delivery_id, d.created_at, d.updated_at, d.source_type, d.source_id, d.correlation_id, d.idempotency_key,
              d.level, d.title, d.body, d.recipient_kind, d.recipient_user_id::text recipient_user_id,
              u.username::text recipient_username, e.full_name::text employee_name, d.phone_normalized, d.chat_id,
              d.required_permission, d.state, d.reason, d.attempts, d.not_before, d.expires_at, d.sent_at,
              d.finished_at, d.purged_at
         ${from}
        ORDER BY d.created_at DESC, d.delivery_id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      data: rows.rows.map(journalItem),
      pagination: {
        page: query.page, pageSize: query.pageSize,
        total: Math.min(Number(count.rows[0]?.total ?? 0), JOURNAL_COUNT_CAP),
        totalCapped: Number(count.rows[0]?.total ?? 0) > JOURNAL_COUNT_CAP,
      },
    };
  }
}

function journalItem(row: JournalRow) {
  return {
    deliveryId: row.delivery_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    sourceType: row.source_type,
    sourceId: row.source_id,
    correlationId: row.correlation_id,
    idempotencyKey: row.idempotency_key,
    level: row.level,
    title: row.title,
    text: row.body,
    recipient: row.recipient_kind === 'user'
      ? {
          kind: 'user' as const,
          userId: row.recipient_user_id === null ? null : Number(row.recipient_user_id),
          username: row.recipient_username,
          employeeName: row.employee_name,
          phoneMasked: row.phone_normalized ? maskContact('phone', row.phone_normalized) : null,
        }
      : { kind: 'chat' as const, chatId: row.chat_id },
    requiredPermission: row.required_permission,
    state: row.state,
    reason: row.reason,
    attempts: row.attempts,
    notBefore: row.not_before.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    sentAt: row.sent_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    purgedAt: row.purged_at?.toISOString() ?? null,
  };
}
