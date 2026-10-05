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
    get length() { return data.size; },
    key: (index: number) => [...data.keys()][index] ?? null,
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

  it('a lost answer is replayed with the stored command exactly — the old token or none — whatever the menu says now', async () => {
    const T1 = 'a'.repeat(64);
    const T2 = 'b'.repeat(64);
    for (const [first, later] of [
      // an older interface sent an employee contact without a token; the new one would add it
      [{ kind: 'employee' as const, recipientKey: 'e1', contactId: 7 }, { kind: 'employee' as const, recipientKey: 'e1', contactId: 7, contactToken: T2 }],
      // the client phone row was edited after the first attempt: the menu now gives another token
      [{ kind: 'client' as const, phoneId: 12, phoneToken: T1 }, { kind: 'client' as const, phoneId: 12, phoneToken: T2 }],
    ]) {
      const storage = memoryStorage();
      await runOrderSend({ ...base, target: first, send: async () => { throw apiError(500, 'INTERNAL_ERROR'); }, storage });
      const send = vi.fn(async () => ok);
      await runOrderSend({ ...base, target: later, send, storage });
      const body = (send.mock.calls[0] as unknown as [number, { target: unknown; idempotencyKey: string }])[1];
      expect(body.target).toEqual(first);
      expect(body.idempotencyKey).toMatch(UUID);
      expect(readPendingOrderSend(77, later, 'order_pdf', '11', storage)).toBeNull();
    }
    // A stored target that is not a valid one is not replayed at all.
    const storage = memoryStorage();
    storage.setItem(pendingOrderSendKey(77, { kind: 'client', phoneId: 12 }, 'order_pdf'), JSON.stringify({ actorId: '11', orderId: 77, ambiguous: true,
      payload: { target: { kind: 'client', phoneId: 'x' }, form: 'order_pdf', idempotencyKey: '11111111-1111-4111-8111-111111111111' } }));
    expect(readPendingOrderSend(77, { kind: 'client', phoneId: 12 }, 'order_pdf', '11', storage)).toBeNull();
  });

  it('a command left by the previous interface in its own slot is settled, not lost: no second command, however many slots', async () => {
    // The literal keys of the previous interface: one slot per employee contact.
    const legacy = (contact: string) => `broadcast.pending-order-send.v1.77.employee-e1-${contact}.order_pdf`;
    const record = (target: unknown, key: string) => JSON.stringify({ actorId: '11', orderId: 77, ambiguous: true,
      payload: { target, form: 'order_pdf', idempotencyKey: key } });
    const K1 = '11111111-1111-4111-8111-111111111111';
    const K2 = '22222222-2222-4222-8222-222222222222';
    const storage = memoryStorage({
      [legacy('primary')]: record({ kind: 'employee', recipientKey: 'e1' }, K1),
      [legacy('8')]: record({ kind: 'employee', recipientKey: 'e1', contactId: 8 }, K2),
    });
    // The sends were delivered meanwhile; the new interface clicks the employee with a token.
    const clicked = { kind: 'employee' as const, recipientKey: 'e1', contactId: 8, contactToken: 'd'.repeat(64) };
    const sent = { send: { sendId: 's-old', state: 'sent', errorCode: null, cancelReason: null, recipientMasked: '7701***0102' } } as never;
    const send = vi.fn(async () => sent);
    await runOrderSend({ ...base, target: clicked, send, storage });
    await runOrderSend({ ...base, target: clicked, send, storage });
    const bodies = (send.mock.calls as unknown as Array<[number, { target: unknown; idempotencyKey: string }]>).map(([, body]) => body);
    // Each click settled one stored command with its own key and its own target (no token added).
    expect(bodies.map((body) => body.idempotencyKey).sort()).toEqual([K1, K2]);
    expect(bodies.map((body) => body.target)).toEqual(expect.arrayContaining([{ kind: 'employee', recipientKey: 'e1' }, { kind: 'employee', recipientKey: 'e1', contactId: 8 }]));
    expect([...storage.data.keys()]).toEqual([]);
    // Only now a click makes a new command.
    await runOrderSend({ ...base, target: clicked, send, storage });
    expect(bodies.length).toBe(2);
    expect((send.mock.calls[2] as unknown as [number, { target: unknown; idempotencyKey: string }])[1]).toMatchObject({ target: clicked });
    expect([K1, K2]).not.toContain((send.mock.calls[2] as unknown as [number, { idempotencyKey: string }])[1].idempotencyKey);
    // Storage that cannot be listed: the well-known slots of the clicked contact and of «primary» are still found.
    const plain = memoryStorage({ [legacy('8')]: record({ kind: 'employee', recipientKey: 'e1', contactId: 8 }, K2) });
    const bare = { getItem: plain.getItem, setItem: plain.setItem, removeItem: plain.removeItem };
    expect(readPendingOrderSend(77, clicked, 'order_pdf', '11', bare)?.payload.idempotencyKey).toBe(K2);
  });

  it('a replay names the number from the server answer even when the same phone row now shows another number', async () => {
    const T1 = 'a'.repeat(64);
    const storage = memoryStorage();
    const target = { kind: 'client' as const, phoneId: 12, phoneToken: T1 };
    await runOrderSend({ ...base, target, targetLabel: 'клиенту (7777***0001)', send: async () => { throw apiError(500, 'INTERNAL_ERROR'); }, storage });
    // The row was edited: the menu shows a new mask and gives a new token; the replay returns the old send.
    const answer = { send: { sendId: 's1', state: 'sent', errorCode: null, cancelReason: null, recipientMasked: '7777***0001' } } as never;
    const toast = await runOrderSend({ ...base, target: { kind: 'client', phoneId: 12, phoneToken: 'b'.repeat(64) }, targetLabel: 'клиенту (7777***0009)',
      send: async () => answer, storage });
    expect(toast?.text).toContain('клиенту (7777***0001)');
    expect(toast?.text).not.toContain('0009');
  });

  it('a lost answer, then a refusal the server recorded as final: the pending command is dropped and a fresh choice makes a new one', async () => {
    // The phone was edited, removed, or the release makes no chosen-phone sends: the server keeps the refusal with the key.
    for (const refusal of ['ORDER_SEND_PHONE_CHANGED', 'ORDER_SEND_PHONE_CHOICE_UNAVAILABLE', 'CLIENT_PHONE_MISSING']) {
      const storage = memoryStorage();
      const stale = { kind: 'client' as const, phoneId: 12, phoneToken: 'a'.repeat(64) };
      await runOrderSend({ ...base, target: stale, send: async () => { throw apiError(500, 'INTERNAL_ERROR'); }, storage });
      const firstKey = readPendingOrderSend(77, stale, 'order_pdf', '11', storage)?.payload.idempotencyKey;
      const refused = await runOrderSend({ ...base, target: stale, send: async () => { throw apiError(409, refusal, { final: true }); }, storage });
      expect(refused).toMatchObject({ refreshRecipients: true });
      expect(readPendingOrderSend(77, stale, 'order_pdf', '11', storage)).toBeNull();
      // The refreshed menu: another phone or the default one — a new command with a new key and its own target.
      for (const fresh of [{ kind: 'client' as const, phoneId: 13, phoneToken: 'b'.repeat(64) }, { kind: 'client' as const }]) {
        const send = vi.fn(async () => ok);
        await runOrderSend({ ...base, target: fresh, send, storage });
        const body = (send.mock.calls[0] as unknown as [number, { target: unknown; idempotencyKey: string }])[1];
        expect(body.target).toEqual(fresh);
        expect(body.idempotencyKey).not.toBe(firstKey);
      }
    }
    // The same codes without the server's mark (an older backend): the outcome of the first attempt is still
    // unknown, so the key stays and the stored command is retried.
    const storage = memoryStorage();
    await runOrderSend({ ...base, send: async () => { throw apiError(500, 'X'); }, storage });
    await runOrderSend({ ...base, send: async () => { throw apiError(409, 'CLIENT_PHONE_MISSING'); }, storage });
    expect(storage.data.has(KEY)).toBe(true);
    await runOrderSend({ ...base, send: async () => { throw apiError(409, 'ORDER_SEND_DISABLED'); }, storage });
    expect(storage.data.has(KEY)).toBe(true);
  });

  it('a stale recipient (phone edited or removed) asks the card to reload its recipients', async () => {
    const storage = memoryStorage();
    const stale = await runOrderSend({ ...base, target: { kind: 'client', phoneId: 12, phoneToken: 't' }, storage,
      send: async () => { throw apiError(409, 'ORDER_SEND_PHONE_CHANGED'); } });
    expect(stale).toMatchObject({ type: 'warning', refreshRecipients: true });
    expect(stale?.text).toContain('выберите его заново');
    const other = await runOrderSend({ ...base, storage, send: async () => { throw apiError(409, 'ORDER_SEND_DISABLED'); } });
    expect(other?.refreshRecipients).toBeUndefined();
  });

  it('one pending slot per recipient and form: a lost answer is settled first, whichever phone is picked next', async () => {
    // The first click went by default while the phones were loading; the answer was lost. The next click picks
    // the same number from the list: the stored command (its target, its key) is replayed — no second command.
    const T = 'c'.repeat(64);
    for (const [first, next] of [
      [{ kind: 'client' as const }, { kind: 'client' as const, phoneId: 12, phoneToken: T }],
      [{ kind: 'client' as const, phoneId: 12, phoneToken: T }, { kind: 'client' as const }],
      [{ kind: 'employee' as const, recipientKey: 'e1' }, { kind: 'employee' as const, recipientKey: 'e1', contactId: 8, contactToken: T }],
    ]) {
      const storage = memoryStorage();
      expect(pendingOrderSendKey(77, first, 'order_pdf')).toBe(pendingOrderSendKey(77, next, 'order_pdf'));
      await runOrderSend({ ...base, target: first, send: async () => { throw apiError(500, 'INTERNAL_ERROR'); }, storage });
      const stored = readPendingOrderSend(77, next, 'order_pdf', '11', storage);
      expect(stored?.payload.target).toEqual(first);
      const send = vi.fn(async () => ({ send: { ...ok.send, recipientMasked: '7701***2060' } }));
      const toast = await runOrderSend({ ...base, target: next, targetLabel: 'клиенту (7777***4567)', send, storage });
      const body = (send.mock.calls[0] as unknown as [number, { target: unknown; idempotencyKey: string }])[1];
      expect(body).toMatchObject({ target: first, idempotencyKey: stored?.payload.idempotencyKey });
      expect(send).toHaveBeenCalledTimes(1);
      // The toast names the number the settled command really went to, not the one just clicked.
      expect(toast?.text).toContain('(7701***2060)');
      expect(toast?.text).not.toContain('7777***4567');
    }
    // Another employee recipient is another slot.
    expect(pendingOrderSendKey(77, { kind: 'employee', recipientKey: 'e1' }, 'order_pdf')).not.toBe(pendingOrderSendKey(77, { kind: 'employee', recipientKey: 'e2' }, 'order_pdf'));
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

describe('queue texts', () => {
  it('the queued toast tells the place and «≈ when»; the queue refusals are explained', async () => {
    const { orderSendSuccessToast, orderSendErrorToast } = await import('./whatsappOrderSendModel');
    expect(orderSendSuccessToast('клиенту', 'PDF заказа', { position: 3, estimatedAt: '2026-10-03T09:35:00Z' }).text)
      .toBe('Заказ поставлен в очередь на отправку (№3), ≈ 14:35: клиенту (PDF заказа)');
    expect(orderSendSuccessToast('клиенту', 'PDF заказа', { position: 1, estimatedAt: null }).text).toBe('Заказ поставлен в очередь на отправку: клиенту (PDF заказа)');
    expect(orderSendErrorToast(apiError(409, 'ORDER_SEND_ALREADY_QUEUED', { estimatedAt: '2026-10-03T09:35:00Z' })).text).toContain('уйдёт ≈ 14:35');
    expect(orderSendErrorToast(apiError(409, 'ORDER_SEND_QUEUE_FULL', { scope: 'actor', limit: 20 })).text).toContain('20 отправок');
    expect(orderSendErrorToast(apiError(422, 'ORDER_SEND_TOO_LONG')).text).toContain('20 изображений');
  });
});
