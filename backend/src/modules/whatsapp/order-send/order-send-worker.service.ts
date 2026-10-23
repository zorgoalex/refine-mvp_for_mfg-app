import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import { WahaClient } from '../waha.client';
import { WhatsAppRuntimeConfigService } from '../whatsapp-runtime-config.service';
import { WhatsAppTechnicalLogService } from '../whatsapp-technical-log.service';
import { canSendOrder, OrderSendActors, readAccessSubject } from './order-send-actors';
import { OrderSendFileStore } from './order-send-file-store';
import { ONEC_PHONE_CHECK_MARGIN_MS, checkQueuedClientOnecPhone } from './client-onec-phone';
import { normalizeClientPhone } from './order-send-phone';
import { OrderSendRepository, knownForms, type SendIntent, type SendRow } from './order-send.repository';
import {
  ORDER_FORM_MIME, ORDER_SEND_SUPPORTED_CHANNELS, SUPPLIER_TEXT_FORM, isDeliverableForm, orderForm,
  type OrderFormCode, type OrderSendCancelReason, type OrderSendRuntime,
} from './order-send.types';
import { ONEC_LOCKED_CALL_MS, SupplierSendRepository, withDeadline } from './supplier-send.repository';

/** WAHA refused the request itself (validation, unsupported): nothing was sent. */
const DEFINITE_REJECTIONS = new Set([400, 404, 405, 415, 422, 501]);
const WAHA_RETRY_MS = 60_000;

/**
 * Delivery of «отправка заказа из карточки». Sends wait in a FIFO queue; one send per iteration:
 * resolve the client chat id, re-check rights and recipient, pass the system-wide frequency gate,
 * send the file (or the pictures of an image form one after another), settle conditionally.
 * Retention runs on its own timer.
 */
@Injectable()
export class OrderSendWorker implements OnModuleInit, OnModuleDestroy {
  /** Time of the gate, TTL and intent: read after the intent locks are held, never the iteration start. */
  clock: () => Date = () => new Date();
  /** How long the locks of a 1C phone are held for the WAHA number check (K4b-2); tests lower it. */
  onecCallDeadlineMs = ONEC_LOCKED_CALL_MS;
  private working = false;
  private cleaning = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    @Inject(OrderSendRepository) private readonly repository: OrderSendRepository,
    @Inject(OrderSendFileStore) private readonly store: OrderSendFileStore,
    @Inject(OrderSendActors) private readonly actors: OrderSendActors,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(WhatsAppRuntimeConfigService) private readonly runtimeConfig: WhatsAppRuntimeConfigService,
    @Inject(WahaClient) private readonly waha: WahaClient,
    @Optional() @Inject(WhatsAppTechnicalLogService) private readonly technicalLogs?: WhatsAppTechnicalLogService,
    @Optional() @Inject(SupplierSendRepository) private readonly suppliers?: SupplierSendRepository,
  ) {}

  onModuleInit() {
    this.timers = [
      setInterval(() => void this.work().catch(() => undefined), 15_000),
      setInterval(() => void this.cleanup().catch(() => undefined), 10 * 60_000),
    ];
    for (const timer of this.timers) timer.unref();
  }

  onModuleDestroy() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  runtime(): OrderSendRuntime {
    const config = this.runtimeConfig.getConfig();
    const relayAvailable = config.enabled && config.relayOwner === 'in_process';
    const unavailableReason = relayAvailable ? null : !config.enabled ? 'whatsapp_disabled'
      : config.relayOwner === 'in_process' ? 'relay_unavailable' : 'relay_owner_mismatch';
    return { enabled: config.enabled, relayAvailable, unavailableReason };
  }

  /** Right after a command: deliver without waiting for the timer (the gate still applies). */
  kick(): Promise<void> {
    return this.work().catch(() => undefined);
  }

  async work(now = new Date()) {
    if (this.working || !this.runtime().relayAvailable) return;
    this.working = true;
    try {
      await this.database.withAdvisoryLock('whatsapp-order-send-processing', async (assertOwned) => {
        await this.repository.markStaleIntentsUnknown(this.runtimeConfig.getConfig().relayStaleLockMs, now);
        await assertOwned();
        const next = await this.repository.nextQueued(now);
        if (next) await this.deliver(next, now);
      });
    } catch (error) {
      await this.log('error', 'whatsapp.order_send.delivery', 'delivery.iteration', error instanceof ApiError ? error.code : 'ORDER_SEND_FAILED');
    } finally {
      this.working = false;
    }
  }

  private async deliver(row: SendRow, now: Date) {
    if (row.queue_expires_at.getTime() <= now.getTime()) {
      await this.repository.finishBeforeIntent(row.send_id, { state: 'expired' }, now);
      return;
    }
    // A supplier request: its text to the supplier's phone (no file, no order).
    const supplier = row.target_kind === 'supplier' && row.form_code === SUPPLIER_TEXT_FORM && this.suppliers !== undefined;
    // A form of a newer release: never delivered by this one, no slot spent.
    if (!supplier && !isDeliverableForm(row.form_code)) {
      await this.repository.finishBeforeIntent(row.send_id, { state: 'failed', errorCode: 'ORDER_SEND_FORM_UNSUPPORTED' });
      return;
    }
    // A recipient kind of a newer release: never delivered by this one, no slot spent.
    if (!supplier && !['client', 'chat', 'employee'].includes(row.target_kind as string)) {
      await this.repository.finishBeforeIntent(row.send_id, { state: 'failed', errorCode: 'ORDER_SEND_TARGET_UNSUPPORTED' });
      return;
    }
    // An employee recipient goes only through a channel this release delivers (WhatsApp), before any provider call.
    if (row.target_kind === 'employee') {
      const channel = await this.repository.employeeRecipientChannel(row.recipient_key ?? null);
      if (channel === null || !ORDER_SEND_SUPPORTED_CHANNELS.includes(channel)) {
        await this.repository.finishBeforeIntent(row.send_id, { state: 'failed', errorCode: 'ORDER_SEND_CHANNEL_UNSUPPORTED' });
        return;
      }
    }
    // K4b-2: a send to a 1C phone of the client, while the feature is off (a step before a rollback), never reaches WAHA.
    const onecPhone = row.target_kind === 'client' && row.client_onec_contact_id != null;
    if (onecPhone && !this.repository.clientOnecPhoneEnabled()) {
      await this.repository.finishBeforeIntent(row.send_id, { state: 'cancelled', reason: 'disabled' });
      return;
    }
    if ((row.target_kind === 'client' || row.target_kind === 'employee' || supplier) && !row.destination_chat_id) {
      if (!row.phone_normalized) {
        await this.repository.finishBeforeIntent(row.send_id, { state: 'failed', errorCode: 'ORDER_SEND_PAYLOAD_MISSING' });
        return;
      }
      try {
        const phone = row.phone_normalized;
        // A supplier phone that is gone, or came from 1C data that may no longer be used, never reaches WAHA.
        // A 1C phone of the client: only while it may still be used by its author (K4b-2).
        let refused: OrderSendCancelReason | null = null;
        const check = supplier
          ? await (this.suppliers as SupplierSendRepository).whileContactUsable(row, () => this.waha.checkPhone(phone))
          : onecPhone
            ? await this.whileClientOnecPhoneUsable(row, () => this.waha.checkPhone(phone)).then((outcome) => {
              if ('reason' in outcome) { refused = outcome.reason; return null; }
              return outcome.value;
            })
            : await this.waha.checkPhone(phone);
        if (check === null) {
          await this.repository.finishBeforeIntent(row.send_id, { state: 'cancelled', reason: refused ?? 'recipient_removed' });
          return;
        }
        if (!check.exists || !check.chatId) {
          await this.repository.finishBeforeIntent(row.send_id, {
            state: 'failed', errorCode: supplier ? 'SUPPLIER_NOT_ON_WHATSAPP'
              : row.target_kind === 'employee' ? 'EMPLOYEE_NOT_ON_WHATSAPP' : 'CLIENT_NOT_ON_WHATSAPP' });
          return;
        }
        await this.repository.setClientDestination(row.send_id, check.chatId);
      } catch (error) {
        await this.repository.postpone(row.send_id, new Date(now.getTime() + WAHA_RETRY_MS), error instanceof ApiError ? error.code : 'WAHA_UNAVAILABLE');
        return;
      }
    }
    if (supplier) {
      const suppliers = this.suppliers as SupplierSendRepository;
      const intent = await this.repository.createIntent(row.send_id,
        (tx, current, settings) => suppliers.verify(tx, current, settings, (client, userId) => this.actors.load(client, userId)), this.clock);
      if (intent) await this.deliverTexts(row.send_id, intent);
      return;
    }
    const formCode = row.form_code as OrderFormCode;
    let bytes: Buffer;
    let partBytes: Map<number, Buffer>;
    try {
      const read = await this.store.withStoreLock(async (owned) => {
        const first = await this.store.read(row.file_key ?? '', row.sha256 ?? '', owned);
        const pages = new Map<number, Buffer>();
        for (const part of await this.repository.parts(row.send_id)) {
          pages.set(part.part_no, await this.store.read(part.file_key ?? '', part.sha256 ?? '', owned));
        }
        return { first, pages };
      });
      if (!read) return; // store busy: next iteration
      bytes = read.first;
      partBytes = read.pages;
    } catch {
      await this.repository.finishBeforeIntent(row.send_id, { state: 'failed', errorCode: 'ORDER_SEND_PAYLOAD_MISSING' });
      return;
    }
    const intent = await this.repository.createIntent(row.send_id, async (tx, current, settings): Promise<OrderSendCancelReason | null> => {
      const actor = await this.actors.load(tx, current.actor_id);
      // Locks held until the intent commits: the order (scope, client) and, for a client send, the
      // client row (blocks a new phone via the FK) and its phones (block edits and deletions).
      const subject = await readAccessSubject(tx, Number(current.order_id), true);
      if (!actor || !subject || !canSendOrder(actor, subject, formCode)) return 'permission_revoked';
      if (current.target_kind === 'chat') {
        const chat = current.chat_key ? await this.repository.chat(tx, current.chat_key) : null;
        if (!chat || chat.archived_at) return 'recipient_removed';
        if (chat.group_chat_id !== current.destination_chat_id) return 'recipient_changed';
        if (!knownForms(chat.forms).includes(formCode)) return 'form_not_allowed';
        return null;
      }
      if (current.target_kind === 'employee') {
        // The recipient row, the employee and the contact as they are now: anything different cancels.
        return this.repository.verifyEmployeeRecipient(tx, current);
      }
      if (!knownForms(settings.client_forms).includes(formCode)) return 'form_not_allowed';
      if (current.client_onec_contact_id != null) return this.repository.verifyClientOnecPhone(tx, current, actor);
      // A phone chosen in the command must still be that phone of the order's client; otherwise the default rule.
      const client = await this.repository.currentClientPhone(tx, Number(current.order_id),
        current.client_phone_id == null ? null : Number(current.client_phone_id));
      const sameClient = client && String(client.clientId ?? '') === String(current.client_id ?? '');
      let samePhone = false;
      try { samePhone = Boolean(client?.phone) && normalizeClientPhone(client?.phone) === current.phone_normalized; } catch { samePhone = false; }
      return sameClient && samePhone ? null : 'recipient_changed';
    }, this.clock);
    if (!intent) return;
    if (orderForm(formCode).format === 'png') {
      await this.deliverPictures(row.send_id, intent, bytes, partBytes);
      return;
    }
    try {
      const sent = await this.waha.sendFile(intent.destinationChatId, bytes, intent.fileName, ORDER_FORM_MIME[orderForm(formCode).format], intent.caption);
      await this.repository.settle(row.send_id, intent.token, sent.messageId
        ? { state: 'sent', providerMessageId: sent.messageId }
        : { state: 'unknown', errorCode: 'PROVIDER_ACK_MISSING_ID' });
    } catch (error) {
      await this.repository.settle(row.send_id, intent.token, failure(error));
    }
  }

  /**
   * The number check of WAHA for a send to a 1C phone of the client (K4b-2), made only while the phone may be used:
   * under the locks of client-onec-phone.ts (author → order → client → copy → 1C set) the author still may send the
   * order and see 1C data, the order still has this client, the copy is there with the same number and its 1C data
   * stay usable for ONEC_PHONE_CHECK_MARGIN_MS more by the wall clock. The rule holds when the request is made: the
   * locks are held at most ONEC_LOCKED_CALL_MS (a later answer fails this attempt — the send is postponed, nothing is
   * stored, the next attempt checks everything again); a request WAHA already got cannot be taken back.
   */
  private async whileClientOnecPhoneUsable<T>(row: SendRow, call: () => Promise<T>):
    Promise<{ value: T } | { reason: OrderSendCancelReason }> {
    return this.database.transaction(async (tx) => {
      await tx.query("SET LOCAL lock_timeout = '5s'");
      const actor = await this.actors.load(tx, row.actor_id);
      const subject = await readAccessSubject(tx, Number(row.order_id), true);
      if (!actor || !subject || !canSendOrder(actor, subject, row.form_code as OrderFormCode)) return { reason: 'permission_revoked' as const };
      const check = await checkQueuedClientOnecPhone(tx, {
        enabled: this.repository.clientOnecPhoneEnabled(), actor, orderId: Number(row.order_id), clientId: row.client_id,
        contactId: Number(row.client_onec_contact_id), phoneNormalized: row.phone_normalized, marginMs: ONEC_PHONE_CHECK_MARGIN_MS,
      });
      if (!check.ok) return { reason: check.reason };
      return { value: await withDeadline(call(), this.onecCallDeadlineMs) };
    });
  }

  /**
   * An image form: page 1 with the caption, then pages 2..N, one after another, never repeated.
   * Nothing sent → the WhatsApp outcome as for a file. Page 1 delivered and a later page not (or its
   * outcome unknown) → `unknown/PARTIAL_DELIVERY`: a repeat needs the explicit confirmation.
   */
  private async deliverPictures(sendId: string, intent: SendIntent, first: Buffer, pages: Map<number, Buffer>) {
    let firstId: string | undefined;
    try {
      firstId = (await this.waha.sendImage(intent.destinationChatId, first, imageName(intent.fileName, 1, intent.parts.length + 1), intent.caption)).messageId;
    } catch (error) {
      await this.repository.settle(sendId, intent.token, failure(error));
      return;
    }
    if (!firstId) {
      await this.repository.settle(sendId, intent.token, { state: 'unknown', errorCode: 'PROVIDER_ACK_MISSING_ID' });
      return;
    }
    let sent = 1;
    for (const part of intent.parts) {
      const bytes = pages.get(part.partNo);
      let messageId: string | undefined;
      try {
        if (!bytes) throw new ApiError(500, 'ORDER_SEND_PAYLOAD_MISSING', 'Страница формы не найдена');
        messageId = (await this.waha.sendImage(intent.destinationChatId, bytes, imageName(intent.fileName, part.partNo, intent.parts.length + 1), '')).messageId;
      } catch {
        messageId = undefined;
      }
      if (!messageId || !(await this.repository.recordPartSent(sendId, intent.token, part.partNo, messageId))) {
        await this.repository.settle(sendId, intent.token, { state: 'unknown', errorCode: 'PARTIAL_DELIVERY', providerMessageId: firstId },
          { partsSent: sent });
        return;
      }
      sent += 1;
    }
    await this.repository.settle(sendId, intent.token, { state: 'sent', providerMessageId: firstId }, { partsSent: sent });
  }

  /**
   * A supplier text: its messages one after another, never repeated. Nothing sent → the WhatsApp outcome as for
   * a file. The first message delivered and a later one not (or its outcome unknown) → `unknown/PARTIAL_DELIVERY`
   * with how many went: a repeat needs the explicit confirmation. The threshold slot is spent once per send.
   */
  private async deliverTexts(sendId: string, intent: SendIntent) {
    const messages = intent.texts ?? [];
    let firstId: string | undefined;
    try {
      firstId = (await this.waha.sendText(intent.destinationChatId, messages[0] ?? '')).messageId;
    } catch (error) {
      await this.repository.settle(sendId, intent.token, failure(error));
      return;
    }
    if (!firstId) {
      await this.repository.settle(sendId, intent.token, { state: 'unknown', errorCode: 'PROVIDER_ACK_MISSING_ID' });
      return;
    }
    let sent = 1;
    for (const [index, message] of messages.slice(1).entries()) {
      let messageId: string | undefined;
      try {
        messageId = (await this.waha.sendText(intent.destinationChatId, message)).messageId;
      } catch {
        messageId = undefined;
      }
      if (!messageId || !(await this.repository.recordPartSent(sendId, intent.token, index + 2, messageId))) {
        await this.repository.settle(sendId, intent.token, { state: 'unknown', errorCode: 'PARTIAL_DELIVERY', providerMessageId: firstId },
          { partsSent: sent });
        return;
      }
      sent += 1;
    }
    await this.repository.settle(sendId, intent.token, { state: 'sent', providerMessageId: firstId }, { partsSent: sent });
  }

  async cleanup(now = new Date()) {
    if (this.cleaning) return;
    this.cleaning = true;
    try {
      await this.store.withStoreLock(async (assertOwned) => {
        const { referenced, purgedKeys } = await this.repository.expireAndPurge(now);
        for (const key of purgedKeys) await this.store.remove(key, assertOwned).catch(() => undefined);
        await this.store.sweep(referenced, assertOwned, now);
      });
    } catch (error) {
      await this.log('error', 'whatsapp.order_send.cleanup', 'retention.cleanup', error instanceof ApiError ? error.code : 'ORDER_SEND_CLEANUP_FAILED');
    } finally {
      this.cleaning = false;
    }
  }

  /** A refused command: only codes, never a phone or group id. */
  async logRefusal(errorCode: string, details: Record<string, string | number | boolean | null>) {
    await this.log('warn', 'whatsapp.order_send.refused', 'order_send.command', errorCode, details);
  }

  private async log(level: 'warn' | 'error', eventCode: string, operation: string, errorCode: string, details?: Record<string, string | number | boolean | null>) {
    await this.technicalLogs?.record({ component: 'backend', level, eventCode, outcome: 'failed', operation, errorCode, details }).catch(() => undefined);
  }
}

/** The outcome of a failed WhatsApp call: a definite rejection fails, anything else is unknown. */
function failure(error: unknown): { state: 'failed' | 'unknown'; errorCode: string } {
  const status = error instanceof ApiError ? Number(error.details?.httpStatus) : NaN;
  const definite = error instanceof ApiError && error.code === 'WAHA_PROVIDER_ERROR' && DEFINITE_REJECTIONS.has(status);
  return definite
    ? { state: 'failed', errorCode: status === 501 || status === 415 ? 'WAHA_FILE_UNSUPPORTED' : 'WAHA_REJECTED' }
    : { state: 'unknown', errorCode: error instanceof ApiError ? error.code : 'WAHA_UNCERTAIN' };
}

function imageName(fileName: string, page: number, pages: number): string {
  const base = fileName.replace(/\.png$/i, '');
  return pages > 1 ? `${base} (${page} из ${pages}).png` : `${base}.png`;
}
