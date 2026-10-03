import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { generateOrderForm } from './forms';
import { readOrderFormData } from './forms/order-form-data';
import { canSendOrder, readAccessSubject } from './order-send-actors';
import { renderOrderSendCaption, ORDER_SEND_CAPTION_VARIABLES } from './order-send-caption';
import { OrderSendFileStore } from './order-send-file-store';
import { maskGroup, maskPhone, normalizeClientPhone } from './order-send-phone';
import { OrderSendRepository, knownForms, nextAllowed, numericId, type NewSend, type SendRow, type StoredPart } from './order-send.repository';
import type { QueueEstimate } from './order-send-queue';
import { OrderSendWorker } from './order-send-worker.service';
import {
  ORDER_FORMS, ORDER_SEND_FINANCIAL_PERMISSION, orderForm, orderFormTitle,
  type OrderFormCode, type OrderSendMenu, type OrderSendSettings, type OrderSendSettingsInput, type OrderSendTarget, type OrderSendView,
} from './order-send.types';

/** Refusals worth a technical trace and a refused-audit row (no phone, no group id). */
const REFUSALS = new Set(['ORDER_SEND_ALREADY_QUEUED', 'ORDER_SEND_QUEUE_FULL', 'ORDER_SEND_TOO_LONG', 'ORDER_SEND_DISABLED', 'ORDER_SEND_PAUSED', 'ORDER_SEND_FORM_NOT_ALLOWED',
  'ORDER_SEND_FINANCIALS_REQUIRED', 'ORDER_SEND_CHAT_UNKNOWN', 'CLIENT_PHONE_MISSING', 'CLIENT_PHONE_INVALID', 'ORDER_SEND_STORAGE_FULL',
  'ORDER_SEND_RENDER_FAILED', 'ORDER_SEND_FILE_TOO_LARGE', 'PERMISSION_DENIED', 'ORDER_NOT_FOUND', 'ORDER_SEND_PREVIOUS_UNKNOWN']);

@Injectable()
export class OrderSendService {
  constructor(
    @Inject(OrderSendRepository) private readonly repository: OrderSendRepository,
    @Inject(OrderSendFileStore) private readonly store: OrderSendFileStore,
    @Inject(OrderSendWorker) private readonly worker: OrderSendWorker,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async settings(): Promise<{ settings: OrderSendSettings; forms: typeof ORDER_FORMS; captionVariables: typeof ORDER_SEND_CAPTION_VARIABLES;
    nextAllowedAt: string | null; activeSend: boolean; queueLength: number; nextDeliveryAt: string | null;
    runtime: ReturnType<OrderSendWorker['runtime']> }> {
    const { lastDeliveryAt, ...settings } = await this.repository.getSettings();
    const queue = await this.repository.queueSnapshot();
    return { settings, forms: ORDER_FORMS, captionVariables: ORDER_SEND_CAPTION_VARIABLES,
      nextAllowedAt: allowedAtIso(lastDeliveryAt, settings.minIntervalMinutes), activeSend: queue.rows.length > 0,
      queueLength: queue.rows.length, nextDeliveryAt: firstEstimate(queue.estimates), runtime: this.worker.runtime() };
  }

  async updateSettings(input: OrderSendSettingsInput, actor: CurrentUser, requestId: string) {
    await this.repository.updateSettings(input, actor, requestId);
    return this.settings();
  }

  /** Menu of the order card: no group ids, forms filtered by the user's financial visibility. */
  async menu(actor: CurrentUser): Promise<OrderSendMenu> {
    const { lastDeliveryAt, ...settings } = await this.repository.getSettings();
    const financial = actor.permissions.includes(ORDER_SEND_FINANCIAL_PERMISSION);
    const visible = (forms: OrderFormCode[]) => forms.filter((code) => financial || !orderForm(code).financial);
    return {
      enabled: settings.enabled,
      forms: ORDER_FORMS.filter((form) => financial || !form.financial).map((form) => ({ code: form.code, title: form.title, financial: form.financial })),
      client: { forms: visible(settings.clientForms) },
      chats: settings.chats.map((chat) => ({ chatKey: chat.chatKey, label: chat.label, forms: visible(chat.forms) })).filter((chat) => chat.forms.length > 0),
      nextAllowedAt: allowedAtIso(lastDeliveryAt, settings.minIntervalMinutes),
      activeSend: await this.repository.activeSendExists(),
      queueLength: (await this.repository.queueSnapshot()).rows.length,
      runtime: this.worker.runtime(),
    };
  }

  /** «Очередь отправок из карточки» (whatsapp.manage): every waiting send, or the finished ones of 7 days. */
  async queue(options: { history: boolean; page: number }) {
    const snapshot = await this.repository.queueSnapshot();
    const base = {
      paused: snapshot.paused, enabled: snapshot.settings.enabled, minIntervalMinutes: snapshot.settings.min_interval_minutes,
      sendWindowMinutes: snapshot.settings.send_window_minutes, nextDeliveryAt: firstEstimate(snapshot.estimates),
      queueLength: snapshot.rows.length,
    };
    if (!options.history) {
      return { ...base, page: 1, pageSize: snapshot.rows.length, total: snapshot.rows.length,
        items: snapshot.rows.map((row) => toJournalItem(row, snapshot.estimates.get(row.send_id))) };
    }
    const pageSize = 50;
    const history = await this.repository.listHistory(options.page, pageSize);
    return { ...base, page: options.page, pageSize, total: history.total, items: history.rows.map((row) => toJournalItem(row, undefined)) };
  }

  /** Cancel of a waiting send by its author or a WhatsApp manager (see the repository for the rules). */
  async cancel(sendId: string, actor: CurrentUser, requestId: string): Promise<{ send: OrderSendView }> {
    const { row } = await this.repository.cancel(sendId, actor, requestId);
    return { send: await this.view(row.send_id, row) };
  }

  async listForOrder(orderId: number, actor: CurrentUser): Promise<{ sends: OrderSendView[] }> {
    await this.assertOrderAccess(orderId, actor);
    const rows = await this.repository.listForOrder(orderId, 20);
    const estimates = rows.some((row) => row.state === 'queued' || row.state === 'sending') ? (await this.repository.queueSnapshot()).estimates : new Map();
    return { sends: rows.map((row) => toView(row, estimates.get(row.send_id))) };
  }

  async send(orderId: number, input: { target: OrderSendTarget; form: OrderFormCode; idempotencyKey: string; confirmAfterUnknown?: string | null },
    actor: CurrentUser, requestId: string): Promise<{ send: OrderSendView }> {
    const fingerprint = createHash('sha256').update(JSON.stringify({ orderId, target: input.target, form: input.form,
      confirmAfterUnknown: input.confirmAfterUnknown ?? null })).digest('hex');
    try {
      // Access first (no ledger oracle for a foreign order), then the ledger before any preparation:
      // a lost response is replayed even if WhatsApp, the phone or the settings changed since.
      await this.assertOrderAccess(orderId, actor);
      const replay = await this.replay(actor, input.idempotencyKey, fingerprint);
      if (replay) return replay;
      const runtime = this.worker.runtime();
      if (!runtime.relayAvailable) throw new ApiError(503, 'BROADCAST_RUNTIME_UNAVAILABLE', runtime.unavailableReason ?? 'WhatsApp relay is unavailable');
      const result = await this.store.withStoreLock(async (assertStoreOwned) => {
        const written: string[] = [];
        let kept = false;
        try {
          const outcome = await this.repository.enqueue({
            actorId: actor.id, idempotencyKey: input.idempotencyKey, fingerprint,
            chatKey: input.target.kind === 'chat' ? input.target.chatKey : null,
            orderId, form: input.form, confirmAfterUnknown: input.confirmAfterUnknown ?? null,
            prepare: async (tx, decision): Promise<NewSend> => {
              const data = await readOrderFormData(tx, orderId);
              if (!data) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Заказ не найден');
              const subject = { orderId, managerUserId: data.managerId, createdByUserId: data.createdBy };
              if (!canSendOrder(actor, subject)) throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия');
              const form = orderForm(input.form);
              const financial = actor.permissions.includes(ORDER_SEND_FINANCIAL_PERMISSION);
              if (form.financial && !financial) {
                throw new ApiError(403, 'ORDER_SEND_FINANCIALS_REQUIRED', 'Форма с ценами доступна только при праве видеть финансы');
              }
              const allowed = decision.chat ? knownForms(decision.chat.forms) : knownForms(decision.settings.client_forms);
              if (!allowed.includes(input.form)) throw new ApiError(409, 'ORDER_SEND_FORM_NOT_ALLOWED', 'Эта форма не разрешена получателю в настройках');
              let phone: string | null = null;
              if (!decision.chat) phone = normalizeClientPhone(data.clientPhone);
              const generated = await generateOrderForm(data, input.form, financial);
              const stored: StoredPart[] = [];
              for (const page of generated.pages) {
                const file = await this.store.write(page, generated.extension, assertStoreOwned);
                written.push(file.fileKey);
                stored.push(file);
              }
              const caption = renderOrderSendCaption(decision.chat ? decision.chat.caption : decision.settings.client_caption, {
                order_name: data.orderName, client: data.clientName ?? '', order_date: dateText(data.orderDate),
                completion_date: data.completionDate ? dateText(data.completionDate) : '', form: form.title,
              });
              return {
                sendId: randomUUID(), orderId, clientId: data.clientId, actor, requestId, idempotencyKey: input.idempotencyKey, fingerprint,
                targetKind: decision.chat ? 'chat' : 'client', chatKey: decision.chat?.chat_key ?? null, form: input.form,
                destinationChatId: decision.chat?.group_chat_id ?? null, phoneNormalized: phone,
                recipientMasked: decision.chat ? maskGroup(decision.chat.group_chat_id) : maskPhone(phone as string),
                fileKey: stored[0].fileKey, sha256: stored[0].sha256, sizeBytes: stored[0].sizeBytes, fileName: generated.fileName, caption,
                parts: stored.slice(1),
              };
            },
          });
          kept = !outcome.replayed;
          return outcome;
        } finally {
          // Delete only a file that no committed row references: a COMMIT whose answer was lost
          // keeps the file (an unknown answer counts as referenced; the sweep handles true orphans).
          if (!kept) {
            for (const file of written) {
              const referenced = await this.repository.fileReferenced(file).catch(() => true);
              if (!referenced) await this.store.remove(file, assertStoreOwned).catch(() => undefined);
            }
          }
        }
      });
      if (!result) {
        // Another card send holds the store (possibly the same key in flight): replay if it committed.
        const committed = await this.replay(actor, input.idempotencyKey, fingerprint);
        if (committed) return committed;
        throw new ApiError(503, 'ORDER_SEND_BUSY', 'Отправка из карточки занята; повторите запрос');
      }
      void this.worker.kick();
      return { send: await this.view(result.row.send_id, result.row) };
    } catch (error) {
      if (error instanceof ApiError && REFUSALS.has(error.code)) await this.recordRefusal(orderId, input, actor, requestId, error);
      throw error;
    }
  }

  private async replay(actor: CurrentUser, idempotencyKey: string, fingerprint: string): Promise<{ send: OrderSendView } | null> {
    const row = await this.repository.findCommand(this.database, actor.id, idempotencyKey);
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Ключ запроса уже использован для другой отправки');
    return { send: await this.view(row.send_id, row) };
  }

  /** The view of one send with its place in the queue and «≈ когда» while it waits. */
  private async view(sendId: string, fallback: SendRow): Promise<OrderSendView> {
    const row = (await this.repository.getSend(sendId)) ?? fallback;
    const estimate = row.state === 'queued' || row.state === 'sending' ? (await this.repository.queueSnapshot()).estimates.get(sendId) : undefined;
    return toView(row, estimate);
  }

  private async assertOrderAccess(orderId: number, actor: CurrentUser) {
    const subject = await readAccessSubject(this.database, orderId);
    if (!subject) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Заказ не найден');
    if (!canSendOrder(actor, subject)) throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия');
  }

  /** Refused command: its own committed row (the command transaction rolled back), no recipient data. */
  private async recordRefusal(orderId: number, input: { target: OrderSendTarget; form: OrderFormCode }, actor: CurrentUser, requestId: string,
    error: ApiError) {
    await auditService.record(this.database, {
      event: 'whatsapp.order_send.refused', entityType: 'order', entityId: orderId,
      actorUserId: numericId(actor.id), actorUsername: actor.username, actorRole: actor.role, requestId, source: 'erp_whatsapp_order_send',
      relatedOrderId: orderId, statusCode: error.code,
      metadata: { targetKind: input.target.kind, chatKey: input.target.kind === 'chat' ? input.target.chatKey : null, form: input.form,
        errorCode: error.code, source: 'order_card' },
    }).catch(() => undefined);
    await this.worker.logRefusal(error.code, { orderId, targetKind: input.target.kind, form: input.form });
  }
}

export function toView(row: SendRow, estimate?: QueueEstimate): OrderSendView {
  return {
    sendId: row.send_id,
    orderId: Number(row.order_id),
    targetKind: row.target_kind,
    chatKey: row.chat_key,
    recipientLabel: row.target_kind === 'client' ? 'Клиент' : row.chat_label ?? 'Чат',
    recipientMasked: row.recipient_masked,
    form: row.form_code,
    state: row.state,
    errorCode: row.error_code,
    cancelReason: row.cancel_reason,
    createdAt: row.created_at.toISOString(),
    sentAt: row.sent_at ? row.sent_at.toISOString() : null,
    actor: { id: String(row.actor_id), username: row.actor_username ?? null },
    partsTotal: row.parts_total ?? 1,
    position: estimate?.position ?? null,
    estimatedAt: estimate ? estimate.estimatedAt.toISOString() : null,
    mayExpire: estimate?.mayExpire ?? false,
    expiresAt: row.queue_expires_at.toISOString(),
  };
}

/** A journal line: the view plus the order and who cancelled; no phone or group id (only masks). */
function toJournalItem(row: SendRow, estimate: QueueEstimate | undefined) {
  return {
    ...toView(row, estimate),
    orderName: row.order_name ?? null,
    formTitle: orderFormTitle(row.form_code),
    finishedAt: row.state === 'queued' || row.state === 'sending' ? null : (row.sent_at ?? row.updated_at).toISOString(),
    cancelledBy: row.cancelled_by ? { id: String(row.cancelled_by), username: row.cancelled_by_username ?? null } : null,
  };
}

function firstEstimate(estimates: Map<string, QueueEstimate>): string | null {
  const next = [...estimates.values()].filter((item) => !item.mayExpire).sort((a, b) => a.estimatedAt.getTime() - b.estimatedAt.getTime())[0];
  return next ? next.estimatedAt.toISOString() : null;
}

function allowedAtIso(lastDeliveryAt: Date | null, minIntervalMinutes: number): string | null {
  const allowed = nextAllowed({ last_delivery_at: lastDeliveryAt, min_interval_minutes: minIntervalMinutes });
  return allowed && allowed.getTime() > Date.now() ? allowed.toISOString() : null;
}

function dateText(value: Date): string {
  const parts = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric' }).format(value);
  return parts;
}
