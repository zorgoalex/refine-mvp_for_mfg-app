import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import { WahaClient } from '../waha.client';
import { WhatsAppRuntimeConfigService } from '../whatsapp-runtime-config.service';
import { WhatsAppTechnicalLogService } from '../whatsapp-technical-log.service';
import { canSendOrder, OrderSendActors, readAccessSubject } from './order-send-actors';
import { OrderSendFileStore } from './order-send-file-store';
import { normalizeClientPhone } from './order-send-phone';
import { OrderSendRepository, knownForms, type SendRow } from './order-send.repository';
import { ORDER_FORM_MIME, orderForm, type OrderSendCancelReason, type OrderSendRuntime } from './order-send.types';

/** WAHA refused the request itself (validation, unsupported): nothing was sent. */
const DEFINITE_REJECTIONS = new Set([400, 404, 405, 415, 422, 501]);
const WAHA_RETRY_MS = 60_000;

/**
 * Delivery of «отправка заказа из карточки». One send at a time (the command allows a single
 * active send): resolve the client chat id, re-check rights and recipient, pass the system-wide
 * frequency gate, send the file, settle conditionally. Retention runs on its own timer.
 */
@Injectable()
export class OrderSendWorker implements OnModuleInit, OnModuleDestroy {
  /** Time of the gate, TTL and intent: read after the intent locks are held, never the iteration start. */
  clock: () => Date = () => new Date();
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
    if (row.target_kind === 'client' && !row.destination_chat_id) {
      if (!row.phone_normalized) {
        await this.repository.finishBeforeIntent(row.send_id, { state: 'failed', errorCode: 'ORDER_SEND_PAYLOAD_MISSING' });
        return;
      }
      try {
        const check = await this.waha.checkPhone(row.phone_normalized);
        if (!check.exists || !check.chatId) {
          await this.repository.finishBeforeIntent(row.send_id, { state: 'failed', errorCode: 'CLIENT_NOT_ON_WHATSAPP' });
          return;
        }
        await this.repository.setClientDestination(row.send_id, check.chatId);
      } catch (error) {
        await this.repository.postpone(row.send_id, new Date(now.getTime() + WAHA_RETRY_MS), error instanceof ApiError ? error.code : 'WAHA_UNAVAILABLE');
        return;
      }
    }
    let bytes: Buffer;
    try {
      const read = await this.store.withStoreLock((owned) => this.store.read(row.file_key ?? '', row.sha256 ?? '', owned));
      if (!read) return; // store busy: next iteration
      bytes = read;
    } catch {
      await this.repository.finishBeforeIntent(row.send_id, { state: 'failed', errorCode: 'ORDER_SEND_PAYLOAD_MISSING' });
      return;
    }
    const intent = await this.repository.createIntent(row.send_id, async (tx, current, settings): Promise<OrderSendCancelReason | null> => {
      const actor = await this.actors.load(tx, current.actor_id);
      // Locks held until the intent commits: the order (scope, client) and, for a client send, the
      // client row (blocks a new phone via the FK) and its phones (block edits and deletions).
      const subject = await readAccessSubject(tx, Number(current.order_id), true);
      if (!actor || !subject || !canSendOrder(actor, subject, current.form_code)) return 'permission_revoked';
      if (current.target_kind === 'chat') {
        const chat = current.chat_key ? await this.repository.chat(tx, current.chat_key) : null;
        if (!chat || chat.archived_at) return 'recipient_removed';
        if (chat.group_chat_id !== current.destination_chat_id) return 'recipient_changed';
        if (!knownForms(chat.forms).includes(current.form_code)) return 'form_not_allowed';
        return null;
      }
      if (!knownForms(settings.client_forms).includes(current.form_code)) return 'form_not_allowed';
      const client = await this.repository.currentClientPhone(tx, Number(current.order_id));
      const sameClient = client && String(client.clientId ?? '') === String(current.client_id ?? '');
      let samePhone = false;
      try { samePhone = Boolean(client?.phone) && normalizeClientPhone(client?.phone) === current.phone_normalized; } catch { samePhone = false; }
      return sameClient && samePhone ? null : 'recipient_changed';
    }, this.clock);
    if (!intent) return;
    try {
      const sent = await this.waha.sendFile(intent.destinationChatId, bytes, intent.fileName, ORDER_FORM_MIME[orderForm(intent.form).format], intent.caption);
      await this.repository.settle(row.send_id, intent.token, sent.messageId
        ? { state: 'sent', providerMessageId: sent.messageId }
        : { state: 'unknown', errorCode: 'PROVIDER_ACK_MISSING_ID' });
    } catch (error) {
      const status = error instanceof ApiError ? Number(error.details?.httpStatus) : NaN;
      const definite = error instanceof ApiError && error.code === 'WAHA_PROVIDER_ERROR' && DEFINITE_REJECTIONS.has(status);
      await this.repository.settle(row.send_id, intent.token, definite
        ? { state: 'failed', errorCode: status === 501 || status === 415 ? 'WAHA_FILE_UNSUPPORTED' : 'WAHA_REJECTED' }
        : { state: 'unknown', errorCode: error instanceof ApiError ? error.code : 'WAHA_UNCERTAIN' });
    }
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
