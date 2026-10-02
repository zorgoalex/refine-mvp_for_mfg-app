import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/apiError';
import type { OrderSendResponse } from '../../api/orderSendApiTypes';
import {
  ORDER_SEND_UNCERTAIN_TEXT,
  orderSendErrorToast,
  orderSendSuccessToast,
  pendingOrderSendKey,
  readPendingOrderSend,
  runOrderSend,
} from './whatsappOrderSendModel';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}
const apiError = (status: number, code: string, details?: unknown) => new ApiError({ code, message: code, status, details });
const ok = { send: { sendId: 's1', state: 'queued', errorCode: null, cancelReason: null } } as unknown as OrderSendResponse;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const chat = { kind: 'chat' as const, chatKey: 'c1' };
const KEY = 'broadcast.pending-order-send.v1.77.chat-c1.order_pdf';
const base = { orderId: 77, target: chat, form: 'order_pdf' as const, actorId: '11', targetLabel: 'в чат «ЧПУ»', formTitle: 'PDF заказа' };

describe('order send toasts', () => {
  it('formats the cooldown with the Almaty time', () => {
    expect(orderSendErrorToast(apiError(409, 'ORDER_SEND_COOLDOWN', { nextAllowedAt: '2026-10-01T07:30:00Z', minIntervalMinutes: 15 }))).toEqual({
      type: 'warning', text: 'Отправлять из карточек можно не чаще раза в 15 мин. Следующая отправка из карточек — не раньше 12:30',
    });
    expect(orderSendErrorToast(apiError(409, 'ORDER_SEND_COOLDOWN', { nextAllowedAt: '2026-10-01T07:30:00Z' })).text).toBe('Следующая отправка из карточек — не раньше 12:30');
  });

  it('maps the known codes and falls back safely', () => {
    expect(orderSendErrorToast(apiError(409, 'ORDER_SEND_ACTIVE')).text).toBe('Предыдущая отправка ещё выполняется, повторите через минуту');
    expect(orderSendErrorToast(apiError(422, 'CLIENT_PHONE_MISSING')).text).toBe('У клиента нет телефона');
    expect(orderSendErrorToast(apiError(422, 'CLIENT_PHONE_INVALID')).text).toContain('Телефон клиента');
    expect(orderSendErrorToast(apiError(409, 'ORDER_SEND_DISABLED')).type).toBe('warning');
    expect(orderSendErrorToast(apiError(503, 'BROADCAST_RUNTIME_UNAVAILABLE')).text).toBe('WhatsApp сейчас недоступен');
    expect(orderSendErrorToast(apiError(403, 'PERMISSION_DENIED')).type).toBe('error');
    for (const code of ['ORDER_SEND_PAUSED', 'ORDER_SEND_FORM_NOT_ALLOWED', 'ORDER_SEND_FINANCIALS_REQUIRED', 'ORDER_SEND_CHAT_UNKNOWN', 'IDEMPOTENCY_KEY_REUSED', 'ORDER_SEND_STORAGE_FULL', 'ORDER_SEND_RENDER_FAILED']) {
      expect(orderSendErrorToast(apiError(409, code)).text.length).toBeGreaterThan(10);
    }
    expect(orderSendErrorToast(apiError(500, 'INTERNAL_ERROR')).text).toBe(ORDER_SEND_UNCERTAIN_TEXT);
    expect(orderSendErrorToast(new TypeError('network')).text).toBe(ORDER_SEND_UNCERTAIN_TEXT);
    expect(orderSendErrorToast(apiError(422, 'WEIRD')).type).toBe('error');
  });

  it('words the success toast', () => {
    expect(orderSendSuccessToast('клиенту', 'PDF заказа').text).toBe('Заказ поставлен в очередь на отправку: клиенту (PDF заказа)');
  });
});

describe('runOrderSend', () => {
  it('stores the key before sending, posts target+form+uuid and clears it on success', async () => {
    const storage = memoryStorage();
    const send = vi.fn(async () => {
      expect(JSON.parse(storage.data.get(KEY) as string).ambiguous).toBe(true);
      return ok;
    });
    const toast = await runOrderSend({ ...base, send, storage });
    expect(toast).toEqual({ type: 'success', text: 'Заказ поставлен в очередь на отправку: в чат «ЧПУ» (PDF заказа)' });
    const [orderId, body] = send.mock.calls[0] as unknown as [number, { target: unknown; form: string; idempotencyKey: string }];
    expect(orderId).toBe(77);
    expect(body).toMatchObject({ target: chat, form: 'order_pdf' });
    expect(body.idempotencyKey).toMatch(UUID);
    expect(storage.data.has(KEY)).toBe(false);
  });

  it('keeps the key after an uncertain answer and replays it', async () => {
    const storage = memoryStorage();
    const first = await runOrderSend({ ...base, send: async () => { throw apiError(500, 'INTERNAL_ERROR'); }, storage });
    expect(first?.text).toBe(ORDER_SEND_UNCERTAIN_TEXT);
    const stored = readPendingOrderSend(77, chat, 'order_pdf', '11', storage);
    expect(stored?.ambiguous).toBe(true);
    const send = vi.fn(async () => ok);
    await runOrderSend({ ...base, send, storage });
    expect((send.mock.calls[0] as unknown as [number, { idempotencyKey: string }])[1].idempotencyKey).toBe(stored?.payload.idempotencyKey);
    expect(storage.data.has(KEY)).toBe(false);
  });

  it('drops the key on a first-attempt refusal (cooldown) and keeps it after an ambiguous attempt', async () => {
    const storage = memoryStorage();
    const refused = await runOrderSend({ ...base, send: async () => { throw apiError(409, 'ORDER_SEND_COOLDOWN', { nextAllowedAt: '2026-10-01T07:30:00Z' }); }, storage });
    expect(refused?.type).toBe('warning');
    expect(storage.data.has(KEY)).toBe(false);

    await runOrderSend({ ...base, send: async () => { throw apiError(500, 'X'); }, storage });
    await runOrderSend({ ...base, send: async () => { throw apiError(409, 'ORDER_SEND_COOLDOWN'); }, storage });
    expect(storage.data.has(KEY)).toBe(true);
    await runOrderSend({ ...base, send: async () => { throw apiError(409, 'IDEMPOTENCY_KEY_REUSED'); }, storage });
    expect(storage.data.has(KEY)).toBe(false);
  });

  it('does not send when the key cannot be stored', async () => {
    const send = vi.fn(async () => ok);
    const toast = await runOrderSend({ ...base, send, storage: null });
    expect(send).not.toHaveBeenCalled();
    expect(toast?.type).toBe('error');
  });

  it('ignores a second click while the same send is in flight, but not another form', async () => {
    const storage = memoryStorage();
    let release: () => void = () => undefined;
    const send = vi.fn(() => new Promise<OrderSendResponse>((resolve) => { release = () => resolve(ok); }));
    const first = runOrderSend({ ...base, send, storage });
    expect(await runOrderSend({ ...base, send, storage })).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    const other = runOrderSend({ ...base, form: 'production_pdf', send: async () => ok, storage });
    expect((await other)?.type).toBe('success');
    release();
    expect((await first)?.type).toBe('success');
  });

  it('builds the per order+target+form key and ignores a stored key of another actor or form', () => {
    expect(pendingOrderSendKey(77, { kind: 'client' }, 'production_pdf')).toBe('broadcast.pending-order-send.v1.77.client.production_pdf');
    const storage = memoryStorage({ [KEY]: JSON.stringify({ actorId: '11', orderId: 77, ambiguous: true, payload: { target: chat, form: 'order_pdf', idempotencyKey: '3f1c9a62-6e0c-4b7a-9a43-1d9f6a6d2b11' } }) });
    expect(readPendingOrderSend(77, chat, 'order_pdf', '11', storage)).not.toBeNull();
    expect(readPendingOrderSend(77, chat, 'order_pdf', '12', storage)).toBeNull();
  });
});

describe('order send result as the server returned it', () => {
  it('maps every state to its toast', async () => {
    const { orderSendStateToast, ORDER_SEND_UNKNOWN_TEXT } = await import('./whatsappOrderSendModel');
    const toast = (state: string, errorCode: string | null = null, cancelReason: string | null = null) =>
      orderSendStateToast({ state, errorCode, cancelReason }, 'клиенту', 'PDF заказа');
    expect(toast('queued')).toEqual({ type: 'success', text: 'Заказ поставлен в очередь на отправку: клиенту (PDF заказа)' });
    expect(toast('sent')).toEqual({ type: 'success', text: 'Заказ отправлен: клиенту (PDF заказа)' });
    expect(toast('failed', 'CLIENT_NOT_ON_WHATSAPP').text).toContain('номера клиента нет в WhatsApp');
    expect(toast('cancelled', null, 'recipient_changed')).toMatchObject({ type: 'warning' });
    expect(toast('expired').text).toContain('истёк срок');
    expect(toast('unknown').text).toContain(ORDER_SEND_UNKNOWN_TEXT);
  });

  it('a replayed final send is reported as final and is not followed', async () => {
    const { runOrderSend } = await import('./whatsappOrderSendModel');
    const memory = new Map<string, string>();
    const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); },
      removeItem: (key: string) => { memory.delete(key); } };
    const followed: string[] = [];
    const result = await runOrderSend({
      orderId: 7, target: { kind: 'client' }, form: 'order_pdf', actorId: '11', targetLabel: 'клиенту', formTitle: 'PDF заказа', storage,
      send: async () => ({ send: { sendId: 's1', orderId: 7, targetKind: 'client', chatKey: null, recipientLabel: 'Клиент', recipientMasked: '7701***2060',
        form: 'order_pdf', state: 'unknown', errorCode: 'PROVIDER_ACK_MISSING_ID', cancelReason: null, createdAt: '', sentAt: null, actor: { id: '11', username: null } } }),
      onQueued: (send) => followed.push(send.sendId),
    });
    expect(result?.type).toBe('warning');
    expect(followed).toEqual([]);
  });

  it('follows a queued send until it is final', async () => {
    const { watchOrderSend } = await import('./whatsappOrderSendModel');
    const states = ['queued', 'sending', 'failed'];
    const final = await watchOrderSend({ orderId: 7, sendId: 's1', intervalMs: 1, timeoutMs: 5000, sleep: async () => undefined,
      list: async () => ({ sends: [{ sendId: 's1', state: states.shift() ?? 'failed', errorCode: 'CLIENT_NOT_ON_WHATSAPP' } as never] }) });
    expect(final?.state).toBe('failed');
  });
});

describe('a repeat after an unknown outcome is decided by the server', () => {
  const memoryStore = () => {
    const memory = new Map<string, string>();
    return { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); },
      removeItem: (key: string) => { memory.delete(key); } };
  };
  const PREVIOUS = '1b4e28ba-2fa1-4d2b-883f-0016d3cca427';

  it('a 409 ORDER_SEND_PREVIOUS_UNKNOWN asks for a confirmation and drops the key; the confirmed run sends the previous id', async () => {
    const model = await import('./whatsappOrderSendModel');
    const storage = memoryStore();
    const bodies: Array<Record<string, unknown>> = [];
    const base = { orderId: 7, target: { kind: 'client' as const }, form: 'order_pdf' as const, actorId: '11', targetLabel: 'клиенту', formTitle: 'PDF заказа', storage };
    const refused = await model.runOrderSend({ ...base, send: async (_id, body) => {
      bodies.push(body as never);
      throw apiError(409, 'ORDER_SEND_PREVIOUS_UNKNOWN', { sendId: PREVIOUS, createdAt: '2026-10-01T07:30:00Z' });
    } });
    expect(refused?.confirmUnknown).toEqual({ sendId: PREVIOUS, createdAt: '2026-10-01T07:30:00Z' });
    expect(refused?.text).toContain('в 12:30');
    expect(model.readPendingOrderSend(7, base.target, 'order_pdf', '11', storage)).toBeNull();
    const confirmed = await model.runOrderSend({ ...base, confirmAfterUnknown: PREVIOUS, send: async (_id, body) => {
      bodies.push(body as never);
      return { send: { sendId: 's2', state: 'queued', errorCode: null, cancelReason: null } as never };
    } });
    expect(confirmed?.type).toBe('success');
    expect(bodies[1]).toMatchObject({ confirmAfterUnknown: PREVIOUS });
    expect(bodies[1].idempotencyKey).not.toBe(bodies[0].idempotencyKey);
  });

  it('the refusal is final even after an ambiguous earlier attempt of the key (the server checked the ledger first)', async () => {
    const model = await import('./whatsappOrderSendModel');
    const storage = memoryStore();
    const base = { orderId: 7, target: { kind: 'client' as const }, form: 'order_pdf' as const, actorId: '11', targetLabel: 'клиенту', formTitle: 'PDF заказа', storage };
    await model.runOrderSend({ ...base, send: async () => { throw new TypeError('network'); } });
    expect(model.readPendingOrderSend(7, base.target, 'order_pdf', '11', storage)?.ambiguous).toBe(true);
    const refused = await model.runOrderSend({ ...base, send: async () => { throw apiError(409, 'ORDER_SEND_PREVIOUS_UNKNOWN', { sendId: PREVIOUS }); } });
    expect(refused?.confirmUnknown?.sendId).toBe(PREVIOUS);
    expect(model.readPendingOrderSend(7, base.target, 'order_pdf', '11', storage)).toBeNull();
  });

  it('a follow that times out says the result is not confirmed', async () => {
    const model = await import('./whatsappOrderSendModel');
    const toast = await model.followOrderSend({ orderId: 7, sendId: 's1', targetLabel: 'клиенту', formTitle: 'PDF заказа', intervalMs: 1, timeoutMs: 5,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 2)), list: async () => ({ sends: [{ sendId: 's1', state: 'sending' } as never] }) });
    expect(toast.text).toContain(model.ORDER_SEND_NOT_CONFIRMED_TEXT);
  });

  it('a late answer of an earlier POST does not clear the pending key of a newer command of the same form', async () => {
    const model = await import('./whatsappOrderSendModel');
    const storage = memoryStore();
    const target = { kind: 'client' as const };
    let release: () => void = () => undefined;
    const run = model.runOrderSend({ orderId: 7, target, form: 'order_pdf', actorId: '11', targetLabel: 'клиенту', formTitle: 'PDF заказа', storage,
      send: async () => { await new Promise<void>((resolve) => { release = resolve; }); return { send: { sendId: 'A', state: 'sent', errorCode: null, cancelReason: null } as never }; } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const newer = { actorId: '11', orderId: 7, payload: { target, form: 'order_pdf' as const, idempotencyKey: PREVIOUS }, ambiguous: true };
    model.persistPendingOrderSend(newer, storage);
    release();
    await run;
    expect(model.readPendingOrderSend(7, target, 'order_pdf', '11', storage)?.payload.idempotencyKey).toBe(PREVIOUS);
  });
});
