import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/apiError';
import type { OrderSendResponse } from '../../api/orderSendApiTypes';
import type { SupplierSendCommandInput, SupplierSendMenu } from '../../api/supplierSendApi';
import {
  counterpartyOfSupplierKey,
  pendingSupplierSendKey,
  readPendingSupplierSend,
  runSupplierSend,
  supplierMessagesText,
  supplierSendButtonState,
  supplierSendStateToast,
  type SupplierSendContext,
} from './supplierSendModel';

const TOKEN = 'a'.repeat(64);
const menu = (overrides: Partial<SupplierSendMenu> = {}): SupplierSendMenu => ({
  enabled: true, unavailableReason: null, supplier: { supplierId: 1, name: 'Тест Поставщик' },
  contacts: [{ contactId: 101, masked: '7701***0101', isPrimary: true, token: TOKEN }], requestVersion: 3, queueLength: 0,
  runtime: { enabled: true, relayAvailable: true, unavailableReason: null }, ...overrides,
});
const context = (overrides: Partial<SupplierSendContext> = {}): SupplierSendContext => ({
  text: 'Тест заявка', edited: false, templateId: 7, templateVersion: 2, requestId: 55, requestVersion: 3, textVersion: 3, dirty: false, ready: true, ...overrides,
});
const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); }, data };
};
const view = (state = 'queued'): OrderSendResponse => ({ send: {
  sendId: '11111111-1111-4111-8111-111111111111', orderId: null, targetKind: 'supplier', chatKey: null, recipientLabel: 'Тест Поставщик',
  recipientMasked: '7701***0101', form: 'supplier_text', state, errorCode: null, cancelReason: null, createdAt: '2026-10-04T10:00:00.000Z', sentAt: null,
  actor: { id: 11, username: 'тест' }, partsTotal: 2, position: 1, estimatedAt: '2026-10-04T10:05:00.000Z',
} });
const payload: Omit<SupplierSendCommandInput, 'idempotencyKey'> = { text: 'Тест заявка', edited: false, templateId: 7, templateVersion: 2,
  textVersion: 3, contactId: 101, contactToken: TOKEN };
const api = (code: string, status = 409, details?: Record<string, unknown>) => new ApiError({ status, code, message: code, details });

describe('«Отправить в WhatsApp» in the window «Текст для поставщика»', () => {
  it('is off with the reason until the text may be sent', () => {
    const ready = { status: 'ready' as const, menu: menu() };
    expect(supplierSendButtonState(context(), ready)).toMatchObject({ hidden: false, disabled: false, reason: null, messages: 1 });
    expect(supplierSendButtonState(context({ ready: false }), ready).reason).toBe('Текст ещё не готов');
    expect(supplierSendButtonState(context({ dirty: true }), ready).reason).toBe('Сначала сохраните изменения заявки');
    // The card was refreshed while the user edited the text by hand: the text is of the older version.
    expect(supplierSendButtonState(context({ textVersion: 2 }), ready).reason).toBe('Заявка изменилась — обновите текст');
    expect(supplierSendButtonState(context(), { status: 'loading' }).disabled).toBe(true);
    expect(supplierSendButtonState(context(), { status: 'hidden' }).hidden).toBe(true);
    expect(supplierSendButtonState(context(), { status: 'ready', menu: menu({ unavailableReason: 'disabled', enabled: false }) }).reason)
      .toContain('выключена в настройках');
    expect(supplierSendButtonState(context(), { status: 'ready', menu: menu({ unavailableReason: 'status' }) }).disabled).toBe(true);
    expect(supplierSendButtonState(context(), { status: 'ready', menu: menu({ runtime: { enabled: true, relayAvailable: false, unavailableReason: 'x' } }) }).reason)
      .toBe('WhatsApp сейчас недоступен');
    expect(supplierSendButtonState(context({ text: '  ' }), ready).reason).toBe('Текст пуст');
    expect(supplierSendButtonState(context({ text: 'а'.repeat(20_001) }), ready).disabled).toBe(true);
    expect(supplierSendButtonState(context({ text: 'а'.repeat(9000) }), ready)).toMatchObject({ disabled: false, messages: 3 });
  });

  it('a recipient that needs fixing keeps the button clickable: its window explains what to do', () => {
    for (const reason of ['not_linked', 'no_phone', 'supplier_inactive'] as const) {
      expect(supplierSendButtonState(context(), { status: 'ready', menu: menu({ unavailableReason: reason, contacts: [] }) }))
        .toMatchObject({ disabled: false, recipientProblem: reason });
    }
    expect(counterpartyOfSupplierKey('c:0B0F3C2E-1111-4222-8333-444455556666')).toBe('0b0f3c2e-1111-4222-8333-444455556666');
    expect(counterpartyOfSupplierKey('s:12')).toBeNull();
    expect(counterpartyOfSupplierKey('n:тест')).toBeNull();
    expect(supplierMessagesText(1)).toBe('Уйдёт одним сообщением');
    expect(supplierMessagesText(3)).toContain('3 сообщениями');
    expect(supplierMessagesText(21)).toContain('21 сообщением');
  });

  it('a fresh command is stored before the request and dropped on the answer', async () => {
    const storage = memory();
    const bodies: SupplierSendCommandInput[] = [];
    const queued: string[] = [];
    const result = await runSupplierSend({ supplierRequestId: 55, requestNumber: '26-0012', actorId: '11', payload, storage,
      send: async (_id, body) => { bodies.push(body); expect(readPendingSupplierSend(55, '11', storage)?.payload).toEqual(body); return view(); },
      onQueued: (send) => queued.push(send.sendId) });
    expect(result).toMatchObject({ type: 'success', accepted: true });
    expect(result?.text).toContain('заявка № 26-0012 → Тест Поставщик (7701***0101), сообщений: 2');
    expect(bodies).toHaveLength(1);
    expect(queued).toHaveLength(1);
    expect(storage.data.size).toBe(0);
  });

  it('an unresolved command is resent word for word — never replaced by the text on the screen — and settled first', async () => {
    const storage = memory();
    const first: SupplierSendCommandInput[] = [];
    const lost = await runSupplierSend({ supplierRequestId: 55, requestNumber: '26-0012', actorId: '11', payload, storage,
      send: async (_id, body) => { first.push(body); throw new Error('network'); } });
    expect(lost?.type).toBe('error');
    expect(readPendingSupplierSend(55, '11', storage)?.payload).toEqual(first[0]);
    // The text in the window is different now, another phone is chosen: the stored command goes as it was.
    const second: SupplierSendCommandInput[] = [];
    const settled = await runSupplierSend({ supplierRequestId: 55, requestNumber: '26-0012', actorId: '11', storage,
      payload: { ...payload, text: 'Тест другой текст', edited: true, contactId: 102, contactToken: 'b'.repeat(64) },
      send: async (_id, body) => { second.push(body); return view('sent'); } });
    expect(second).toEqual(first);
    expect(settled).toMatchObject({ type: 'info', accepted: true });
    expect(settled?.text).toContain('Сначала доведена прежняя отправка');
    expect(settled?.text).toContain('Текст с экрана не отправлен');
    expect(storage.data.size).toBe(0);
    // Another user of this browser never takes over the stored command.
    await runSupplierSend({ supplierRequestId: 55, requestNumber: '26-0012', actorId: '11', payload, storage, send: async () => { throw new Error('network'); } });
    expect(readPendingSupplierSend(55, '12', storage)).toBeNull();
  });

  it('after a lost answer only a refusal recorded for good drops the key; any other refusal keeps it', async () => {
    const storage = memory();
    const attempt = (error: unknown) => runSupplierSend({ supplierRequestId: 55, requestNumber: '26-0012', actorId: '11', payload, storage,
      send: async () => { throw error; } });
    await attempt(new Error('network'));
    const key = pendingSupplierSendKey(55);
    // The request changed meanwhile — but without the server's «final» mark the earlier attempt may still have been accepted.
    expect((await attempt(api('SUPPLIER_SEND_DISABLED')))?.type).toBe('warning');
    expect(storage.data.has(key)).toBe(true);
    // «The previous send ended unknown» without the mark (an attempt may have been accepted before it) keeps the key too.
    await attempt(api('ORDER_SEND_PREVIOUS_UNKNOWN', 409, { sendId: '22222222-2222-4222-8222-222222222222' }));
    expect(storage.data.has(key)).toBe(true);
    expect((await attempt(api('SUPPLIER_REQUEST_VERSION_CONFLICT', 409, { final: true })))?.text).toContain('Заявка изменилась');
    expect(storage.data.has(key)).toBe(false);
  });

  it('a fresh command refused by the server leaves nothing behind; an unknown previous outcome asks for a confirmation', async () => {
    const storage = memory();
    const refused = await runSupplierSend({ supplierRequestId: 55, requestNumber: '26-0012', actorId: '11', payload, storage,
      send: async () => { throw api('SUPPLIER_CONTACT_MISSING', 409, { final: true }); } });
    expect(refused).toMatchObject({ type: 'warning', refreshMenu: true });
    expect(storage.data.size).toBe(0);
    const unknown = await runSupplierSend({ supplierRequestId: 55, requestNumber: '26-0012', actorId: '11', payload, storage,
      send: async () => { throw api('ORDER_SEND_PREVIOUS_UNKNOWN', 409, { sendId: '22222222-2222-4222-8222-222222222222', createdAt: '2026-10-04T09:00:00.000Z' }); } });
    expect(unknown?.confirmUnknown?.sendId).toBe('22222222-2222-4222-8222-222222222222');
    expect(storage.data.size).toBe(0);
    const bodies: SupplierSendCommandInput[] = [];
    await runSupplierSend({ supplierRequestId: 55, requestNumber: '26-0012', actorId: '11', storage,
      payload: { ...payload, confirmAfterUnknown: '22222222-2222-4222-8222-222222222222' }, send: async (_id, body) => { bodies.push(body); return view(); } });
    expect(bodies[0].confirmAfterUnknown).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('says what happened to a send in words', () => {
    const base = view().send;
    expect(supplierSendStateToast({ ...base, state: 'cancelled', cancelReason: 'request_changed' }, '26-0012').text).toContain('заявка изменилась');
    expect(supplierSendStateToast({ ...base, state: 'failed', errorCode: 'SUPPLIER_NOT_ON_WHATSAPP' }, '26-0012').text).toContain('нет в WhatsApp');
    expect(supplierSendStateToast({ ...base, state: 'unknown', errorCode: 'PARTIAL_DELIVERY' }, '26-0012').text).toContain('только часть сообщений');
  });
});
