import { randomInt, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { CLIENT_PHONE_SQL } from './forms/order-form-data';
import { maskGroup } from './order-send-phone';
import {
  ORDER_FORM_CODES, ORDER_SEND_QUEUE_TTL_MS, ORDER_SEND_RETENTION_MS,
  type OrderFormCode, type OrderSendCancelReason, type OrderSendChat, type OrderSendSettings, type OrderSendSettingsInput,
  type OrderSendState, type OrderSendView,
} from './order-send.types';

const SOURCE = 'erp_whatsapp_order_send';

interface SettingsRow extends QueryResultRow {
  version: number; enabled: boolean; min_interval_minutes: number; send_window_minutes: number; client_forms: string[]; client_caption: string;
  last_delivery_at: Date | null; next_delivery_at: Date | null; updated_at: Date; updated_by: string | null; updated_by_username: string | null;
}
interface ChatRow extends QueryResultRow {
  chat_key: string; group_chat_id: string; label: string; forms: string[]; caption: string; position: number; archived_at: Date | null;
}
export interface SendRow extends QueryResultRow {
  send_id: string; order_id: string; client_id: string | null; actor_id: string; request_id: string; idempotency_key: string; fingerprint: string;
  target_kind: 'client' | 'chat'; chat_key: string | null; form_code: OrderFormCode; destination_chat_id: string | null;
  phone_normalized: string | null; recipient_masked: string; file_key: string | null; sha256: string | null; size_bytes: number | null;
  file_name: string; caption: string | null; state: OrderSendState; error_code: string | null; cancel_reason: OrderSendCancelReason | null;
  attempt_count: number; next_attempt_at: Date; lock_token: string | null; send_started_at: Date | null; provider_message_id: string | null;
  provider_ack: boolean; sent_at: Date | null; queue_expires_at: Date; purged_at: Date | null; created_at: Date; updated_at: Date;
  actor_username?: string | null; chat_label?: string | null;
}

/** Everything the command decided under the locks, handed to the caller to render and store the file. */
export interface EnqueueDecision {
  settings: SettingsRow;
  chat: ChatRow | null;
}

export interface NewSend {
  sendId: string; orderId: number; clientId: number | null; actor: CurrentUser; requestId: string; idempotencyKey: string; fingerprint: string;
  targetKind: 'client' | 'chat'; chatKey: string | null; form: OrderFormCode; destinationChatId: string | null; phoneNormalized: string | null;
  recipientMasked: string; fileKey: string; sha256: string; sizeBytes: number; fileName: string; caption: string;
}

export interface SendIntent { token: string; destinationChatId: string; fileKey: string; sha256: string; fileName: string; caption: string; form: OrderFormCode }

/** Lock order everywhere: whatsapp_broadcast_control → settings → chat → send row → order. */
@Injectable()
export class OrderSendRepository {
  /** Random delay inside the send window, in milliseconds [0, maxExclusive); replaceable in tests. */
  random: (maxExclusive: number) => number = (maxExclusive) => (maxExclusive > 1 ? randomInt(maxExclusive) : 0);

  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** The next delivery may start at last + threshold + a random delay within the window. */
  private nextDeliveryAt(start: Date, intervalMinutes: number, windowMinutes: number): Date {
    return new Date(start.getTime() + intervalMinutes * 60_000 + this.random(windowMinutes * 60_000 + 1));
  }

  // ------------------------------------------------------------------ settings

  async getSettings(client: DatabaseClient = this.database): Promise<OrderSendSettings & { lastDeliveryAt: Date | null }> {
    const settings = await this.settingsRow(client, false);
    const chats = (await client.query<ChatRow>(`SELECT * FROM whatsapp_order_send_chats WHERE archived_at IS NULL ORDER BY position, created_at`)).rows;
    return { ...mapSettings(settings, chats), lastDeliveryAt: settings.last_delivery_at };
  }

  async activeSendExists(): Promise<boolean> {
    return Boolean((await this.database.query<{ active: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM whatsapp_order_sends WHERE state IN ('queued','sending')) active`)).rows[0]?.active);
  }

  async updateSettings(input: OrderSendSettingsInput, actor: CurrentUser, requestId: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      const before = await this.settingsRow(tx, true);
      if (before.version !== input.version) {
        throw new ApiError(409, 'ORDER_SEND_SETTINGS_VERSION_CONFLICT', 'Настройки уже изменены; обновите страницу');
      }
      const existing = (await tx.query<ChatRow>('SELECT * FROM whatsapp_order_send_chats WHERE archived_at IS NULL FOR UPDATE')).rows;
      const byKey = new Map(existing.map((chat) => [chat.chat_key, chat]));
      for (const chat of input.chats) {
        if (chat.chatKey && !byKey.has(chat.chatKey)) throw new ApiError(409, 'ORDER_SEND_SETTINGS_VERSION_CONFLICT', 'Чат уже удалён; обновите страницу');
      }
      // A chat keeps its key only while its group is the same; a changed group gets a new key, so a
      // queued send can never be redirected. Archive first: the group is unique among active chats.
      const kept = new Set(input.chats
        .filter((chat) => chat.chatKey && byKey.get(chat.chatKey)?.group_chat_id === chat.groupChatId)
        .map((chat) => chat.chatKey as string));
      const archived = existing.filter((chat) => !kept.has(chat.chat_key)).map((chat) => chat.chat_key);
      for (const chatKey of archived) await tx.query('UPDATE whatsapp_order_send_chats SET archived_at = now() WHERE chat_key = $1', [chatKey]);
      for (const [position, chat] of input.chats.entries()) {
        if (chat.chatKey && kept.has(chat.chatKey)) {
          await tx.query(`UPDATE whatsapp_order_send_chats SET label = $2, forms = $3, caption = $4, position = $5 WHERE chat_key = $1`,
            [chat.chatKey, chat.label, chat.forms, chat.caption, position]);
        } else {
          await tx.query(`INSERT INTO whatsapp_order_send_chats (chat_key, group_chat_id, label, forms, caption, position, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7)`, [randomUUID(), chat.groupChatId, chat.label, chat.forms, chat.caption, position, numericId(actor.id)]);
        }
      }
      const cancelled: Array<{ sendId: string; reason: OrderSendCancelReason }> = [];
      if (archived.length) cancelled.push(...await this.cancelQueued(tx, `chat_key = ANY($1::uuid[])`, [archived], 'recipient_removed', requestId));
      if (!input.enabled) cancelled.push(...await this.cancelQueued(tx, 'true', [], 'disabled', requestId));
      // A changed threshold or window redraws the pending random delay from the last delivery.
      const timingChanged = before.min_interval_minutes !== input.minIntervalMinutes || before.send_window_minutes !== input.sendWindowMinutes;
      const nextDelivery = timingChanged && before.last_delivery_at
        ? this.nextDeliveryAt(before.last_delivery_at, input.minIntervalMinutes, input.sendWindowMinutes) : before.next_delivery_at;
      await tx.query(`UPDATE whatsapp_order_send_settings SET version = version + 1, enabled = $1, min_interval_minutes = $2, client_forms = $3,
        client_caption = $4, send_window_minutes = $6, next_delivery_at = $7, updated_at = now(), updated_by = $5 WHERE singleton`,
      [input.enabled, input.minIntervalMinutes, input.clientForms, input.clientCaption, numericId(actor.id), input.sendWindowMinutes, nextDelivery]);
      if (timingChanged) {
        // A send already waiting on the old gate is woken for a fresh check and keeps its queue life
        // until the new planned moment + the queue TTL.
        const allowed = deliveryAllowedAt({ last_delivery_at: before.last_delivery_at, min_interval_minutes: input.minIntervalMinutes,
          next_delivery_at: nextDelivery });
        await tx.query(`UPDATE whatsapp_order_sends SET next_attempt_at = now(),
            queue_expires_at = GREATEST(queue_expires_at, $1::timestamptz), updated_at = now() WHERE state = 'queued'`,
        [new Date(Math.max(Date.now(), allowed?.getTime() ?? 0) + ORDER_SEND_QUEUE_TTL_MS)]);
      }
      const after = await this.getSettings(tx);
      await auditService.record(tx, {
        event: 'whatsapp.order_send_settings.updated', entityType: 'whatsapp_order_send_settings', entityId: 'singleton',
        actorUserId: numericId(actor.id), actorUsername: actor.username, actorRole: actor.role, requestId, source: SOURCE,
        before: settingsAudit(mapSettings(before, existing)), after: settingsAudit(after),
        metadata: { archivedChats: archived.length, cancelledSends: cancelled.length },
      });
    }).catch((error: unknown) => {
      if (isUniqueViolation(error, 'idx_whatsapp_order_send_chats_group_active')) {
        throw new ApiError(409, 'ORDER_SEND_SETTINGS_VERSION_CONFLICT', 'Эта группа уже есть в списке чатов');
      }
      throw error;
    });
  }

  // ------------------------------------------------------------------ command

  /** Replay lookup: the stored send of this actor and key, if any. */
  async findCommand(client: DatabaseClient, actorId: string, idempotencyKey: string): Promise<SendRow | null> {
    return (await client.query<SendRow>('SELECT * FROM whatsapp_order_sends WHERE actor_id = $1 AND idempotency_key = $2',
      [numericId(actorId), idempotencyKey])).rows[0] ?? null;
  }

  /**
   * Runs the command transaction: control → settings (serializes every card send) → ledger again →
   * enabled / ACTIVE / COOLDOWN → chat. `prepare` then reads the order, checks access, renders and
   * stores the file and returns the row to insert, all inside the same transaction.
   */
  async enqueue(params: {
    actorId: string; idempotencyKey: string; fingerprint: string; chatKey: string | null;
    /** Same order, recipient and form: the latest such send must not be unknown unless confirmed by its id. */
    orderId?: number; form?: OrderFormCode; confirmAfterUnknown?: string | null;
    prepare: (tx: TransactionClient, decision: EnqueueDecision) => Promise<NewSend>;
  }): Promise<{ row: SendRow; replayed: boolean }> {
    return this.database.transaction(async (tx) => {
      const control = (await tx.query<{ paused: boolean }>('SELECT paused FROM whatsapp_broadcast_control WHERE singleton_id = 1 FOR SHARE')).rows[0];
      const settings = await this.settingsRow(tx, true);
      const committed = await this.findCommand(tx, params.actorId, params.idempotencyKey);
      if (committed) return { row: assertSameCommand(committed, params.fingerprint), replayed: true };
      if (control?.paused) throw new ApiError(409, 'ORDER_SEND_PAUSED', 'Все рассылки остановлены («Остановить все рассылки»)');
      if (!settings.enabled) throw new ApiError(409, 'ORDER_SEND_DISABLED', 'Отправка заказа из карточки выключена в настройках');
      const active = (await tx.query<{ active: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM whatsapp_order_sends WHERE state IN ('queued','sending')) active`)).rows[0]?.active;
      if (active) throw new ApiError(409, 'ORDER_SEND_ACTIVE', 'Предыдущая отправка из карточки ещё выполняется; повторите чуть позже');
      const allowedAt = nextAllowed(settings);
      if (allowedAt && allowedAt.getTime() > Date.now()) {
        throw new ApiError(409, 'ORDER_SEND_COOLDOWN', 'Отправка из карточек ограничена порогом частоты',
          { nextAllowedAt: allowedAt.toISOString(), minIntervalMinutes: settings.min_interval_minutes });
      }
      if (params.orderId !== undefined && params.form !== undefined) {
        // Under the settings lock every card command is serialized, so this check cannot race.
        const previous = (await tx.query<{ send_id: string; state: string; created_at: Date }>(`SELECT send_id, state, created_at
          FROM whatsapp_order_sends WHERE order_id = $1 AND form_code = $2 AND target_kind = $3 AND chat_key IS NOT DISTINCT FROM $4
          ORDER BY created_at DESC LIMIT 1`, [params.orderId, params.form, params.chatKey ? 'chat' : 'client', params.chatKey])).rows[0];
        if (previous?.state === 'unknown' && params.confirmAfterUnknown !== previous.send_id) {
          throw new ApiError(409, 'ORDER_SEND_PREVIOUS_UNKNOWN', 'Результат прежней отправки этой формы неизвестен: проверьте чат и подтвердите повтор',
            { sendId: previous.send_id, createdAt: previous.created_at.toISOString() });
        }
      }
      let chat: ChatRow | null = null;
      if (params.chatKey) {
        chat = (await tx.query<ChatRow>('SELECT * FROM whatsapp_order_send_chats WHERE chat_key = $1 FOR SHARE', [params.chatKey])).rows[0] ?? null;
        if (!chat || chat.archived_at) throw new ApiError(409, 'ORDER_SEND_CHAT_UNKNOWN', 'Этого чата больше нет в настройках; обновите страницу');
      }
      const send = await params.prepare(tx, { settings, chat });
      const row = (await tx.query<SendRow>(`INSERT INTO whatsapp_order_sends (send_id, order_id, client_id, actor_id, request_id, idempotency_key,
          fingerprint, target_kind, chat_key, form_code, destination_chat_id, phone_normalized, recipient_masked, file_key, sha256, size_bytes,
          file_name, caption, queue_expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`, [
        send.sendId, send.orderId, send.clientId, numericId(send.actor.id), send.requestId, send.idempotencyKey, send.fingerprint, send.targetKind,
        send.chatKey, send.form, send.destinationChatId, send.phoneNormalized, send.recipientMasked, send.fileKey, send.sha256, send.sizeBytes,
        send.fileName, send.caption, queueExpiresAt(settings),
      ])).rows[0];
      await this.audit(tx, row, 'requested', send.actor, { from: null, to: 'queued' });
      return { row, replayed: false };
    });
  }

  // ------------------------------------------------------------------ worker

  async nextQueued(now = new Date()): Promise<SendRow | null> {
    return (await this.database.query<SendRow>(`SELECT * FROM whatsapp_order_sends WHERE state = 'queued' AND next_attempt_at <= $1
      ORDER BY created_at LIMIT 1`, [now])).rows[0] ?? null;
  }

  async setClientDestination(sendId: string, chatId: string): Promise<boolean> {
    const updated = await this.database.query(`UPDATE whatsapp_order_sends SET destination_chat_id = $2, updated_at = now()
      WHERE send_id = $1 AND state = 'queued' AND target_kind = 'client' AND destination_chat_id IS NULL`, [sendId, chatId]);
    return (updated.rowCount ?? 0) > 0;
  }

  async postpone(sendId: string, until: Date, errorCode: string): Promise<void> {
    await this.database.query(`UPDATE whatsapp_order_sends SET next_attempt_at = $2, error_code = $3, updated_at = now()
      WHERE send_id = $1 AND state = 'queued'`, [sendId, until, errorCode]);
  }

  /** Terminal outcome decided before any delivery attempt (no threshold slot is used). */
  async finishBeforeIntent(sendId: string, outcome: { state: 'failed'; errorCode: string } | { state: 'cancelled'; reason: OrderSendCancelReason }
    | { state: 'expired' }, now = new Date()): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const row = (await tx.query<SendRow>('SELECT * FROM whatsapp_order_sends WHERE send_id = $1 FOR UPDATE', [sendId])).rows[0];
      if (!row || row.state !== 'queued') return false;
      // The candidate was chosen without a lock: a settings change may have extended its life since.
      if (outcome.state === 'expired' && row.queue_expires_at.getTime() > now.getTime()) return false;
      return this.finishQueued(tx, row, outcome);
    });
  }

  /**
   * Last checks and the delivery gate under the settings lock. `verify` re-checks the actor's rights
   * and the recipient against the current data; a mismatch cancels instead of redirecting. Returns
   * null when the send must wait (threshold) or was closed.
   */
  async createIntent(sendId: string, verify: (tx: TransactionClient, row: SendRow, settings: SettingsRow) => Promise<OrderSendCancelReason | null>,
    clock: () => Date = () => new Date()): Promise<SendIntent | null> {
    return this.database.transaction(async (tx) => {
      const control = (await tx.query<{ paused: boolean }>('SELECT paused FROM whatsapp_broadcast_control WHERE singleton_id = 1 FOR SHARE')).rows[0];
      const settings = await this.settingsRow(tx, true);
      const row = (await tx.query<SendRow>('SELECT * FROM whatsapp_order_sends WHERE send_id = $1 FOR UPDATE', [sendId])).rows[0];
      const now = clock();
      if (!row || row.state !== 'queued' || row.next_attempt_at.getTime() > now.getTime()) return null;
      if (row.queue_expires_at.getTime() <= now.getTime()) { await this.finishQueued(tx, row, { state: 'expired' }); return null; }
      if (control?.paused) return null;
      if (!settings.enabled) { await this.finishQueued(tx, row, { state: 'cancelled', reason: 'disabled' }); return null; }
      const reason = await verify(tx, row, settings);
      if (reason) { await this.finishQueued(tx, row, { state: 'cancelled', reason }); return null; }
      // The verification may have waited on authorization locks: decide TTL and the gate on fresh time.
      const decidedAt = clock();
      if (row.queue_expires_at.getTime() <= decidedAt.getTime()) { await this.finishQueued(tx, row, { state: 'expired' }); return null; }
      if (!row.destination_chat_id || !row.file_key || !row.sha256) {
        await this.finishQueued(tx, row, { state: 'failed', errorCode: 'ORDER_SEND_PAYLOAD_MISSING' });
        return null;
      }
      const allowedAt = deliveryAllowedAt(settings);
      if (allowedAt && allowedAt.getTime() > decidedAt.getTime()) {
        await tx.query('UPDATE whatsapp_order_sends SET next_attempt_at = $2, updated_at = now() WHERE send_id = $1', [sendId, allowedAt]);
        return null;
      }
      // The slot is spent at the start of the attempt and never returned (an unknown outcome may have been delivered).
      await tx.query('UPDATE whatsapp_order_send_settings SET last_delivery_at = $1, next_delivery_at = $2 WHERE singleton',
        [decidedAt, this.nextDeliveryAt(decidedAt, settings.min_interval_minutes, settings.send_window_minutes)]);
      const token = randomUUID();
      const updated = (await tx.query<SendRow>(`UPDATE whatsapp_order_sends SET state = 'sending', attempt_count = 1, lock_token = $2,
          send_started_at = $3, error_code = NULL, updated_at = now() WHERE send_id = $1 RETURNING *`, [sendId, token, decidedAt])).rows[0];
      await this.audit(tx, updated, 'intent', null, { from: 'queued', to: 'sending' });
      return { token, destinationChatId: row.destination_chat_id, fileKey: row.file_key, sha256: row.sha256, fileName: row.file_name,
        caption: row.caption ?? '', form: row.form_code };
    });
  }

  /** Conditional settle (fencing token); the audit row is written in the same transaction. */
  async settle(sendId: string, token: string, result: { state: 'sent'; providerMessageId: string } | { state: 'failed' | 'unknown'; errorCode: string }) {
    return this.database.transaction(async (tx) => {
      const row = (await tx.query<SendRow>(`UPDATE whatsapp_order_sends SET state = $3, lock_token = NULL,
          provider_message_id = $4, provider_ack = $5, sent_at = CASE WHEN $3 = 'sent' THEN now() ELSE NULL END, error_code = $6, updated_at = now()
        WHERE send_id = $1 AND lock_token = $2 AND state = 'sending' RETURNING *`, [
        sendId, token, result.state, result.state === 'sent' ? result.providerMessageId : null, result.state === 'sent',
        result.state === 'sent' ? null : result.errorCode,
      ])).rows[0];
      if (!row) return false;
      await this.audit(tx, row, result.state, null, { from: 'sending', to: result.state, errorCode: row.error_code });
      return true;
    });
  }

  /** A process lost after the intent: the outcome is unknown and the send is never repeated. */
  async markStaleIntentsUnknown(staleAfterMs: number, now = new Date()): Promise<number> {
    const stale = (await this.database.query<{ send_id: string }>(`SELECT send_id FROM whatsapp_order_sends
      WHERE state = 'sending' AND send_started_at < $1 LIMIT 50`, [new Date(now.getTime() - staleAfterMs)])).rows;
    let count = 0;
    for (const item of stale) {
      await this.database.transaction(async (tx) => {
        const row = (await tx.query<SendRow>(`UPDATE whatsapp_order_sends SET state = 'unknown', lock_token = NULL,
            error_code = 'PROCESS_LOST_AFTER_INTENT', updated_at = now()
          WHERE send_id = $1 AND state = 'sending' AND send_started_at < $2 RETURNING *`, [item.send_id, new Date(now.getTime() - staleAfterMs)])).rows[0];
        if (!row) return;
        count += 1;
        await this.audit(tx, row, 'unknown', null, { from: 'sending', to: 'unknown', errorCode: row.error_code });
      });
    }
    return count;
  }

  /**
   * Retention: queued rows past their TTL expire; terminal rows older than 7 days lose the file,
   * the recipient (group id, phone) and the provider id. Returns every file key still referenced.
   */
  async expireAndPurge(now = new Date()): Promise<{ referenced: Set<string>; purgedKeys: string[] }> {
    const expired = (await this.database.query<{ send_id: string }>(`SELECT send_id FROM whatsapp_order_sends
      WHERE state = 'queued' AND queue_expires_at <= $1 LIMIT 100`, [now])).rows;
    for (const item of expired) await this.finishBeforeIntent(item.send_id, { state: 'expired' }, now);
    const purgedKeys = (await this.database.query<{ file_key: string | null }>(`
      WITH purged AS (
        SELECT send_id, file_key FROM whatsapp_order_sends
        WHERE purged_at IS NULL AND state NOT IN ('queued','sending') AND created_at < $1
        ORDER BY created_at LIMIT 500 FOR UPDATE SKIP LOCKED
      )
      UPDATE whatsapp_order_sends s SET file_key = NULL, sha256 = NULL, size_bytes = NULL, destination_chat_id = NULL, phone_normalized = NULL,
        provider_message_id = NULL, purged_at = now(), updated_at = now()
      FROM purged WHERE s.send_id = purged.send_id
      RETURNING purged.file_key`, [new Date(now.getTime() - ORDER_SEND_RETENTION_MS)])).rows
      .map((row) => row.file_key).filter((key): key is string => key !== null);
    // Pages 2..N of image forms (a newer release, migration 231): purged together with their send, the
    // provider id (it may carry the phone) included. Without the table nothing changes.
    const withParts = await this.partsTableExists();
    const purgedParts = withParts ? (await this.database.query<{ file_key: string | null }>(`
      WITH purged AS (
        SELECT p.send_id, p.part_no, p.file_key FROM whatsapp_order_send_parts p JOIN whatsapp_order_sends s ON s.send_id = p.send_id
        WHERE p.purged_at IS NULL AND s.purged_at IS NOT NULL LIMIT 2000 FOR UPDATE OF p SKIP LOCKED
      )
      UPDATE whatsapp_order_send_parts p SET file_key = NULL, sha256 = NULL, size_bytes = NULL, provider_message_id = NULL, purged_at = now()
      FROM purged WHERE p.send_id = purged.send_id AND p.part_no = purged.part_no
      RETURNING purged.file_key`)).rows.map((row) => row.file_key).filter((key): key is string => key !== null) : [];
    const referenced = new Set((await this.database.query<{ file_key: string }>(withParts
      ? `SELECT file_key FROM whatsapp_order_sends WHERE file_key IS NOT NULL
         UNION SELECT file_key FROM whatsapp_order_send_parts WHERE file_key IS NOT NULL`
      : 'SELECT file_key FROM whatsapp_order_sends WHERE file_key IS NOT NULL')).rows.map((row) => row.file_key));
    return { referenced, purgedKeys: [...purgedKeys, ...purgedParts] };
  }

  private async partsTableExists(): Promise<boolean> {
    return Boolean((await this.database.query<{ ok: boolean }>(`SELECT to_regclass('whatsapp_order_send_parts') IS NOT NULL ok`)).rows[0]?.ok);
  }

  // ------------------------------------------------------------------ reads

  /** Whether any row still points at a file; an error counts as «referenced» (keep the file for the sweep). */
  async fileReferenced(fileKey: string): Promise<boolean> {
    const sql = (await this.partsTableExists())
      ? `SELECT EXISTS (SELECT 1 FROM whatsapp_order_sends WHERE file_key = $1)
          OR EXISTS (SELECT 1 FROM whatsapp_order_send_parts WHERE file_key = $1) referenced`
      : 'SELECT EXISTS (SELECT 1 FROM whatsapp_order_sends WHERE file_key = $1) referenced';
    return Boolean((await this.database.query<{ referenced: boolean }>(sql, [fileKey])).rows[0]?.referenced);
  }

  async getSend(sendId: string): Promise<SendRow | null> {
    return (await this.database.query<SendRow>(`${sendSelect()} WHERE s.send_id = $1`, [sendId])).rows[0] ?? null;
  }

  async listForOrder(orderId: number, limit: number): Promise<SendRow[]> {
    return (await this.database.query<SendRow>(`${sendSelect()} WHERE s.order_id = $1 ORDER BY s.created_at DESC LIMIT $2`, [orderId, limit])).rows;
  }

  /**
   * The current client and selected phone of an order, locked until the caller commits: the order
   * FOR SHARE, the client FOR UPDATE (an INSERT into client_phones needs FOR KEY SHARE on it through
   * the FK, so a new — possibly primary — phone waits) and the existing phones FOR SHARE.
   */
  async currentClientPhone(tx: DatabaseClient, orderId: number): Promise<{ clientId: number | null; phone: string | null } | null> {
    const order = (await tx.query<{ client_id: string | null }>(`SELECT client_id FROM orders
      WHERE order_id = $1 AND delete_flag = false AND deleted_at IS NULL FOR SHARE`, [orderId])).rows[0];
    if (!order) return null;
    if (order.client_id === null) return { clientId: null, phone: null };
    await tx.query('SELECT 1 FROM clients WHERE client_id = $1 FOR UPDATE', [order.client_id]);
    await tx.query('SELECT 1 FROM client_phones WHERE client_id = $1 FOR SHARE', [order.client_id]);
    const phone = (await tx.query<{ client_phone: string | null }>(CLIENT_PHONE_SQL, [order.client_id])).rows[0]?.client_phone ?? null;
    return { clientId: Number(order.client_id), phone };
  }

  async chat(tx: DatabaseClient, chatKey: string): Promise<ChatRow | null> {
    return (await tx.query<ChatRow>('SELECT * FROM whatsapp_order_send_chats WHERE chat_key = $1 FOR SHARE', [chatKey])).rows[0] ?? null;
  }

  // ------------------------------------------------------------------ helpers

  private async settingsRow(client: DatabaseClient, forUpdate: boolean): Promise<SettingsRow> {
    const row = (await client.query<SettingsRow>(`SELECT s.*, u.username updated_by_username FROM whatsapp_order_send_settings s
      LEFT JOIN users u ON u.user_id = s.updated_by WHERE s.singleton ${forUpdate ? 'FOR UPDATE OF s' : ''}`)).rows[0];
    if (!row) throw new ApiError(503, 'ORDER_SEND_UNAVAILABLE', 'Отправка заказа из карточки недоступна');
    return row;
  }

  private async cancelQueued(tx: TransactionClient, where: string, params: unknown[], reason: OrderSendCancelReason, requestId: string) {
    const rows = (await tx.query<SendRow>(`SELECT * FROM whatsapp_order_sends WHERE state = 'queued' AND ${where} FOR UPDATE`, params)).rows;
    for (const row of rows) await this.finishQueued(tx, row, { state: 'cancelled', reason }, requestId);
    return rows.map((row) => ({ sendId: row.send_id, reason }));
  }

  private async finishQueued(tx: TransactionClient, row: SendRow,
    outcome: { state: 'failed'; errorCode: string } | { state: 'cancelled'; reason: OrderSendCancelReason } | { state: 'expired' }, requestId?: string) {
    const updated = (await tx.query<SendRow>(`UPDATE whatsapp_order_sends SET state = $2, cancel_reason = $3, error_code = $4, updated_at = now()
      WHERE send_id = $1 AND state = 'queued' RETURNING *`, [
      row.send_id, outcome.state, outcome.state === 'cancelled' ? outcome.reason : null, outcome.state === 'failed' ? outcome.errorCode : null,
    ])).rows[0];
    if (!updated) return false;
    await this.audit(tx, updated, outcome.state, null, {
      from: 'queued', to: outcome.state,
      ...(outcome.state === 'cancelled' ? { cancelReason: outcome.reason } : {}),
      ...(outcome.state === 'failed' ? { errorCode: outcome.errorCode } : {}),
    }, requestId);
    return true;
  }

  /** Audit of one send: no phone, chat id, caption or file content — only masks and codes. */
  private async audit(tx: TransactionClient, row: SendRow, action: string, actor: CurrentUser | null, transition: Record<string, unknown>,
    requestId?: string) {
    await auditService.record(tx, {
      event: `whatsapp.order_send.${action}`, entityType: 'whatsapp_order_send', entityId: row.send_id,
      actorUserId: actor ? numericId(actor.id) : Number(row.actor_id), actorUsername: actor?.username ?? null, actorRole: actor?.role ?? null,
      requestId: requestId ?? row.request_id, source: SOURCE,
      relatedOrderId: Number(row.order_id), relatedClientId: row.client_id === null ? null : Number(row.client_id),
      statusField: 'order_send_state', statusCode: row.state,
      metadata: {
        sendId: row.send_id, targetKind: row.target_kind, chatKey: row.chat_key, recipientMasked: row.recipient_masked, form: row.form_code,
        source: 'order_card', ...transition,
      },
    });
  }
}

function sendSelect() {
  return `SELECT s.*, u.username actor_username, c.label chat_label FROM whatsapp_order_sends s
    LEFT JOIN users u ON u.user_id = s.actor_id LEFT JOIN whatsapp_order_send_chats c ON c.chat_key = s.chat_key`;
}

/**
 * Queue life of a new send: TTL counted from the moment it may be delivered (inside a long window the
 * send waits for the drawn moment; it must not expire before it).
 */
export function queueExpiresAt(settings: Pick<SettingsRow, 'last_delivery_at' | 'min_interval_minutes' | 'next_delivery_at'>, now = Date.now()): Date {
  const allowed = deliveryAllowedAt(settings);
  return new Date(Math.max(now, allowed?.getTime() ?? 0) + ORDER_SEND_QUEUE_TTL_MS);
}

/** End of the threshold: the command refuses with COOLDOWN before it. */
export function nextAllowed(settings: Pick<SettingsRow, 'last_delivery_at' | 'min_interval_minutes'>): Date | null {
  if (!settings.last_delivery_at) return null;
  return new Date(settings.last_delivery_at.getTime() + settings.min_interval_minutes * 60_000);
}

/** The delivery gate: the threshold plus the random delay drawn at the last delivery (whichever is later). */
export function deliveryAllowedAt(settings: Pick<SettingsRow, 'last_delivery_at' | 'min_interval_minutes' | 'next_delivery_at'>): Date | null {
  const threshold = nextAllowed(settings);
  if (!threshold) return null;
  return settings.next_delivery_at && settings.next_delivery_at.getTime() > threshold.getTime() ? settings.next_delivery_at : threshold;
}

function assertSameCommand(row: SendRow, fingerprint: string): SendRow {
  if (row.fingerprint !== fingerprint) {
    throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Ключ запроса уже использован для другой отправки');
  }
  return row;
}

function mapSettings(row: SettingsRow, chats: ChatRow[]): OrderSendSettings {
  return {
    version: row.version,
    enabled: row.enabled,
    minIntervalMinutes: row.min_interval_minutes,
    sendWindowMinutes: row.send_window_minutes,
    clientForms: knownForms(row.client_forms),
    clientCaption: row.client_caption,
    chats: chats.filter((chat) => !chat.archived_at).map((chat): OrderSendChat => ({
      chatKey: chat.chat_key, groupChatId: chat.group_chat_id, label: chat.label, forms: knownForms(chat.forms), caption: chat.caption,
    })),
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by ? { id: String(row.updated_by), username: row.updated_by_username } : null,
  };
}

/** Settings in the audit: groups only as masks. */
function settingsAudit(settings: OrderSendSettings) {
  return {
    enabled: settings.enabled, minIntervalMinutes: settings.minIntervalMinutes, sendWindowMinutes: settings.sendWindowMinutes,
    clientForms: settings.clientForms,
    clientCaptionLength: settings.clientCaption.length,
    chats: settings.chats.map((chat) => ({ chatKey: chat.chatKey, group: maskGroup(chat.groupChatId), label: chat.label, forms: chat.forms })),
  };
}

export function knownForms(list: readonly string[]): OrderFormCode[] {
  return list.filter((code): code is OrderFormCode => (ORDER_FORM_CODES as readonly string[]).includes(code));
}

export function numericId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия');
  return id;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const record = error as { code?: string; constraint?: string } | null;
  return record?.code === '23505' && record.constraint === constraint;
}
