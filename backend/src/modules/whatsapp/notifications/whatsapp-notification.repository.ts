import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import { PERMISSIONS, type PermissionName } from '../../../permissions/permissions';
import { loadEvaluationUsersWith } from '../../../permissions/user-authorization-snapshot';
import { maskContact } from '../../employees/employee-contacts';
import { WHATSAPP_GROUP_ID_PATTERN } from '../whatsapp-groups';
import {
  WHATSAPP_NOTIFICATION_LIMITS as LIMITS, WHATSAPP_NOTIFICATION_SOURCE_ENTITY_TYPES,
  type WhatsAppNotificationRequest, type WhatsAppNotificationResult, type WhatsAppNotificationState, type WhatsAppNotificationStatus,
} from './whatsapp-notification.types';

const AUDIT_SOURCE = 'whatsapp_notifications';
const KEY_RE = /^[\x21-\x7e]{1,200}$/;
const SOURCE_TYPE_RE = /^[a-z][a-z0-9_]{1,40}$/;

export interface DeliveryRow {
  delivery_id: string; idempotency_key: string; request_hash: string; source_type: string; source_id: string | null;
  correlation_id: string; recipient_kind: 'user' | 'chat'; recipient_user_id: string | null; employee_id: string | null;
  employee_contact_id: string | null; phone_normalized: string | null; chat_id: string | null; destination_chat_id: string | null;
  required_permission: string | null; title: string | null; body: string | null; level: 'info' | 'warning' | 'error';
  delivery_epoch: string; not_before: Date; expires_at: Date; next_attempt_at: Date; state: WhatsAppNotificationState;
  reason: string | null; attempts: number; intent_token: string | null; intent_at: Date | null; provider_message_id: string | null;
  sent_at: Date | null; finished_at: Date | null; purged_at: Date | null; created_at: Date; updated_at: Date;
}

/** Where a user recipient is reached now, or why not. */
export type UserRecipient =
  | { ok: true; employeeId: number; contactId: number; phone: string }
  | { ok: false; reason: 'USER_INACTIVE' | 'PERMISSION_MISSING' | 'NO_WORK_PHONE' };

export interface DeliveryIntent { deliveryId: string; token: string; destinationChatId: string; body: string }

export type CancelRef = { deliveryId: string } | { idempotencyKey: string };

/**
 * The WhatsApp notification deliveries. Lock order of every operation (plan R4):
 * worker_state → (permissions_state → users → snapshot → employees → work contacts) → delivery rows.
 * The epoch change takes worker_state FOR UPDATE, then delivery rows; everything else takes it FOR SHARE first.
 */
@Injectable()
export class WhatsAppNotificationRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  // ------------------------------------------------------------------ consumer side (caller's transaction)

  async enqueue(tx: DatabaseClient, request: WhatsAppNotificationRequest, deliverable: boolean, now: Date): Promise<WhatsAppNotificationResult> {
    const input = normalize(request, now);
    const epoch = await this.epochShare(tx);
    // A repeat answers from the stored row before any check of the time window (it may have passed long ago).
    const existing = await this.byKey(tx, input.idempotencyKey);
    if (existing) return replay(existing, input.requestHash);
    if (input.windowError) throw new ApiError(422, 'WHATSAPP_NOTIFICATION_INVALID', input.windowError);
    let skip: string | null = deliverable ? null : 'WHATSAPP_DISABLED';
    let recipient: UserRecipient | null = null;
    if (!skip && input.userId !== null) {
      recipient = await this.userRecipient(tx, input.userId, input.requiredPermission);
      if (!recipient.ok) skip = recipient.reason;
    }
    const deliveryId = randomUUID();
    const correlationId = input.correlationId ?? `whatsapp-notification:${deliveryId}`;
    const reached = recipient?.ok ? recipient : null;
    // ON CONFLICT: a concurrent transaction with the same key commits first — its row answers.
    const inserted = (await tx.query<DeliveryRow>(`INSERT INTO whatsapp_notification_deliveries (delivery_id, idempotency_key, request_hash,
        source_type, source_id, correlation_id, recipient_kind, recipient_user_id, employee_id, employee_contact_id, phone_normalized, chat_id,
        required_permission, title, body, level, delivery_epoch, not_before, expires_at, next_attempt_at, state, reason, finished_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $18, $20, $21,
        CASE WHEN $20 = 'skipped' THEN $22::timestamptz END, $22, $22)
      ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [deliveryId, input.idempotencyKey, input.requestHash, input.sourceType, input.sourceId, correlationId,
      input.userId !== null ? 'user' : 'chat', input.userId, reached?.employeeId ?? null, reached?.contactId ?? null, reached?.phone ?? null,
      input.chatId, input.requiredPermission, input.title, input.body, input.level, epoch, input.notBefore, input.expiresAt,
      skip ? 'skipped' : 'queued', skip, now])).rows[0];
    if (!inserted) {
      const winner = await this.byKey(tx, input.idempotencyKey);
      if (!winner) throw new ApiError(409, 'WHATSAPP_NOTIFICATION_KEY_REUSED', 'Ключ уведомления занят');
      return replay(winner, input.requestHash);
    }
    await this.audit(tx, inserted, 'whatsapp.notification.queued', { skipped: skip !== null });
    return { deliveryId: inserted.delivery_id, created: true, state: inserted.state, reason: inserted.reason };
  }

  async cancel(tx: DatabaseClient, ref: CancelRef, now: Date): Promise<{ deliveryId: string; state: WhatsAppNotificationState; cancelled: boolean } | null> {
    await this.epochShare(tx);
    const row = 'deliveryId' in ref
      ? (await tx.query<DeliveryRow>('SELECT * FROM whatsapp_notification_deliveries WHERE delivery_id = $1 FOR UPDATE', [uuidOrNull(ref.deliveryId)])).rows[0]
      : (await tx.query<DeliveryRow>('SELECT * FROM whatsapp_notification_deliveries WHERE idempotency_key = $1 FOR UPDATE', [ref.idempotencyKey])).rows[0];
    if (!row) return null;
    if (row.state !== 'queued') return { deliveryId: row.delivery_id, state: row.state, cancelled: false };
    const done = await this.finish(tx, row, 'cancelled', 'cancelled_by_source', now);
    return { deliveryId: done.delivery_id, state: done.state, cancelled: true };
  }

  async statuses(client: DatabaseClient, deliveryIds: readonly string[]): Promise<WhatsAppNotificationStatus[]> {
    const ids = [...new Set(deliveryIds.map(uuidOrNull).filter((id): id is string => id !== null))];
    if (ids.length > LIMITS.statusesMax) throw new ApiError(422, 'VALIDATION_ERROR', `Не больше ${LIMITS.statusesMax} уведомлений за раз`);
    if (!ids.length) return [];
    const rows = (await client.query<Pick<DeliveryRow, 'delivery_id' | 'state' | 'reason' | 'sent_at' | 'updated_at'>>(
      'SELECT delivery_id, state, reason, sent_at, updated_at FROM whatsapp_notification_deliveries WHERE delivery_id = ANY($1::uuid[])', [ids])).rows;
    return rows.map((row) => ({ deliveryId: row.delivery_id, state: row.state, reason: row.reason,
      sentAt: row.sent_at ? row.sent_at.toISOString() : null, updatedAt: row.updated_at.toISOString() }));
  }

  // ------------------------------------------------------------------ worker side

  /**
   * A new delivery epoch of this process: one bounded statement (startup never waits long). What earlier epochs
   * left queued is cancelled by `cancelEarlierEpochs` in batches and, at the latest, by the intent.
   */
  async startEpoch(now: Date): Promise<number> {
    return this.database.transaction(async (tx) => {
      await tx.query("SET LOCAL lock_timeout = '5s'");
      await tx.query("SET LOCAL statement_timeout = '5s'");
      const epoch = Number((await tx.query<{ epoch: string }>(`UPDATE whatsapp_notification_worker_state SET epoch = epoch + 1, epoch_started_at = $1
        WHERE singleton RETURNING epoch`, [now])).rows[0]?.epoch ?? NaN);
      if (!Number.isFinite(epoch)) throw new ApiError(500, 'WHATSAPP_NOTIFICATION_STATE_MISSING', 'Нет строки состояния уведомлений');
      return epoch;
    });
  }

  /** Whether `epoch` is still the current one (a newer process has not started). */
  async isCurrentEpoch(epoch: number): Promise<boolean> {
    return Number((await this.database.query<{ epoch: string }>('SELECT epoch FROM whatsapp_notification_worker_state WHERE singleton')).rows[0]?.epoch) === epoch;
  }

  /** Queued deliveries of earlier epochs → `cancelled/delivery_gap`, one bounded batch; only by the current epoch. */
  async cancelEarlierEpochs(currentEpoch: number, now: Date): Promise<number> {
    return this.database.transaction(async (tx) => {
      if ((await this.epochShare(tx)) !== currentEpoch) return 0;
      const rows = (await tx.query<DeliveryRow>(`SELECT * FROM whatsapp_notification_deliveries WHERE state = 'queued' AND delivery_epoch < $1
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 100`, [currentEpoch])).rows;
      for (const row of rows) await this.finish(tx, row, 'cancelled', 'delivery_gap', now);
      return rows.length;
    });
  }

  /** `sending` older than the stale lock: the outcome is unknown and never repeated. */
  async markStaleUnknown(staleMs: number, now: Date): Promise<number> {
    return this.database.transaction(async (tx) => {
      await this.epochShare(tx);
      const rows = (await tx.query<DeliveryRow>(`SELECT * FROM whatsapp_notification_deliveries WHERE state = 'sending' AND intent_at < $1
        ORDER BY intent_at FOR UPDATE SKIP LOCKED LIMIT 50`, [new Date(now.getTime() - staleMs)])).rows;
      for (const row of rows) await this.finish(tx, row, 'unknown', 'INTENT_STALE', now);
      return rows.length;
    });
  }

  /**
   * Queued deliveries past their lifetime are finished whatever their priority, the pause or a later attempt
   * time (the consumer sees `cancelled/expired`, not an endless `queued`).
   */
  async expireDue(now: Date): Promise<number> {
    return this.database.transaction(async (tx) => {
      await this.epochShare(tx);
      const rows = (await tx.query<DeliveryRow>(`SELECT * FROM whatsapp_notification_deliveries WHERE state = 'queued' AND expires_at <= $1
        ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT 100`, [now])).rows;
      for (const row of rows) await this.finish(tx, row, 'cancelled', 'expired', now);
      return rows.length;
    });
  }

  /** «Остановить все рассылки» (a plain read: the intent re-reads it under its lock). */
  async paused(): Promise<boolean> {
    return Boolean((await this.database.query<{ paused: boolean }>('SELECT paused FROM whatsapp_broadcast_control WHERE singleton_id = 1')).rows[0]?.paused);
  }

  /** The next delivery due now (error first), or null. Read without locks; the intent re-checks under locks. */
  async nextDue(now: Date, currentEpoch: number): Promise<DeliveryRow | null> {
    // Only rows of the current epoch: older ones are cancelled (`delivery_gap`), never decided by a WAHA preflight.
    return (await this.database.query<DeliveryRow>(`SELECT * FROM whatsapp_notification_deliveries
      WHERE state = 'queued' AND delivery_epoch = $2 AND not_before <= $1 AND next_attempt_at <= $1
      ORDER BY CASE level WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at LIMIT 1`, [now, currentEpoch])).rows[0] ?? null;
  }

  /** A terminal outcome decided before any message went out (expired, not on WhatsApp, group gone). */
  async finishBeforeIntent(deliveryId: string, currentEpoch: number, state: 'failed' | 'cancelled', reason: string, now: Date): Promise<void> {
    await this.database.transaction(async (tx) => {
      // A process of an earlier epoch decides nothing (its WAHA view may be stale): the current one will.
      if ((await this.epochShare(tx)) !== currentEpoch) return;
      const row = (await tx.query<DeliveryRow>(`SELECT * FROM whatsapp_notification_deliveries WHERE delivery_id = $1 AND state = 'queued' FOR UPDATE`,
        [deliveryId])).rows[0];
      if (!row) return;
      // A row of an earlier epoch is a delivery gap, never a final failure of this recipient.
      if (Number(row.delivery_epoch) !== currentEpoch) await this.finish(tx, row, 'cancelled', 'delivery_gap', now);
      else await this.finish(tx, row, state, reason, now);
    });
  }

  /** WAHA did not answer before anything was sent: try again later (until the delivery expires). */
  async postpone(deliveryId: string, currentEpoch: number, until: Date, reason: string): Promise<void> {
    await this.database.query(`UPDATE whatsapp_notification_deliveries SET next_attempt_at = $2, reason = $3, updated_at = now()
      WHERE delivery_id = $1 AND state = 'queued' AND $4 = (SELECT epoch FROM whatsapp_notification_worker_state WHERE singleton)`,
    [deliveryId, until, reason, currentEpoch]);
  }

  async setDestination(deliveryId: string, currentEpoch: number, destinationChatId: string): Promise<void> {
    await this.database.query(`UPDATE whatsapp_notification_deliveries SET destination_chat_id = $2, updated_at = now()
      WHERE delivery_id = $1 AND state = 'queued' AND $3 = (SELECT epoch FROM whatsapp_notification_worker_state WHERE singleton)`,
    [deliveryId, destinationChatId, currentEpoch]);
  }

  /**
   * The last checks and the frequency gate under the locks, then `sending` with a fresh token. Returns null when
   * the delivery is no longer due (finished here, or postponed by the gate). `currentEpoch` is this process's.
   */
  async createIntent(deliveryId: string, currentEpoch: number, now: () => Date): Promise<DeliveryIntent | null> {
    return this.database.transaction(async (tx) => {
      const epoch = await this.epochShare(tx);
      // «Остановить все рассылки» stops notifications too: they wait (their lifetime still runs).
      const isPaused = Boolean((await tx.query<{ paused: boolean }>('SELECT paused FROM whatsapp_broadcast_control WHERE singleton_id = 1 FOR SHARE')).rows[0]?.paused);
      const row = (await tx.query<DeliveryRow>(`SELECT * FROM whatsapp_notification_deliveries WHERE delivery_id = $1 AND state = 'queued' FOR UPDATE`,
        [deliveryId])).rows[0];
      if (!row) return null;
      // A newer process has started its epoch: this one stops without touching the row (the newer one delivers it).
      if (epoch !== currentEpoch) return null;
      // A row of an earlier epoch (a late commit of a consumer transaction): never delivered across epochs.
      if (Number(row.delivery_epoch) !== epoch) {
        await this.finish(tx, row, 'cancelled', 'delivery_gap', now());
        return null;
      }
      if (row.expires_at.getTime() <= now().getTime()) {
        await this.finish(tx, row, 'cancelled', 'expired', now());
        return null;
      }
      if (isPaused || row.not_before.getTime() > now().getTime()) return null;
      if (row.recipient_kind === 'user') {
        const recipient = await this.userRecipient(tx, Number(row.recipient_user_id), row.required_permission as PermissionName | null);
        if (!recipient.ok) {
          await this.finish(tx, row, 'cancelled', recipient.reason === 'PERMISSION_MISSING' ? 'permission_revoked' : 'recipient_removed', now());
          return null;
        }
        if (String(recipient.contactId) !== String(row.employee_contact_id) || recipient.phone !== row.phone_normalized
          || String(recipient.employeeId) !== String(row.employee_id)) {
          await this.finish(tx, row, 'cancelled', 'recipient_changed', now());
          return null;
        }
      }
      if (!row.destination_chat_id) return null;
      // Fresh time after every wait on the recipient's locks: the lifetime may have run out meanwhile.
      const at = now();
      if (row.expires_at.getTime() <= at.getTime()) {
        await this.finish(tx, row, 'cancelled', 'expired', at);
        return null;
      }
      const gate = await this.gate(tx, row, at);
      if (gate) {
        await tx.query(`UPDATE whatsapp_notification_deliveries SET next_attempt_at = $2, updated_at = now() WHERE delivery_id = $1`, [deliveryId, gate]);
        return null;
      }
      const token = randomUUID();
      await tx.query(`UPDATE whatsapp_notification_deliveries SET state = 'sending', intent_token = $2, intent_at = $3, attempts = attempts + 1,
        reason = NULL, updated_at = $3 WHERE delivery_id = $1`, [deliveryId, token, at]);
      return { deliveryId, token, destinationChatId: row.destination_chat_id, body: row.body ?? '' };
    });
  }

  /** The outcome of a sent intent, only by its own token (a stale or repeated settle changes nothing). */
  async settle(deliveryId: string, token: string, outcome: { state: 'sent' | 'failed' | 'unknown'; reason?: string; providerMessageId?: string }, now: Date): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      await this.epochShare(tx);
      const row = (await tx.query<DeliveryRow>(`SELECT * FROM whatsapp_notification_deliveries WHERE delivery_id = $1 AND state = 'sending'
        AND intent_token = $2 FOR UPDATE`, [deliveryId, token])).rows[0];
      if (!row) return false;
      await this.finish(tx, row, outcome.state, outcome.reason ?? null, now, outcome.providerMessageId ?? null);
      return true;
    });
  }

  /** Body and address of deliveries finished long ago are cleared; the compact row stays (the key keeps answering). */
  async purge(now: Date): Promise<number> {
    const result = await this.database.query(`UPDATE whatsapp_notification_deliveries SET title = NULL, body = NULL, phone_normalized = NULL,
        destination_chat_id = NULL, chat_id = NULL, provider_message_id = NULL, purged_at = $1, updated_at = $1
      WHERE delivery_id IN (SELECT delivery_id FROM whatsapp_notification_deliveries
        WHERE purged_at IS NULL AND finished_at IS NOT NULL AND finished_at < $2 ORDER BY finished_at LIMIT 500)`,
    [now, new Date(now.getTime() - LIMITS.purgeAfterMs)]);
    return result.rowCount ?? 0;
  }

  // ------------------------------------------------------------------ internals

  private async epochShare(tx: DatabaseClient): Promise<number> {
    const row = (await tx.query<{ epoch: string }>('SELECT epoch FROM whatsapp_notification_worker_state WHERE singleton FOR SHARE')).rows[0];
    if (!row) throw new ApiError(500, 'WHATSAPP_NOTIFICATION_STATE_MISSING', 'Нет строки состояния уведомлений');
    return Number(row.epoch);
  }

  private async byKey(client: DatabaseClient, key: string): Promise<DeliveryRow | null> {
    return (await client.query<DeliveryRow>('SELECT * FROM whatsapp_notification_deliveries WHERE idempotency_key = $1', [key])).rows[0] ?? null;
  }

  /**
   * The user as he is now, in the order of OrderSendActors.load: authorization version and the user row share-locked
   * (a revocation or deactivation waits for this transaction), rights from the one snapshot, then the employee and
   * the primary work phone, both share-locked (the contacts command waits).
   */
  private async userRecipient(tx: DatabaseClient, userId: number, permission: PermissionName | null): Promise<UserRecipient> {
    await tx.query('SELECT version FROM permissions_state WHERE id = true FOR SHARE');
    const user = (await tx.query<{ user_id: string; employee_id: string | null }>(`SELECT u.user_id, u.employee_id FROM users u
      JOIN roles r ON r.role_id = u.role_id WHERE u.user_id = $1 AND u.is_active AND r.is_active FOR SHARE OF u`, [userId])).rows[0];
    if (!user) return { ok: false, reason: 'USER_INACTIVE' };
    const evaluated = (await loadEvaluationUsersWith(tx, [userId], { requireActiveRole: true })).get(String(user.user_id));
    if (!evaluated) return { ok: false, reason: 'USER_INACTIVE' };
    if (permission && !evaluated.permissions.includes(permission)) return { ok: false, reason: 'PERMISSION_MISSING' };
    if (user.employee_id === null) return { ok: false, reason: 'NO_WORK_PHONE' };
    const employee = (await tx.query<{ is_active: boolean | null }>('SELECT is_active FROM employees WHERE employee_id = $1 FOR SHARE',
      [user.employee_id])).rows[0];
    if (!employee || employee.is_active === false) return { ok: false, reason: 'NO_WORK_PHONE' };
    const phone = (await tx.query<{ contact_id: string; value_normalized: string }>(`SELECT contact_id, value_normalized FROM employee_work_contacts
      WHERE employee_id = $1 AND kind = 'phone' ORDER BY is_primary DESC, position, contact_id LIMIT 1 FOR SHARE`, [user.employee_id])).rows[0];
    if (!phone) return { ok: false, reason: 'NO_WORK_PHONE' };
    return { ok: true, employeeId: Number(user.employee_id), contactId: Number(phone.contact_id), phone: phone.value_normalized };
  }

  /** The frequency gate: when the delivery may go, or null when it may go now. */
  private async gate(tx: TransactionClient, row: DeliveryRow, at: Date): Promise<Date | null> {
    const last = (await tx.query<{ at: Date | null }>(`SELECT max(intent_at) AS at FROM whatsapp_notification_deliveries WHERE intent_at IS NOT NULL`)).rows[0]?.at;
    if (last && at.getTime() - last.getTime() < LIMITS.globalGapMs) return new Date(last.getTime() + LIMITS.globalGapMs);
    const hourAgo = new Date(at.getTime() - 60 * 60_000);
    const recent = (await tx.query<{ intent_at: Date }>(row.recipient_kind === 'user'
      ? `SELECT intent_at FROM whatsapp_notification_deliveries WHERE recipient_user_id = $1 AND intent_at > $2 ORDER BY intent_at`
      : `SELECT intent_at FROM whatsapp_notification_deliveries WHERE chat_id = $1 AND intent_at > $2 ORDER BY intent_at`,
    [row.recipient_kind === 'user' ? row.recipient_user_id : row.chat_id, hourAgo])).rows;
    if (recent.length >= LIMITS.perRecipientHourly) {
      return new Date(recent[recent.length - LIMITS.perRecipientHourly].intent_at.getTime() + 60 * 60_000 + 1);
    }
    return null;
  }

  private async finish(tx: DatabaseClient, row: DeliveryRow, state: WhatsAppNotificationState, reason: string | null, now: Date,
    providerMessageId: string | null = null): Promise<DeliveryRow> {
    const done = (await tx.query<DeliveryRow>(`UPDATE whatsapp_notification_deliveries SET state = $2, reason = $3, finished_at = $4, updated_at = $4,
        sent_at = CASE WHEN $2 = 'sent' THEN $4::timestamptz ELSE sent_at END, provider_message_id = COALESCE($5, provider_message_id)
      WHERE delivery_id = $1 RETURNING *`, [row.delivery_id, state, reason, now, providerMessageId])).rows[0];
    await this.audit(tx, done, `whatsapp.notification.${state}`, {});
    return done;
  }

  /** Audit without values: the recipient as a mask or a number, the body by length and hash. */
  private async audit(tx: DatabaseClient, row: DeliveryRow, event: string, extra: Record<string, unknown>): Promise<void> {
    const sourceNumeric = row.source_id !== null && /^\d{1,15}$/.test(row.source_id) ? Number(row.source_id) : null;
    const sourceEntityType = WHATSAPP_NOTIFICATION_SOURCE_ENTITY_TYPES[row.source_type];
    await auditService.record(tx, {
      event, entityType: 'whatsapp_notification', entityId: row.delivery_id,
      actorUserId: null, actorUsername: null, actorRole: null, requestId: row.correlation_id, source: AUDIT_SOURCE,
      relatedUserId: row.recipient_user_id === null ? null : Number(row.recipient_user_id),
      relatedEntities: sourceNumeric === null || !sourceEntityType ? [] : [{ entityType: sourceEntityType, entityId: sourceNumeric }],
      after: { state: row.state, reason: row.reason },
      metadata: {
        ...extra, correlationId: row.correlation_id, sourceType: row.source_type, sourceId: row.source_id, recipientKind: row.recipient_kind,
        phoneMasked: row.phone_normalized ? maskContact('phone', row.phone_normalized) : null, level: row.level, attempts: row.attempts,
        bodyLength: row.body?.length ?? null, bodySha256: row.body ? sha256(row.body) : null, deliveryEpoch: Number(row.delivery_epoch),
      },
    });
  }
}

interface NormalizedRequest {
  idempotencyKey: string; requestHash: string; userId: number | null; chatId: string | null; title: string | null; body: string;
  level: 'info' | 'warning' | 'error'; sourceType: string; sourceId: string | null; correlationId: string | null; notBefore: Date;
  expiresAt: Date; windowError: string | null; requiredPermission: PermissionName | null;
}

/** Validates the request; the hash covers only what the caller gave (defaults depend on the time of the call). */
export function normalize(request: WhatsAppNotificationRequest, now: Date): NormalizedRequest {
  const invalid = (message: string) => new ApiError(422, 'WHATSAPP_NOTIFICATION_INVALID', message);
  const key = typeof request.idempotencyKey === 'string' ? request.idempotencyKey : '';
  if (!KEY_RE.test(key)) throw invalid('Некорректный ключ уведомления');
  if (!SOURCE_TYPE_RE.test(String(request.sourceType ?? ''))) throw invalid('Некорректный источник уведомления');
  if (!['info', 'warning', 'error'].includes(request.level)) throw invalid('Некорректный уровень уведомления');
  const recipient = request.recipient as { userId?: unknown; chatId?: unknown } | null;
  const userId = recipient && 'userId' in recipient ? Number(recipient.userId) : null;
  const chatId = recipient && 'chatId' in recipient ? String(recipient.chatId ?? '') : null;
  if ((userId === null) === (chatId === null)) throw invalid('Нужен ровно один получатель: пользователь или группа');
  if (userId !== null && !(Number.isSafeInteger(userId) && userId > 0)) throw invalid('Некорректный пользователь-получатель');
  if (chatId !== null && !WHATSAPP_GROUP_ID_PATTERN.test(chatId)) throw invalid('Некорректная группа WhatsApp');
  const permission = request.requiredPermission ?? null;
  if (permission !== null && !(PERMISSIONS as readonly string[]).includes(permission)) throw invalid('Неизвестное право получателя');
  if (permission !== null && chatId !== null) throw invalid('Право проверяется только у пользователя-получателя');
  const title = request.title == null ? null : String(request.title).trim() || null;
  if (title !== null && title.length > LIMITS.titleMax) throw invalid('Слишком длинный заголовок уведомления');
  const text = String(request.text ?? '').trim();
  if (!text) throw invalid('Пустой текст уведомления');
  const body = title ? `*${title}*\n\n${text}` : text;
  if (body.length > LIMITS.bodyMax) throw new ApiError(422, 'WHATSAPP_NOTIFICATION_TOO_LONG', `Уведомление длиннее ${LIMITS.bodyMax} символов`);
  const sourceId = request.sourceId == null ? null : String(request.sourceId);
  if (sourceId !== null && (sourceId.length < 1 || sourceId.length > 200)) throw invalid('Некорректный идентификатор источника');
  const correlationId = request.correlationId == null ? null : String(request.correlationId);
  if (correlationId !== null && (correlationId.length < 1 || correlationId.length > 200)) throw invalid('Некорректный correlationId');
  const date = (value: Date | null | undefined, name: string) => {
    if (value == null) return null;
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw invalid(`Некорректное время ${name}`);
    return value;
  };
  const givenNotBefore = date(request.notBefore, 'notBefore');
  const givenExpiresAt = date(request.expiresAt, 'expiresAt');
  const notBefore = givenNotBefore ?? now;
  const expiresAt = givenExpiresAt ?? new Date(notBefore.getTime() + LIMITS.defaultLifetimeMs);
  // Checked only for a new delivery: a repeat of a stored key is answered whatever the time is now.
  const windowError = expiresAt.getTime() <= notBefore.getTime() ? 'Срок уведомления раньше начала'
    : expiresAt.getTime() > now.getTime() + LIMITS.maxLifetimeMs ? 'Срок уведомления больше 7 дней' : null;
  const requestHash = sha256(JSON.stringify({
    userId, chatId, title, text, level: request.level, sourceType: request.sourceType, sourceId, permission,
    notBefore: givenNotBefore?.toISOString() ?? null, expiresAt: givenExpiresAt?.toISOString() ?? null,
  }));
  return { idempotencyKey: key, requestHash, userId, chatId, title, body, level: request.level, sourceType: request.sourceType, sourceId,
    correlationId, notBefore, expiresAt, windowError, requiredPermission: permission as PermissionName | null };
}

function replay(row: DeliveryRow, requestHash: string): WhatsAppNotificationResult {
  if (row.request_hash !== requestHash) {
    throw new ApiError(409, 'WHATSAPP_NOTIFICATION_KEY_REUSED', 'Ключ уведомления уже использован для другого сообщения');
  }
  return { deliveryId: row.delivery_id, created: false, state: row.state, reason: row.reason };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function uuidOrNull(value: string): string | null {
  const id = String(value ?? '').toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? id : null;
}
