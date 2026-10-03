import { createHash, randomInt, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { CLIENT_PHONE_SQL } from './forms/order-form-data';
import { maskGroup, maskPhone } from './order-send-phone';
import { deliveryAllowedAt, estimateQueue, nextAllowed, type QueueEstimate } from './order-send-queue';
import {
  ORDER_FORM_CODES, ORDER_SEND_QUEUE_MAX, ORDER_SEND_QUEUE_MAX_PER_ACTOR, ORDER_SEND_QUEUE_TTL_MS, ORDER_SEND_RETENTION_MS,
  ORDER_SEND_SETTINGS_PERMISSIONS, ORDER_SEND_SUPPORTED_CHANNELS,
  type OrderFormCode, type OrderSendCancelReason, type OrderSendChannel, type OrderSendChat, type OrderSendEmployeeRecipient,
  type OrderSendSettings, type OrderSendSettingsInput,
  type OrderSendState, type OrderSendView,
} from './order-send.types';

const SOURCE = 'erp_whatsapp_order_send';

interface SettingsRow extends QueryResultRow {
  version: number; enabled: boolean; min_interval_minutes: number; send_window_minutes: number; client_forms: string[]; client_caption: string;
  last_delivery_at: Date | null; next_delivery_at: Date | null; updated_at: Date; updated_by: string | null; updated_by_username: string | null;
  identity_salt: string;
}
export interface EmployeeRecipientRow extends QueryResultRow {
  recipient_key: string; employee_id: string; channel: OrderSendChannel; forms: string[]; caption: string; position: number;
  archived_at: Date | null; employee_name?: string | null;
}
interface ChatRow extends QueryResultRow {
  chat_key: string; group_chat_id: string; label: string; forms: string[]; caption: string; position: number; archived_at: Date | null;
}
export interface SendRow extends QueryResultRow {
  send_id: string; order_id: string; client_id: string | null; actor_id: string; request_id: string; idempotency_key: string; fingerprint: string;
  target_kind: 'client' | 'chat' | 'employee'; chat_key: string | null; form_code: OrderFormCode; destination_chat_id: string | null;
  recipient_key?: string | null; employee_id?: string | null; employee_contact_id?: string | null; recipient_fingerprint?: string | null;
  employee_name?: string | null;
  phone_normalized: string | null; recipient_masked: string; file_key: string | null; sha256: string | null; size_bytes: number | null;
  file_name: string; caption: string | null; state: OrderSendState; error_code: string | null; cancel_reason: OrderSendCancelReason | null;
  attempt_count: number; next_attempt_at: Date; lock_token: string | null; send_started_at: Date | null; provider_message_id: string | null;
  provider_ack: boolean; sent_at: Date | null; queue_expires_at: Date; purged_at: Date | null; created_at: Date; updated_at: Date;
  parts_total: number; cancelled_by: string | null;
  actor_username?: string | null; chat_label?: string | null; order_name?: string | null; cancelled_by_username?: string | null;
}

/** Pages 2..N of an image form (page 1 is the send row's own file). */
export interface PartRow extends QueryResultRow {
  send_id: string; part_no: number; file_key: string | null; sha256: string | null; size_bytes: number | null;
  provider_message_id: string | null; sent_at: Date | null; purged_at: Date | null;
}

export interface StoredPart { fileKey: string; sha256: string; sizeBytes: number }

/** Everything the command decided under the locks, handed to the caller to render and store the file. */
export interface EnqueueDecision {
  settings: SettingsRow;
  chat: ChatRow | null;
  employee: ResolvedEmployee | null;
}

/** An employee recipient resolved under the command locks: the contact actually used and its fingerprint. */
export interface ResolvedEmployee {
  recipient: EmployeeRecipientRow;
  employeeName: string;
  contactId: number;
  phoneNormalized: string;
  fingerprint: string;
}

export interface NewSend {
  sendId: string; orderId: number; clientId: number | null; actor: CurrentUser; requestId: string; idempotencyKey: string; fingerprint: string;
  targetKind: 'client' | 'chat' | 'employee'; chatKey: string | null; form: OrderFormCode; destinationChatId: string | null; phoneNormalized: string | null;
  employee: ResolvedEmployee | null;
  recipientMasked: string; fileKey: string; sha256: string; sizeBytes: number; fileName: string; caption: string;
  /** Pages 2..N of an image form, in order. */
  parts: StoredPart[];
}

export interface SendIntent {
  token: string; destinationChatId: string; fileKey: string; sha256: string; fileName: string; caption: string; form: OrderFormCode;
  /** Pages 2..N (already sent ones are never sent again: there is no retry). */
  parts: Array<StoredPart & { partNo: number }>;
}

/** The queue as one consistent read: settings (gate), pause, every waiting send and their estimates. */
export interface QueueSnapshot {
  paused: boolean;
  settings: SettingsRow;
  rows: SendRow[];
  estimates: Map<string, QueueEstimate>;
}

/**
 * Lock order everywhere: whatsapp_broadcast_control → settings → chat / employee recipient → send row → order →
 * employees → employee_work_contacts (the contacts command: employees → contacts).
 */
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
    const employees = await this.activeEmployeeRecipients(client);
    return { ...mapSettings(settings, chats, employees), lastDeliveryAt: settings.last_delivery_at };
  }

  async activeEmployeeRecipients(client: DatabaseClient = this.database): Promise<EmployeeRecipientRow[]> {
    return (await client.query<EmployeeRecipientRow>(`SELECT r.*, e.full_name employee_name FROM whatsapp_order_send_employees r
      JOIN employees e ON e.employee_id = r.employee_id WHERE r.archived_at IS NULL ORDER BY r.position, r.created_at`)).rows;
  }

  /**
   * The employees of the card menu (WhatsApp only in this release): «логин / ФИО» when active users are
   * linked to the employee, the phones of the employee only as masks, the primary one first.
   */
  async menuEmployees(): Promise<Array<{ recipientKey: string; label: string; forms: OrderFormCode[];
    contacts: Array<{ contactId: number; masked: string; isPrimary: boolean }> }>> {
    const recipients = (await this.database.query<EmployeeRecipientRow & { usernames: string | null }>(`SELECT r.*, e.full_name employee_name,
        (SELECT string_agg(u.username::text, ', ' ORDER BY u.username) FROM users u WHERE u.employee_id = e.employee_id AND u.is_active) usernames
      FROM whatsapp_order_send_employees r JOIN employees e ON e.employee_id = r.employee_id
      WHERE r.archived_at IS NULL AND r.channel = 'whatsapp' AND e.is_active IS NOT FALSE ORDER BY r.position, r.created_at`)).rows;
    if (!recipients.length) return [];
    const contacts = (await this.database.query<{ contact_id: string; employee_id: string; value_normalized: string; is_primary: boolean }>(
      `SELECT contact_id, employee_id, value_normalized, is_primary FROM employee_work_contacts
       WHERE kind = 'phone' AND employee_id = ANY($1::bigint[]) ORDER BY is_primary DESC, position, contact_id`,
      [recipients.map((row) => row.employee_id)])).rows;
    return recipients.map((row) => ({
      recipientKey: row.recipient_key,
      label: row.usernames ? `${row.usernames} / ${row.employee_name ?? ''}` : row.employee_name ?? '',
      forms: knownForms(row.forms),
      contacts: contacts.filter((contact) => contact.employee_id === row.employee_id)
        .map((contact) => ({ contactId: Number(contact.contact_id), masked: maskPhone(contact.value_normalized), isPrimary: contact.is_primary })),
    }));
  }

  /** Active employees for the settings picker: name, linked users and how many phones they have. */
  async employeeDirectory(): Promise<Array<{ employeeId: number; fullName: string; usernames: string[]; phones: number }>> {
    // users.username is citext in the real schema: without ::text the driver returns the array unparsed ("{a,b}").
    const rows = (await this.database.query<{ employee_id: string; full_name: string; usernames: string[] | null; phones: number }>(
      `SELECT e.employee_id, e.full_name,
         (SELECT array_agg(u.username::text ORDER BY u.username) FROM users u WHERE u.employee_id = e.employee_id AND u.is_active) usernames,
         (SELECT count(*)::int FROM employee_work_contacts c WHERE c.employee_id = e.employee_id AND c.kind = 'phone') phones
       FROM employees e WHERE e.is_active IS NOT FALSE ORDER BY e.full_name`)).rows;
    return rows.map((row) => ({ employeeId: Number(row.employee_id), fullName: row.full_name, usernames: Array.isArray(row.usernames) ? row.usernames : [], phones: row.phones }));
  }

  /** The employee of a recipient row (also an archived one: employee and key never change). */
  async employeeOfRecipient(recipientKey: string): Promise<number | null> {
    const row = (await this.database.query<{ employee_id: string }>('SELECT employee_id FROM whatsapp_order_send_employees WHERE recipient_key = $1',
      [recipientKey])).rows[0];
    return row ? Number(row.employee_id) : null;
  }

  async employeeRecipientChannel(recipientKey: string | null): Promise<OrderSendChannel | null> {
    if (!recipientKey) return null;
    return (await this.database.query<{ channel: OrderSendChannel }>('SELECT channel FROM whatsapp_order_send_employees WHERE recipient_key = $1',
      [recipientKey])).rows[0]?.channel ?? null;
  }

  /**
   * The worker's last check of an employee send under the intent locks (settings, send row and order held;
   * then employees → contacts, as the contacts command): never redirected — any change cancels.
   */
  async verifyEmployeeRecipient(tx: TransactionClient, row: SendRow): Promise<OrderSendCancelReason | null> {
    const recipient = (await tx.query<EmployeeRecipientRow>('SELECT * FROM whatsapp_order_send_employees WHERE recipient_key = $1 FOR SHARE',
      [row.recipient_key])).rows[0];
    if (!recipient || recipient.archived_at) return 'recipient_removed';
    if (String(recipient.employee_id) !== String(row.employee_id) || !ORDER_SEND_SUPPORTED_CHANNELS.includes(recipient.channel)) return 'recipient_changed';
    if (!knownForms(recipient.forms).includes(row.form_code)) return 'form_not_allowed';
    const employee = (await tx.query<{ is_active: boolean | null }>('SELECT is_active FROM employees WHERE employee_id = $1 FOR SHARE',
      [row.employee_id])).rows[0];
    if (!employee || employee.is_active === false) return 'recipient_removed';
    const contact = (await tx.query<{ value_normalized: string; kind: string }>(
      'SELECT value_normalized, kind FROM employee_work_contacts WHERE contact_id = $1 AND employee_id = $2 FOR SHARE',
      [row.employee_contact_id, row.employee_id])).rows[0];
    if (!contact || contact.kind !== 'phone' || contact.value_normalized !== row.phone_normalized) return 'recipient_changed';
    return null;
  }

  /**
   * The employee recipient of a command, under the command locks (settings held): the recipient row,
   * the active employee, the chosen (or primary) phone of his own and the fingerprint that identifies
   * «this employee on this number» for the duplicate and unknown-outcome guards — it survives retention.
   */
  async resolveEmployee(tx: TransactionClient, settings: SettingsRow, recipientKey: string, contactId: number | null): Promise<ResolvedEmployee> {
    const recipient = (await tx.query<EmployeeRecipientRow>('SELECT * FROM whatsapp_order_send_employees WHERE recipient_key = $1 FOR SHARE',
      [recipientKey])).rows[0];
    if (!recipient || recipient.archived_at) throw new ApiError(409, 'ORDER_SEND_RECIPIENT_UNKNOWN', 'Этого сотрудника больше нет в настройках; обновите страницу');
    if (!ORDER_SEND_SUPPORTED_CHANNELS.includes(recipient.channel)) {
      throw new ApiError(422, 'ORDER_SEND_CHANNEL_UNSUPPORTED', 'Отправка сотрудникам в Telegram пока недоступна');
    }
    const employee = (await tx.query<{ full_name: string; is_active: boolean | null }>(
      'SELECT full_name, is_active FROM employees WHERE employee_id = $1 FOR SHARE', [recipient.employee_id])).rows[0];
    if (!employee || employee.is_active === false) throw new ApiError(409, 'EMPLOYEE_INACTIVE', 'Сотрудник не активен');
    const contact = (await tx.query<{ contact_id: string; value_normalized: string }>(`SELECT contact_id, value_normalized FROM employee_work_contacts
      WHERE employee_id = $1 AND kind = 'phone' AND ($2::bigint IS NULL AND is_primary OR contact_id = $2::bigint) FOR SHARE`,
    [recipient.employee_id, contactId])).rows[0];
    if (!contact) {
      throw new ApiError(409, 'EMPLOYEE_CONTACT_MISSING', contactId === null ? 'У сотрудника нет основного телефона' : 'Этого телефона у сотрудника больше нет; обновите страницу');
    }
    return {
      recipient, employeeName: employee.full_name, contactId: Number(contact.contact_id), phoneNormalized: contact.value_normalized,
      fingerprint: recipientFingerprint(settings.identity_salt, Number(recipient.employee_id), contact.value_normalized),
    };
  }

  async activeSendExists(): Promise<boolean> {
    return Boolean((await this.database.query<{ active: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM whatsapp_order_sends WHERE state IN ('queued','sending')) active`)).rows[0]?.active);
  }

  /** Every waiting send (queued + sending) with its estimate; one snapshot of settings, pause and rows. */
  async queueSnapshot(client: DatabaseClient = this.database, now = new Date()): Promise<QueueSnapshot> {
    const settings = await this.settingsRow(client, false);
    const paused = Boolean((await client.query<{ paused: boolean }>('SELECT paused FROM whatsapp_broadcast_control WHERE singleton_id = 1')).rows[0]?.paused);
    const rows = (await client.query<SendRow>(`${sendSelect()} WHERE s.state IN ('queued','sending') ORDER BY s.created_at, s.send_id`)).rows;
    return { paused, settings, rows, estimates: estimateQueue(settings, rows, now) };
  }

  async updateSettings(input: OrderSendSettingsInput & { employeesGiven?: boolean }, actor: CurrentUser, requestId: string): Promise<void> {
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
      // Employee recipients (a client of the previous release sends none: then they stay as they are).
      const existingEmployees = (await tx.query<EmployeeRecipientRow>(
        'SELECT * FROM whatsapp_order_send_employees WHERE archived_at IS NULL FOR UPDATE')).rows;
      let archivedEmployees: string[] = [];
      if (input.employeesGiven !== false) {
        const employeesByKey = new Map(existingEmployees.map((row) => [row.recipient_key, row]));
        for (const employee of input.employees ?? []) {
          if (employee.recipientKey && !employeesByKey.has(employee.recipientKey)) {
            throw new ApiError(409, 'ORDER_SEND_SETTINGS_VERSION_CONFLICT', 'Сотрудник уже убран из настроек; обновите страницу');
          }
        }
        // A recipient keeps its key only for the same employee and channel (never redirected).
        const keptEmployees = new Set((input.employees ?? [])
          .filter((employee) => {
            const row = employee.recipientKey ? employeesByKey.get(employee.recipientKey) : undefined;
            return row && Number(row.employee_id) === employee.employeeId && row.channel === employee.channel;
          })
          .map((employee) => employee.recipientKey as string));
        archivedEmployees = existingEmployees.filter((row) => !keptEmployees.has(row.recipient_key)).map((row) => row.recipient_key);
        for (const key of archivedEmployees) await tx.query('UPDATE whatsapp_order_send_employees SET archived_at = now() WHERE recipient_key = $1', [key]);
        for (const [position, employee] of (input.employees ?? []).entries()) {
          if (employee.recipientKey && keptEmployees.has(employee.recipientKey)) {
            await tx.query('UPDATE whatsapp_order_send_employees SET forms = $2, caption = $3, position = $4 WHERE recipient_key = $1',
              [employee.recipientKey, employee.forms, employee.caption, position]);
          } else {
            const known = (await tx.query<{ ok: boolean }>('SELECT EXISTS (SELECT 1 FROM employees WHERE employee_id = $1) ok', [employee.employeeId])).rows[0]?.ok;
            if (!known) throw new ApiError(422, 'VALIDATION_ERROR', 'Сотрудник не найден');
            await tx.query(`INSERT INTO whatsapp_order_send_employees (recipient_key, employee_id, channel, forms, caption, position, created_by)
              VALUES ($1, $2, $3, $4, $5, $6, $7)`, [randomUUID(), employee.employeeId, employee.channel, employee.forms, employee.caption, position,
              numericId(actor.id)]);
          }
        }
      }
      const cancelled: Array<{ sendId: string; reason: OrderSendCancelReason }> = [];
      if (archived.length) cancelled.push(...await this.cancelQueued(tx, `chat_key = ANY($1::uuid[])`, [archived], 'recipient_removed', requestId));
      if (archivedEmployees.length) {
        cancelled.push(...await this.cancelQueued(tx, `recipient_key = ANY($1::uuid[])`, [archivedEmployees], 'recipient_removed', requestId));
      }
      if (!input.enabled) cancelled.push(...await this.cancelQueued(tx, 'true', [], 'disabled', requestId));
      // A changed threshold or window redraws the pending random delay from the last delivery.
      const timingChanged = before.min_interval_minutes !== input.minIntervalMinutes || before.send_window_minutes !== input.sendWindowMinutes;
      const nextDelivery = timingChanged && before.last_delivery_at
        ? this.nextDeliveryAt(before.last_delivery_at, input.minIntervalMinutes, input.sendWindowMinutes) : before.next_delivery_at;
      await tx.query(`UPDATE whatsapp_order_send_settings SET version = version + 1, enabled = $1, min_interval_minutes = $2, client_forms = $3,
        client_caption = $4, send_window_minutes = $6, next_delivery_at = $7, updated_at = now(), updated_by = $5 WHERE singleton`,
      [input.enabled, input.minIntervalMinutes, input.clientForms, input.clientCaption, numericId(actor.id), input.sendWindowMinutes, nextDelivery]);
      if (timingChanged) {
        // Waiting sends are woken for a fresh check against the new gate; their 24-hour life is fixed.
        await tx.query(`UPDATE whatsapp_order_sends SET next_attempt_at = now(), updated_at = now() WHERE state = 'queued'`);
      }
      const after = await this.getSettings(tx);
      await auditService.record(tx, {
        event: 'whatsapp.order_send_settings.updated', entityType: 'whatsapp_order_send_settings', entityId: 'singleton',
        actorUserId: numericId(actor.id), actorUsername: actor.username, actorRole: actor.role, requestId, source: SOURCE,
        before: settingsAudit(mapSettings(before, existing, existingEmployees)), after: settingsAudit(after),
        metadata: { archivedChats: archived.length, archivedEmployees: archivedEmployees.length, cancelledSends: cancelled.length },
      });
    }).catch((error: unknown) => {
      if (isUniqueViolation(error, 'idx_whatsapp_order_send_chats_group_active')) {
        throw new ApiError(409, 'ORDER_SEND_SETTINGS_VERSION_CONFLICT', 'Эта группа уже есть в списке чатов');
      }
      if (isUniqueViolation(error, 'idx_whatsapp_order_send_employees_active')) {
        throw new ApiError(409, 'ORDER_SEND_SETTINGS_VERSION_CONFLICT', 'Этот сотрудник уже есть в списке');
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
   * enabled → queue limits → the same form to the same recipient already waiting → chat. `prepare`
   * then reads the order, checks access, renders and stores the files and returns the row to insert,
   * all inside the same transaction. The send always waits in the FIFO queue; the worker passes the gate.
   */
  async enqueue(params: {
    actorId: string; idempotencyKey: string; fingerprint: string; chatKey: string | null;
    /** An employee recipient: resolved under the locks before the guards (its fingerprint is the identity). */
    employee?: { recipientKey: string; contactId: number | null } | null;
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
      // Under the settings lock every card command is serialized, so the counts and checks cannot race.
      const counts = (await tx.query<{ total: number; mine: number }>(`SELECT count(*)::int total,
          count(*) FILTER (WHERE actor_id = $1)::int mine FROM whatsapp_order_sends WHERE state IN ('queued','sending')`,
      [numericId(params.actorId)])).rows[0] ?? { total: 0, mine: 0 };
      if (counts.total >= ORDER_SEND_QUEUE_MAX) {
        throw new ApiError(409, 'ORDER_SEND_QUEUE_FULL', `В очереди уже ${ORDER_SEND_QUEUE_MAX} отправок; повторите позже`, { scope: 'total', limit: ORDER_SEND_QUEUE_MAX });
      }
      if (counts.mine >= ORDER_SEND_QUEUE_MAX_PER_ACTOR) {
        throw new ApiError(409, 'ORDER_SEND_QUEUE_FULL', `У вас уже ${ORDER_SEND_QUEUE_MAX_PER_ACTOR} отправок в очереди; дождитесь их или отмените лишние`,
          { scope: 'actor', limit: ORDER_SEND_QUEUE_MAX_PER_ACTOR });
      }
      const employee = params.employee ? await this.resolveEmployee(tx, settings, params.employee.recipientKey, params.employee.contactId) : null;
      // Who «the same recipient» is: the client, the chat, or the employee on this very number (a fingerprint
      // that survives retention and a change of the primary contact or of the settings row).
      const identity = employee
        ? { sql: `target_kind = 'employee' AND recipient_fingerprint = $3`, value: employee.fingerprint }
        : params.chatKey ? { sql: `target_kind = 'chat' AND chat_key = $3::uuid`, value: params.chatKey }
          : { sql: `target_kind = 'client' AND $3::text IS NULL`, value: null };
      if (params.orderId !== undefined && params.form !== undefined) {
        const waiting = (await tx.query<{ send_id: string }>(`SELECT send_id FROM whatsapp_order_sends WHERE state IN ('queued','sending')
          AND order_id = $1 AND form_code = $2 AND ${identity.sql} ORDER BY created_at LIMIT 1`,
        [params.orderId, params.form, identity.value])).rows[0];
        if (waiting) {
          const estimate = (await this.queueSnapshot(tx)).estimates.get(waiting.send_id);
          throw new ApiError(409, 'ORDER_SEND_ALREADY_QUEUED', 'Эта форма этому получателю уже ждёт отправки',
            { sendId: waiting.send_id, estimatedAt: estimate ? estimate.estimatedAt.toISOString() : null });
        }
        // Under the settings lock every card command is serialized, so this check cannot race.
        const previous = (await tx.query<{ send_id: string; state: string; created_at: Date }>(`SELECT send_id, state, created_at
          FROM whatsapp_order_sends WHERE order_id = $1 AND form_code = $2 AND ${identity.sql}
          ORDER BY created_at DESC LIMIT 1`, [params.orderId, params.form, identity.value])).rows[0];
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
      const send = await params.prepare(tx, { settings, chat, employee });
      const row = (await tx.query<SendRow>(`INSERT INTO whatsapp_order_sends (send_id, order_id, client_id, actor_id, request_id, idempotency_key,
          fingerprint, target_kind, chat_key, form_code, destination_chat_id, phone_normalized, recipient_masked, file_key, sha256, size_bytes,
          file_name, caption, queue_expires_at, parts_total, recipient_key, employee_id, employee_contact_id, recipient_fingerprint)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`, [
        send.sendId, send.orderId, send.clientId, numericId(send.actor.id), send.requestId, send.idempotencyKey, send.fingerprint, send.targetKind,
        send.chatKey, send.form, send.destinationChatId, send.phoneNormalized, send.recipientMasked, send.fileKey, send.sha256, send.sizeBytes,
        send.fileName, send.caption, new Date(Date.now() + ORDER_SEND_QUEUE_TTL_MS), 1 + send.parts.length,
        send.employee?.recipient.recipient_key ?? null, send.employee ? Number(send.employee.recipient.employee_id) : null,
        send.employee?.contactId ?? null, send.employee?.fingerprint ?? null,
      ])).rows[0];
      for (const [index, part] of send.parts.entries()) {
        await tx.query(`INSERT INTO whatsapp_order_send_parts (send_id, part_no, file_key, sha256, size_bytes) VALUES ($1, $2, $3, $4, $5)`,
          [send.sendId, index + 2, part.fileKey, part.sha256, part.sizeBytes]);
      }
      const estimate = (await this.queueSnapshot(tx)).estimates.get(row.send_id);
      await this.audit(tx, row, 'requested', send.actor, {
        from: null, to: 'queued', partsTotal: row.parts_total,
        position: estimate?.position ?? null, estimatedAt: estimate ? estimate.estimatedAt.toISOString() : null,
      });
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
      WHERE send_id = $1 AND state = 'queued' AND target_kind IN ('client','employee') AND destination_chat_id IS NULL`, [sendId, chatId]);
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
      const parts = (await tx.query<PartRow>(`SELECT * FROM whatsapp_order_send_parts WHERE send_id = $1 AND purged_at IS NULL
        ORDER BY part_no`, [sendId])).rows;
      if (parts.length !== row.parts_total - 1 || parts.some((part) => !part.file_key || !part.sha256 || !part.size_bytes)) {
        // Never start a delivery that cannot finish: a missing page fails the send before any attempt.
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
      await this.audit(tx, updated, 'intent', null, { from: 'queued', to: 'sending', partsTotal: row.parts_total });
      return { token, destinationChatId: row.destination_chat_id, fileKey: row.file_key, sha256: row.sha256, fileName: row.file_name,
        caption: row.caption ?? '', form: row.form_code,
        parts: parts.map((part) => ({ partNo: part.part_no, fileKey: part.file_key as string, sha256: part.sha256 as string, sizeBytes: part.size_bytes as number })) };
    });
  }

  /**
   * One page of an image form was accepted by WhatsApp (pages 2..N; page 1 is stored by `settle`).
   * Fenced by the intent token: a stale worker never writes over a recovered send.
   */
  async recordPartSent(sendId: string, token: string, partNo: number, providerMessageId: string): Promise<boolean> {
    const updated = await this.database.query(`UPDATE whatsapp_order_send_parts p SET provider_message_id = $4, sent_at = now()
      FROM whatsapp_order_sends s WHERE p.send_id = s.send_id AND s.send_id = $1 AND s.lock_token = $2 AND s.state = 'sending' AND p.part_no = $3`,
    [sendId, token, partNo, providerMessageId]);
    return (updated.rowCount ?? 0) > 0;
  }

  /** Conditional settle (fencing token); the audit row is written in the same transaction. */
  async settle(sendId: string, token: string, result: { state: 'sent'; providerMessageId: string } | { state: 'failed' | 'unknown'; errorCode: string; providerMessageId?: string | null },
    details: { partsSent?: number } = {}) {
    return this.database.transaction(async (tx) => {
      const row = (await tx.query<SendRow>(`UPDATE whatsapp_order_sends SET state = $3, lock_token = NULL,
          provider_message_id = $4, provider_ack = $5, sent_at = CASE WHEN $3 = 'sent' THEN now() ELSE NULL END, error_code = $6, updated_at = now()
        WHERE send_id = $1 AND lock_token = $2 AND state = 'sending' RETURNING *`, [
        sendId, token, result.state, result.providerMessageId ?? null, result.state === 'sent',
        result.state === 'sent' ? null : result.errorCode,
      ])).rows[0];
      if (!row) return false;
      await this.audit(tx, row, result.state, null, {
        from: 'sending', to: result.state, errorCode: row.error_code,
        ...(row.parts_total > 1 ? { partsTotal: row.parts_total, partsSent: details.partsSent ?? (result.state === 'sent' ? row.parts_total : 0) } : {}),
      });
      return true;
    });
  }

  /**
   * Manual cancel of a waiting send: by its author, or by a WhatsApp manager (any send). Lock order as
   * everywhere (control → settings → send row). A queued send becomes `cancelled/manual`; a send that
   * is already delivering cannot be cancelled; a finished one is returned as is (idempotent). A foreign
   * send of a user without the manager right is «not found» (no oracle).
   */
  async cancel(sendId: string, actor: CurrentUser, requestId: string): Promise<{ row: SendRow; cancelled: boolean }> {
    const manager = ORDER_SEND_SETTINGS_PERMISSIONS.every((permission) => actor.permissions.includes(permission));
    const actorId = numericId(actor.id);
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT paused FROM whatsapp_broadcast_control WHERE singleton_id = 1 FOR SHARE');
      await this.settingsRow(tx, true);
      const row = (await tx.query<SendRow>('SELECT * FROM whatsapp_order_sends WHERE send_id = $1 FOR UPDATE', [sendId])).rows[0];
      if (!row || (!manager && Number(row.actor_id) !== actorId)) throw new ApiError(404, 'ORDER_SEND_NOT_FOUND', 'Отправка не найдена');
      if (row.state === 'sending') throw new ApiError(409, 'ORDER_SEND_NOT_CANCELLABLE', 'Отправка уже уходит в WhatsApp; отменить её нельзя');
      if (row.state !== 'queued') return { row, cancelled: false };
      const updated = (await tx.query<SendRow>(`UPDATE whatsapp_order_sends SET state = 'cancelled', cancel_reason = 'manual', cancelled_by = $2,
          updated_at = now() WHERE send_id = $1 AND state = 'queued' RETURNING *`, [sendId, actorId])).rows[0];
      await this.audit(tx, updated, 'cancelled', actor, {
        from: 'queued', to: 'cancelled', cancelReason: 'manual', byAuthor: Number(row.actor_id) === actorId,
      }, requestId, Number(row.actor_id));
      return { row: updated, cancelled: true };
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
    // Pages 2..N of purged sends lose their file and provider id (it may carry the phone) too.
    const purgedParts = (await this.database.query<{ file_key: string | null }>(`
      WITH purged AS (
        SELECT p.send_id, p.part_no, p.file_key FROM whatsapp_order_send_parts p JOIN whatsapp_order_sends s ON s.send_id = p.send_id
        WHERE p.purged_at IS NULL AND s.purged_at IS NOT NULL LIMIT 2000 FOR UPDATE OF p SKIP LOCKED
      )
      UPDATE whatsapp_order_send_parts p SET file_key = NULL, sha256 = NULL, size_bytes = NULL, provider_message_id = NULL, purged_at = now()
      FROM purged WHERE p.send_id = purged.send_id AND p.part_no = purged.part_no
      RETURNING purged.file_key`)).rows.map((row) => row.file_key).filter((key): key is string => key !== null);
    const referenced = new Set((await this.database.query<{ file_key: string }>(
      `SELECT file_key FROM whatsapp_order_sends WHERE file_key IS NOT NULL
       UNION SELECT file_key FROM whatsapp_order_send_parts WHERE file_key IS NOT NULL`)).rows.map((row) => row.file_key));
    return { referenced, purgedKeys: [...purgedKeys, ...purgedParts] };
  }

  // ------------------------------------------------------------------ reads

  /** Whether any row still points at a file; an error counts as «referenced» (keep the file for the sweep). */
  async fileReferenced(fileKey: string): Promise<boolean> {
    return Boolean((await this.database.query<{ referenced: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM whatsapp_order_sends WHERE file_key = $1)
        OR EXISTS (SELECT 1 FROM whatsapp_order_send_parts WHERE file_key = $1) referenced`, [fileKey])).rows[0]?.referenced);
  }

  /** Pages 2..N of an image form, in order. */
  async parts(sendId: string): Promise<PartRow[]> {
    return (await this.database.query<PartRow>('SELECT * FROM whatsapp_order_send_parts WHERE send_id = $1 ORDER BY part_no', [sendId])).rows;
  }

  async getSend(sendId: string): Promise<SendRow | null> {
    return (await this.database.query<SendRow>(`${sendSelect()} WHERE s.send_id = $1`, [sendId])).rows[0] ?? null;
  }

  async listForOrder(orderId: number, limit: number): Promise<SendRow[]> {
    return (await this.database.query<SendRow>(`${sendSelect()} WHERE s.order_id = $1 ORDER BY s.created_at DESC LIMIT $2`, [orderId, limit])).rows;
  }

  /** Journal history: finished sends of the last 7 days (retention), newest first. */
  async listHistory(page: number, pageSize: number, now = new Date()): Promise<{ rows: SendRow[]; total: number }> {
    const since = new Date(now.getTime() - ORDER_SEND_RETENTION_MS);
    const [rows, total] = await Promise.all([
      this.database.query<SendRow>(`${sendSelect()} WHERE s.state NOT IN ('queued','sending') AND s.created_at >= $1
        ORDER BY s.created_at DESC, s.send_id LIMIT $2 OFFSET $3`, [since, pageSize, (page - 1) * pageSize]),
      this.database.query<{ total: number }>(`SELECT count(*)::int total FROM whatsapp_order_sends
        WHERE state NOT IN ('queued','sending') AND created_at >= $1`, [since]),
    ]);
    return { rows: rows.rows, total: total.rows[0]?.total ?? 0 };
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
    requestId?: string, relatedUserId?: number) {
    // An employee recipient (schema 235): a normalized link to the employee, also when this release only refuses it.
    const employeeId = (row as SendRow & { employee_id?: string | number | null }).employee_id;
    const employee = employeeId === null || employeeId === undefined ? null : Number(employeeId);
    await auditService.record(tx, {
      event: `whatsapp.order_send.${action}`, entityType: 'whatsapp_order_send', entityId: row.send_id,
      actorUserId: actor ? numericId(actor.id) : Number(row.actor_id), actorUsername: actor?.username ?? null, actorRole: actor?.role ?? null,
      requestId: requestId ?? row.request_id, source: SOURCE, ...(relatedUserId ? { relatedUserId } : {}),
      relatedOrderId: Number(row.order_id), relatedClientId: row.client_id === null ? null : Number(row.client_id),
      statusField: 'order_send_state', statusCode: row.state,
      ...(employee ? { relatedEntities: [{ entityType: 'employee', entityId: employee }] } : {}),
      metadata: {
        sendId: row.send_id, targetKind: row.target_kind, chatKey: row.chat_key, recipientMasked: row.recipient_masked, form: row.form_code,
        ...(employee ? { employeeId: employee } : {}), source: 'order_card', ...transition,
      },
    });
  }
}

function sendSelect() {
  return `SELECT s.*, u.username actor_username, c.label chat_label, o.order_name, cu.username cancelled_by_username, e.full_name employee_name
    FROM whatsapp_order_sends s
    LEFT JOIN users u ON u.user_id = s.actor_id LEFT JOIN whatsapp_order_send_chats c ON c.chat_key = s.chat_key
    LEFT JOIN orders o ON o.order_id = s.order_id LEFT JOIN users cu ON cu.user_id = s.cancelled_by
    LEFT JOIN employees e ON e.employee_id = s.employee_id`;
}

/** «This employee on this number», keyed by the installation salt: the phone itself is not recoverable from it. */
export function recipientFingerprint(salt: string, employeeId: number, phoneNormalized: string): string {
  return createHash('sha256').update(`${salt}employee:${employeeId}:${phoneNormalized}`).digest('hex');
}

export { deliveryAllowedAt, nextAllowed };

function assertSameCommand(row: SendRow, fingerprint: string): SendRow {
  if (row.fingerprint !== fingerprint) {
    throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Ключ запроса уже использован для другой отправки');
  }
  return row;
}

function mapSettings(row: SettingsRow, chats: ChatRow[], employees: EmployeeRecipientRow[] = []): OrderSendSettings {
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
    employees: employees.filter((employee) => !employee.archived_at).map((employee): OrderSendEmployeeRecipient => ({
      recipientKey: employee.recipient_key, employeeId: Number(employee.employee_id), employeeName: employee.employee_name ?? '',
      channel: employee.channel, forms: knownForms(employee.forms), caption: employee.caption,
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
    employees: settings.employees.map((employee) => ({ recipientKey: employee.recipientKey, employeeId: employee.employeeId, channel: employee.channel,
      forms: employee.forms })),
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
