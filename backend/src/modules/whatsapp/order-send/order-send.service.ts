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
import { OrderSendRepository, knownForms, nextAllowed, numericId, type NewSend, type SendRow } from './order-send.repository';
import { OrderSendWorker } from './order-send-worker.service';
import {
  ORDER_FORMS, ORDER_SEND_FINANCIAL_PERMISSION, orderForm,
  type OrderFormCode, type OrderSendMenu, type OrderSendSettings, type OrderSendSettingsInput, type OrderSendTarget, type OrderSendView,
} from './order-send.types';

/** Refusals worth a technical trace and a refused-audit row (no phone, no group id). */
const REFUSALS = new Set(['ORDER_SEND_COOLDOWN', 'ORDER_SEND_ACTIVE', 'ORDER_SEND_DISABLED', 'ORDER_SEND_PAUSED', 'ORDER_SEND_FORM_NOT_ALLOWED',
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
    nextAllowedAt: string | null; activeSend: boolean; runtime: ReturnType<OrderSendWorker['runtime']> }> {
    const { lastDeliveryAt, ...settings } = await this.repository.getSettings();
    return { settings, forms: ORDER_FORMS, captionVariables: ORDER_SEND_CAPTION_VARIABLES,
      nextAllowedAt: allowedAtIso(lastDeliveryAt, settings.minIntervalMinutes), activeSend: await this.repository.activeSendExists(),
      runtime: this.worker.runtime() };
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
      runtime: this.worker.runtime(),
    };
  }

  async listForOrder(orderId: number, actor: CurrentUser): Promise<{ sends: OrderSendView[] }> {
    await this.assertOrderAccess(orderId, actor);
    return { sends: (await this.repository.listForOrder(orderId, 20)).map(toView) };
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
        let written: string | null = null;
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
              const stored = await this.store.write(generated.bytes, generated.extension, assertStoreOwned);
              written = stored.fileKey;
              const caption = renderOrderSendCaption(decision.chat ? decision.chat.caption : decision.settings.client_caption, {
                order_name: data.orderName, client: data.clientName ?? '', order_date: dateText(data.orderDate),
                completion_date: data.completionDate ? dateText(data.completionDate) : '', form: form.title,
              });
              return {
                sendId: randomUUID(), orderId, clientId: data.clientId, actor, requestId, idempotencyKey: input.idempotencyKey, fingerprint,
                targetKind: decision.chat ? 'chat' : 'client', chatKey: decision.chat?.chat_key ?? null, form: input.form,
                destinationChatId: decision.chat?.group_chat_id ?? null, phoneNormalized: phone,
                recipientMasked: decision.chat ? maskGroup(decision.chat.group_chat_id) : maskPhone(phone as string),
                fileKey: stored.fileKey, sha256: stored.sha256, sizeBytes: stored.sizeBytes, fileName: generated.fileName, caption,
              };
            },
          });
          kept = !outcome.replayed;
          return outcome;
        } finally {
          // Delete only a file that no committed row references: a COMMIT whose answer was lost
          // keeps the file (an unknown answer counts as referenced; the sweep handles true orphans).
          if (written && !kept) {
            const file = written;
            const referenced = await this.repository.fileReferenced(file).catch(() => true);
            if (!referenced) await this.store.remove(file, assertStoreOwned).catch(() => undefined);
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
      return { send: toView((await this.repository.getSend(result.row.send_id)) ?? result.row) };
    } catch (error) {
      if (error instanceof ApiError && REFUSALS.has(error.code)) await this.recordRefusal(orderId, input, actor, requestId, error);
      throw error;
    }
  }

  private async replay(actor: CurrentUser, idempotencyKey: string, fingerprint: string): Promise<{ send: OrderSendView } | null> {
    const row = await this.repository.findCommand(this.database, actor.id, idempotencyKey);
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Ключ запроса уже использован для другой отправки');
    return { send: toView((await this.repository.getSend(row.send_id)) ?? row) };
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

export function toView(row: SendRow): OrderSendView {
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
  };
}

function allowedAtIso(lastDeliveryAt: Date | null, minIntervalMinutes: number): string | null {
  const allowed = nextAllowed({ last_delivery_at: lastDeliveryAt, min_interval_minutes: minIntervalMinutes });
  return allowed && allowed.getTime() > Date.now() ? allowed.toISOString() : null;
}

function dateText(value: Date): string {
  const parts = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric' }).format(value);
  return parts;
}
