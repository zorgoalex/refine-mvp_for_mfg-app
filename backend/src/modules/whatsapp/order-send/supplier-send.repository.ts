import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { lockActor } from '../../orders/adapters/pg-order-resource-procurement-repository';
import { loadLines, requireFullScope } from '../../orders/adapters/pg-supplier-requests-repository';
import { maskPhone } from './order-send-phone';
import {
  OrderSendRepository, SUPPLIER_FINAL_REFUSAL_CODES, assertSameCommand, finalRefusal, numericId, phoneToken, supplierFingerprint,
  supplierRequestOrderIds, type SendRow, type SettingsRow,
} from './order-send.repository';
import {
  ORDER_SEND_QUEUE_TTL_MS, ORDER_SEND_SUPPLIER_REQUESTS, SUPPLIER_SEND_PERMISSIONS, SUPPLIER_TEXT_FORM,
  type OrderSendCancelReason, type SupplierSendMenu,
} from './order-send.types';
import { splitSupplierText } from './supplier-send-text';

/** A parsed command of the procurement screen: the text of the window and the phone the menu showed. */
export interface SupplierSendCommand {
  supplierRequestId: number;
  /** Normalized line endings; validated by the DTO. */
  text: string;
  edited: boolean;
  templateId: number | null;
  templateVersion: number | null;
  /** The version of the request the text was built from. */
  textVersion: number;
  contactId: number;
  contactToken: string;
  idempotencyKey: string;
  confirmAfterUnknown: string | null;
}

interface RequestRow extends QueryResultRow {
  supplier_request_id: string; request_number: string; status: string; supplier_key: string; supplier_name: string;
  expected_date: string | null; comment: string | null; version: number;
}
interface SupplierRow extends QueryResultRow { supplier_id: number; supplier_name: string; is_active: boolean }
interface ContactRow extends QueryResultRow { contact_id: string; kind: string; value_normalized: string; is_primary: boolean }

const SENDABLE = new Set(['draft', 'sent']);

/**
 * A supplier request sent to WhatsApp through the queue of the order card sends (the same gate, journal,
 * cancellation and retention). Lock order of the command and of the worker's last check:
 * control → settings → send row → actor (FOR SHARE) → request (FOR SHARE) → orders of the request (FOR SHARE,
 * ascending, deleted ones too) → supplier (FOR SHARE) → contacts. Procurement commands take actor → request
 * (FOR UPDATE) and never a WhatsApp table; order commands never take a supplier request FOR UPDATE — no cycle.
 */
@Injectable()
export class SupplierSendRepository {
  /** New sends are made (false = the compatible release K3a; tests flip it). */
  makesSends: boolean = ORDER_SEND_SUPPLIER_REQUESTS;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OrderSendRepository) private readonly sends: OrderSendRepository,
  ) {}

  /** Not found and «not all orders are yours» before anything else (no ledger oracle for a foreign request). */
  async assertAccess(actor: CurrentUser, supplierRequestId: number): Promise<void> {
    await this.request(this.database, supplierRequestId, false);
    await requireFullScope(this.database, actor, supplierRequestId);
  }

  /** The recipient of the request as the window shows it: the supplier and the masks of his phones with their tokens. */
  async menu(actor: CurrentUser, supplierRequestId: number): Promise<Omit<SupplierSendMenu, 'runtime'>> {
    const request = await this.request(this.database, supplierRequestId, false);
    await requireFullScope(this.database, actor, supplierRequestId);
    const settings = await this.sends.settingsRow(this.database, false);
    const queueLength = (await this.sends.queueSnapshot()).rows.length;
    const supplier = await resolveSupplier(this.database, request.supplier_key, false);
    const contacts = supplier ? (await this.database.query<ContactRow>(`SELECT contact_id, kind, value_normalized, is_primary FROM supplier_contacts
      WHERE supplier_id = $1 AND kind = 'phone' ORDER BY is_primary DESC, position, contact_id`, [supplier.supplier_id])).rows : [];
    const on = settings.enabled && settings.supplier_requests_enabled === true;
    const unavailableReason: SupplierSendMenu['unavailableReason'] = !this.makesSends ? 'release' : !on ? 'disabled'
      : !SENDABLE.has(request.status) ? 'status' : !supplier ? 'not_linked' : !supplier.is_active ? 'supplier_inactive'
        : contacts.length === 0 ? 'no_phone' : null;
    return {
      enabled: this.makesSends && on,
      unavailableReason,
      supplier: supplier ? { supplierId: Number(supplier.supplier_id), name: supplier.supplier_name } : null,
      contacts: contacts.map((contact) => ({
        contactId: Number(contact.contact_id), masked: maskPhone(contact.value_normalized), isPrimary: contact.is_primary,
        token: phoneToken(settings.identity_salt, 'supplier', Number(contact.contact_id), contact.value_normalized),
      })),
      requestVersion: Number(request.version),
      queueLength,
    };
  }

  /**
   * The command transaction (see the lock order above): ledger (accepted, then refused for good) → this release
   * makes such sends → pause, settings, queue limits → actor → request → its orders → scope → version and status
   * → supplier → contact and its token → the same text to the same number already waiting / ended unknown →
   * the row with its messages, the audit and the domain event.
   */
  async enqueue(command: SupplierSendCommand, actor: CurrentUser, requestId: string, fingerprint: string): Promise<{ row: SendRow; replayed: boolean }> {
    const outcome = await this.database.transaction<{ row: SendRow; replayed: boolean } | { refusal: ApiError }>(async (tx) => {
      const control = (await tx.query<{ paused: boolean }>('SELECT paused FROM whatsapp_broadcast_control WHERE singleton_id = 1 FOR SHARE')).rows[0];
      const settings = await this.sends.settingsRow(tx, true);
      const committed = await this.sends.findCommand(tx, actor.id, command.idempotencyKey);
      if (committed) return { row: assertSameCommand(committed, fingerprint), replayed: true };
      const refused = (await tx.query<{ error_code: string }>(
        'SELECT error_code FROM whatsapp_order_send_refusals WHERE actor_id = $1 AND idempotency_key = $2',
        [numericId(actor.id), command.idempotencyKey])).rows[0];
      if (refused) return { refusal: finalRefusal(refused.error_code) };
      let supplierId: number | null = null;
      try {
        // After the ledger: an accepted command is replayed by any release, a new one is made only by the full one.
        if (!this.makesSends) throw new ApiError(409, 'SUPPLIER_SEND_UNAVAILABLE', 'Отправка заявок поставщикам в WhatsApp сейчас недоступна');
        if (control?.paused) throw new ApiError(409, 'ORDER_SEND_PAUSED', 'Все рассылки остановлены («Остановить все рассылки»)');
        if (!settings.enabled || settings.supplier_requests_enabled !== true) {
          throw new ApiError(409, 'SUPPLIER_SEND_DISABLED', 'Отправка заявок поставщикам в WhatsApp выключена в настройках');
        }
        await this.sends.assertQueueRoom(tx, actor.id);
        await lockActor(tx, actor);
        const request = await this.request(tx, command.supplierRequestId, true);
        await lockRequestOrders(tx, command.supplierRequestId);
        await requireFullScope(tx, actor, command.supplierRequestId);
        if (Number(request.version) !== command.textVersion) {
          throw new ApiError(409, 'SUPPLIER_REQUEST_VERSION_CONFLICT', 'Заявка изменилась — обновите текст и отправьте заново',
            { version: Number(request.version) });
        }
        if (!SENDABLE.has(request.status)) {
          throw new ApiError(409, 'SUPPLIER_REQUEST_NOT_SENDABLE', 'Отправить можно только черновик или отправленную заявку', { status: request.status });
        }
        const supplier = await resolveSupplier(tx, request.supplier_key, true);
        if (!supplier) throw new ApiError(409, 'SUPPLIER_NOT_LINKED', 'Поставщик заявки не связан со справочником «Поставщики»');
        supplierId = Number(supplier.supplier_id);
        if (!supplier.is_active) throw new ApiError(409, 'SUPPLIER_INACTIVE', 'Поставщик заявки не активен');
        const contact = (await tx.query<ContactRow>(`SELECT contact_id, kind, value_normalized, is_primary FROM supplier_contacts
          WHERE contact_id = $1 AND supplier_id = $2 AND kind = 'phone' FOR SHARE`, [command.contactId, supplierId])).rows[0];
        if (!contact) throw new ApiError(409, 'SUPPLIER_CONTACT_MISSING', 'У поставщика больше нет этого телефона; обновите страницу');
        // The window showed a mask of a number: the contact must still be that number.
        if (command.contactToken !== phoneToken(settings.identity_salt, 'supplier', Number(contact.contact_id), contact.value_normalized)) {
          throw new ApiError(409, 'ORDER_SEND_PHONE_CHANGED', 'Телефон получателя изменился; обновите страницу и выберите его заново');
        }
        const textSha256 = sha256(command.text);
        const recipient = supplierFingerprint(settings.identity_salt, supplierId, contact.value_normalized);
        // «The same send»: this request, this supplier on this number, this very text. Another text is another send.
        const identity = `target_kind = 'supplier' AND supplier_request_id = $1 AND recipient_fingerprint = $2 AND text_sha256 = $3`;
        const identityValues = [command.supplierRequestId, recipient, textSha256];
        const waiting = (await tx.query<{ send_id: string }>(`SELECT send_id FROM whatsapp_order_sends
          WHERE state IN ('queued','sending') AND ${identity} ORDER BY created_at LIMIT 1`, identityValues)).rows[0];
        if (waiting) {
          const estimate = (await this.sends.queueSnapshot(tx)).estimates.get(waiting.send_id);
          throw new ApiError(409, 'ORDER_SEND_ALREADY_QUEUED', 'Этот текст этому получателю уже ждёт отправки',
            { sendId: waiting.send_id, estimatedAt: estimate ? estimate.estimatedAt.toISOString() : null });
        }
        const previous = (await tx.query<{ send_id: string; state: string; created_at: Date }>(`SELECT send_id, state, created_at
          FROM whatsapp_order_sends WHERE ${identity} ORDER BY created_at DESC LIMIT 1`, identityValues)).rows[0];
        if (previous?.state === 'unknown' && command.confirmAfterUnknown !== previous.send_id) {
          throw new ApiError(409, 'ORDER_SEND_PREVIOUS_UNKNOWN', 'Результат прежней отправки этого текста неизвестен: проверьте чат и подтвердите повтор',
            { sendId: previous.send_id, createdAt: previous.created_at.toISOString() });
        }
        const messages = splitSupplierText(command.text);
        const sendId = randomUUID();
        const row = (await tx.query<SendRow>(`INSERT INTO whatsapp_order_sends (send_id, order_id, client_id, actor_id, request_id, idempotency_key,
            fingerprint, target_kind, form_code, phone_normalized, recipient_masked, file_name, queue_expires_at, parts_total, recipient_fingerprint,
            supplier_request_id, supplier_request_version, supplier_key, supplier_id, supplier_contact_id, request_content_sha256,
            text_body, text_sha256, text_length, text_edited, template_id, template_version)
          VALUES ($1, NULL, NULL, $2, $3, $4, $5, 'supplier', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
          RETURNING *`, [
          sendId, numericId(actor.id), requestId, command.idempotencyKey, fingerprint, SUPPLIER_TEXT_FORM, contact.value_normalized,
          maskPhone(contact.value_normalized), `Заявка № ${request.request_number}`, new Date(Date.now() + ORDER_SEND_QUEUE_TTL_MS), messages.length,
          recipient, command.supplierRequestId, Number(request.version), request.supplier_key, supplierId, Number(contact.contact_id),
          await requestContentSha256(tx, request), messages[0], textSha256, command.text.length, command.edited, command.templateId,
          command.templateVersion,
        ])).rows[0];
        for (const [index, message] of messages.slice(1).entries()) {
          await tx.query('INSERT INTO whatsapp_order_send_parts (send_id, part_no, text_body) VALUES ($1, $2, $3)', [sendId, index + 2, message]);
        }
        const estimate = (await this.sends.queueSnapshot(tx)).estimates.get(row.send_id);
        await this.sends.audit(tx, row, 'requested', actor, {
          from: null, to: 'queued', position: estimate?.position ?? null, estimatedAt: estimate ? estimate.estimatedAt.toISOString() : null,
        });
        return { row, replayed: false };
      } catch (error) {
        // The request or its recipient is not what the window showed: every such refusal is raised before anything
        // is written, so the refusal itself is recorded with its audit and committed — the browser may drop its key,
        // and a late or repeated request with it meets this very refusal, never a send.
        if (!(error instanceof ApiError) || !SUPPLIER_FINAL_REFUSAL_CODES.has(error.code)) throw error;
        await tx.query(`INSERT INTO whatsapp_order_send_refusals (actor_id, idempotency_key, fingerprint, error_code, supplier_request_id, request_id)
          VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (actor_id, idempotency_key) DO NOTHING`,
        [numericId(actor.id), command.idempotencyKey, fingerprint, error.code, command.supplierRequestId, requestId]);
        await auditRefusal(tx, command, actor, requestId, error.code, supplierId, true);
        return { refusal: new ApiError(error.statusCode, error.code, error.message, { ...(error.details ?? {}), final: true }) };
      }
    });
    if ('refusal' in outcome) throw outcome.refusal;
    return outcome;
  }

  /**
   * The worker's last check under the intent locks (control, settings and the send row are held): the author
   * still may send this request, the request says what it said when the text was queued, and the recipient is
   * the same supplier on the same number. Anything else cancels — never redirected, the text never rebuilt.
   * `loadActor` reads the author's current rights (it share-locks the authorization version and the user).
   */
  async verify(tx: TransactionClient, row: SendRow, settings: SettingsRow,
    loadActor: (tx: TransactionClient, userId: string) => Promise<CurrentUser | null>): Promise<OrderSendCancelReason | null> {
    if (settings.supplier_requests_enabled !== true) return 'disabled';
    const supplierRequestId = Number(row.supplier_request_id);
    const actor = await loadActor(tx, row.actor_id);
    if (!actor || !SUPPLIER_SEND_PERMISSIONS.every((permission) => actor.permissions.includes(permission))) return 'permission_revoked';
    const request = (await tx.query<RequestRow>(`${REQUEST_SQL} FOR SHARE`, [supplierRequestId])).rows[0];
    if (!request) return 'request_changed';
    await lockRequestOrders(tx, supplierRequestId);
    try {
      await requireFullScope(tx, actor, supplierRequestId);
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 403) return 'permission_revoked';
      throw error;
    }
    // «Отметить отправленной» keeps the send (draft → sent changes no content); an edit, a cancel or a close ends it.
    if (!SENDABLE.has(request.status) || await requestContentSha256(tx, request) !== row.request_content_sha256) return 'request_changed';
    const supplier = await resolveSupplier(tx, request.supplier_key, true);
    if (!supplier) return 'recipient_removed';
    if (String(supplier.supplier_id) !== String(row.supplier_id)) return 'recipient_changed';
    if (!supplier.is_active) return 'recipient_removed';
    const contact = (await tx.query<ContactRow>(`SELECT contact_id, kind, value_normalized, is_primary FROM supplier_contacts
      WHERE contact_id = $1 AND supplier_id = $2 FOR SHARE`, [row.supplier_contact_id, supplier.supplier_id])).rows[0];
    if (!contact) return 'recipient_removed';
    if (contact.kind !== 'phone' || contact.value_normalized !== row.phone_normalized) return 'recipient_changed';
    return null;
  }

  /** A refusal that does not end the command: its own committed audit row (the command transaction rolled back). */
  async recordRefusal(command: SupplierSendCommand, actor: CurrentUser, requestId: string, errorCode: string): Promise<void> {
    await auditRefusal(this.database, command, actor, requestId, errorCode, null, false);
  }

  private async request(client: DatabaseClient, supplierRequestId: number, lock: boolean): Promise<RequestRow> {
    const row = (await client.query<RequestRow>(`${REQUEST_SQL}${lock ? ' FOR SHARE' : ''}`, [supplierRequestId])).rows[0];
    if (!row) throw new ApiError(404, 'SUPPLIER_REQUEST_NOT_FOUND', 'Заявка поставщику не найдена');
    return row;
  }
}

const REQUEST_SQL = `SELECT supplier_request_id, request_number, status, supplier_key, supplier_name, expected_date::text AS expected_date,
  comment, version FROM supplier_requests WHERE supplier_request_id = $1`;

/** Every order of the request (deleted ones too), share-locked in ascending order: the scope fields cannot change. */
async function lockRequestOrders(tx: TransactionClient, supplierRequestId: number): Promise<void> {
  const orderIds = await supplierRequestOrderIds(tx, supplierRequestId);
  if (orderIds.length === 0) return;
  await tx.query('SELECT order_id FROM orders WHERE order_id = ANY($1::bigint[]) ORDER BY order_id FOR SHARE', [orderIds]);
}

/**
 * The supplier of the directory a request key points at: `s:<id>` — the row itself; `c:<uuid>` — the one supplier
 * linked to that 1C counterparty; a name-only key (`n:`) and «none» — nobody.
 */
async function resolveSupplier(client: DatabaseClient, supplierKey: string, lock: boolean): Promise<SupplierRow | null> {
  const tail = lock ? ' FOR SHARE' : '';
  if (/^s:[1-9]\d{0,8}$/.test(supplierKey)) {
    return (await client.query<SupplierRow>(`SELECT supplier_id, supplier_name, is_active FROM suppliers WHERE supplier_id = $1${tail}`,
      [Number(supplierKey.slice(2))])).rows[0] ?? null;
  }
  if (/^c:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(supplierKey)) {
    const rows = (await client.query<SupplierRow>(`SELECT supplier_id, supplier_name, is_active FROM suppliers
      WHERE ref_key_1c = $1::uuid ORDER BY supplier_id${tail}`, [supplierKey.slice(2)])).rows;
    return rows.length === 1 ? rows[0] : null;
  }
  return null;
}

/**
 * What the request says to the supplier: its supplier key, date, comment and lines (resource, quantity, unit,
 * order). Not its status and not its version: «Отметить отправленной» changes both and no content.
 */
async function requestContentSha256(client: DatabaseClient, request: RequestRow): Promise<string> {
  const lines = await loadLines(client, [Number(request.supplier_request_id)]);
  return sha256(JSON.stringify({
    supplierKey: request.supplier_key, expectedDate: request.expected_date, comment: request.comment ?? null,
    lines: lines.map((line) => [Number(line.line_no), line.resource_kind, Number(line.ref_id), String(Number(line.quantity)), line.unit_code]),
  }));
}

/** No number, no token, no text. */
async function auditRefusal(client: DatabaseClient, command: SupplierSendCommand, actor: CurrentUser, requestId: string, errorCode: string,
  supplierId: number | null, final: boolean): Promise<void> {
  const orderIds = await supplierRequestOrderIds(client, command.supplierRequestId);
  await auditService.record(client, {
    event: 'whatsapp.supplier_send.refused', entityType: 'supplier_request', entityId: command.supplierRequestId,
    actorUserId: numericId(actor.id), actorUsername: actor.username, actorRole: actor.role, requestId, source: 'erp_whatsapp_order_send',
    statusCode: errorCode,
    ...(orderIds.length === 1 ? { relatedOrderId: orderIds[0] } : {}),
    relatedEntities: [{ entityType: 'supplier_request', entityId: command.supplierRequestId },
      ...(supplierId === null ? [] : [{ entityType: 'supplier', entityId: supplierId }]),
      ...orderIds.map((orderId) => ({ entityType: 'order', entityId: orderId }))],
    metadata: { final, targetKind: 'supplier', supplierRequestId: command.supplierRequestId, supplierId, supplierContactId: command.contactId,
      orderIds, textLength: command.text.length, textEdited: command.edited, textVersion: command.textVersion, templateId: command.templateId,
      errorCode, correlationId: requestId, source: 'procurement_workspace' },
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
