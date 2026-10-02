import { afterEach, describe, expect, it, vi } from 'vitest';
import { orderSendApi } from './orderSendApi';

describe('orderSendApi wire contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('uses the order-send routes with the documented methods and bodies', async () => {
    vi.stubEnv('VITE_API_URL', '');
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const update = {
      version: 2, enabled: true, minIntervalMinutes: 10, clientForms: ['production_pdf' as const], clientCaption: 'x',
      chats: [{ chatKey: null, groupChatId: '120363338054016575@g.us', label: 'ЧПУ', forms: ['order_pdf' as const], caption: '' }],
    };

    await orderSendApi.settings();
    await orderSendApi.updateSettings(update);
    await orderSendApi.menu();
    await orderSendApi.send(77, { target: { kind: 'chat', chatKey: 'k' }, form: 'order_pdf', idempotencyKey: 'u1' });
    await orderSendApi.list(77);

    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit | undefined]>;
    expect(calls.map(([url, init]) => `${init?.method} ${String(url)}`)).toEqual([
      'GET /api/v1/whatsapp/order-send/settings',
      'PUT /api/v1/whatsapp/order-send/settings',
      'GET /api/v1/whatsapp/order-send/menu',
      'POST /api/v1/orders/77/whatsapp-sends',
      'GET /api/v1/orders/77/whatsapp-sends',
    ]);
    expect(JSON.parse(calls[1][1]?.body as string)).toEqual(update);
    expect(JSON.parse(calls[3][1]?.body as string)).toEqual({ target: { kind: 'chat', chatKey: 'k' }, form: 'order_pdf', idempotencyKey: 'u1' });
  });
});
