import { describe, expect, it, vi } from 'vitest';
import {
  Bitrix24ApiClient,
  Bitrix24ApiError,
  NoopBitrix24ApiClient,
  type FetchFn,
} from './bitrix24-api-client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Bitrix24ApiClient', () => {
  it('creates a CRM item through incoming webhook', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(
      jsonResponse({ result: { item: { id: 42 } } }),
    );
    const client = new Bitrix24ApiClient(
      'https://portal.bitrix24.kz/rest/1/secret/',
      fetchFn,
    );

    await expect(client.createCrmItem(3, { name: 'Иван' })).resolves.toBe('42');
    expect(fetchFn).toHaveBeenCalledWith(
      'https://portal.bitrix24.kz/rest/1/secret/crm.item.add',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual({
      entityTypeId: 3,
      fields: { name: 'Иван' },
    });
  });

  it('finds an ERP element by origin fields', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(
      jsonResponse({ result: { items: [{ id: 17 }] } }),
    );
    const client = new Bitrix24ApiClient('https://portal/rest/1/token', fetchFn);

    await expect(client.findCrmItemByOrigin(2, 'ORDER_9')).resolves.toBe('17');
    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(body.filter).toEqual({
      originatorId: 'MEBELKZ_ERP',
      originId: 'ORDER_9',
    });
  });

  it('converts Contact phone arrays into keyed update mutations', async () => {
    const fetchFn = vi.fn<FetchFn>()
      .mockResolvedValueOnce(jsonResponse({
        result: {
          item: {
            fm: [
              { id: 71, typeId: 'PHONE', value: '+70000000001' },
              { id: 72, typeId: 'EMAIL', value: 'keep@example.test' },
            ],
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ result: { item: { id: 42 } } }));
    const client = new Bitrix24ApiClient('https://portal/rest/1/token', fetchFn);

    await client.updateCrmItem(3, '42', {
      name: 'Иван',
      fm: [{ typeId: 'PHONE', valueType: 'MOBILE', value: '+77001234567' }],
    });

    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      'https://portal/rest/1/token/crm.item.get',
      'https://portal/rest/1/token/crm.item.update',
    ]);
    const update = JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body));
    expect(update.fields.fm).toEqual({
      71: { value: '' },
      n0: { typeId: 'PHONE', valueType: 'MOBILE', value: '+77001234567' },
    });
  });

  it('deletes the last existing phone with a keyed empty-value mutation', async () => {
    const fetchFn = vi.fn<FetchFn>()
      .mockResolvedValueOnce(jsonResponse({
        result: { item: { fm: [{ id: 71, typeId: 'PHONE' }] } },
      }))
      .mockResolvedValueOnce(jsonResponse({ result: { item: { id: 42 } } }));
    const client = new Bitrix24ApiClient('https://portal/rest/1/token', fetchFn);

    await client.updateCrmItem(3, '42', { name: 'Иван', fm: [] });

    const update = JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body));
    expect(update.fields.fm).toEqual({ 71: { value: '' } });
  });

  it('proves writer ownership before every REST call and blocks the next call after loss', async () => {
    const fetchFn = vi.fn<FetchFn>()
      .mockResolvedValueOnce(jsonResponse({
        result: { item: { fm: [{ id: 71, typeId: 'PHONE' }] } },
      }));
    const client = new Bitrix24ApiClient('https://portal/rest/1/token', fetchFn);
    const guard = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('writer ownership lost'));

    await expect(client.withRequestGuard(
      guard,
      () => client.updateCrmItem(3, '42', {
        name: 'Иван',
        fm: [{ typeId: 'PHONE', valueType: 'MOBILE', value: '+77001234567' }],
      }),
    )).rejects.toThrow('writer ownership lost');

    expect(guard).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      'https://portal/rest/1/token/crm.item.get',
    ]);
  });

  it('creates and updates a native deal payment', async () => {
    const fetchFn = vi.fn<FetchFn>()
      .mockResolvedValueOnce(jsonResponse({ result: 1033 }))
      .mockResolvedValueOnce(jsonResponse({ result: { payment: { id: 1033 } } }));
    const client = new Bitrix24ApiClient('https://portal/rest/1/token', fetchFn);

    await expect(client.createDealPayment('55')).resolves.toBe('1033');
    await client.updatePayment('1033', { paySystemId: 6, sum: 100 });

    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      'https://portal/rest/1/token/crm.item.payment.add',
      'https://portal/rest/1/token/sale.payment.update',
    ]);
  });

  it('does not retry an ambiguous payment add inside the HTTP adapter', async () => {
    const fetchFn = vi.fn<FetchFn>().mockRejectedValueOnce(
      new Error('request to https://portal/rest/1/token/crm.item.payment.add failed'),
    );
    const client = new Bitrix24ApiClient('https://portal/rest/1/token', fetchFn);

    await expect(client.createDealPayment('55')).rejects.toThrow(/NETWORK_ERROR/);
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      'https://portal/rest/1/token/crm.item.payment.add',
    ]);
  });

  it('paginates every Deal payment for guard snapshots and membership checks', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({ id: index + 1 }));
    const fetchFn = vi.fn<FetchFn>()
      .mockResolvedValueOnce(jsonResponse({ result: firstPage }))
      .mockResolvedValueOnce(jsonResponse({ result: [{ id: 51 }] }));
    const client = new Bitrix24ApiClient('https://portal/rest/1/token', fetchFn);

    await expect(client.listDealPaymentIds('55')).resolves.toHaveLength(51);
    expect(
      fetchFn.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).start),
    ).toEqual([0, 50]);
  });

  it('recovers payment ID by xmlId', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(
      jsonResponse({ result: { payments: [{ id: 99, xmlId: 'MEBELKZ_ERP_PAYMENT_7' }] } }),
    );
    const client = new Bitrix24ApiClient('https://portal/rest/1/token', fetchFn);
    await expect(client.findPaymentByXmlId('MEBELKZ_ERP_PAYMENT_7')).resolves.toBe('99');
  });

  it('surfaces Bitrix error without leaking webhook URL', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(
      jsonResponse({ error: 'ACCESS_DENIED', error_description: 'Denied' }, 403),
    );
    const client = new Bitrix24ApiClient(
      'https://portal/rest/1/top-secret-token',
      fetchFn,
    );

    const error = await client.createCrmItem(3, {}).catch((value) => value);
    expect(error).toBeInstanceOf(Bitrix24ApiError);
    expect(String(error)).toContain('ACCESS_DENIED');
    expect(String(error)).not.toContain('top-secret-token');
  });

  it('redacts the webhook credential from transport errors', async () => {
    const webhook = 'https://portal/rest/1/top-secret-token';
    const fetchFn = vi.fn<FetchFn>().mockRejectedValue(
      new Error(`request to ${webhook}/crm.item.add failed`),
    );
    const client = new Bitrix24ApiClient(webhook, fetchFn);

    const error = await client.createCrmItem(3, {}).catch((value) => value);
    expect(String(error)).toContain('[redacted-webhook]');
    expect(String(error)).not.toContain('top-secret-token');
  });

  it('redacts the webhook credential from unexpected successful payloads', async () => {
    const webhook = 'https://portal/rest/1/top-secret-token';
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(
      jsonResponse({ result: { echoed: `${webhook}/crm.item.add` } }),
    );
    const client = new Bitrix24ApiClient(webhook, fetchFn);

    const error = await client.createCrmItem(3, {}).catch((value) => value);
    expect(String(error)).toContain('[redacted-webhook]');
    expect(String(error)).not.toContain('top-secret-token');
  });

  it('treats not-found delete as idempotent success', async () => {
    const fetchFn = vi.fn<FetchFn>().mockImplementation(async () =>
      jsonResponse({ error: 'ENTITY_NOT_FOUND', error_description: 'not found' }, 404),
    );
    const client = new Bitrix24ApiClient('https://portal/rest/1/token', fetchFn);
    await expect(client.deleteCrmItem(2, '7')).resolves.toBeUndefined();
    await expect(client.deletePayment('8')).resolves.toBeUndefined();
  });

  it('Noop client performs zero fetches and returns numeric dry-run IDs', async () => {
    const log = vi.fn();
    const client = new NoopBitrix24ApiClient(log);
    await expect(client.createCrmItem(4, { title: 'ООО' })).resolves.toBe('1');
    await expect(client.createDealPayment('2')).resolves.toBe('2');
    expect(log).toHaveBeenCalledTimes(2);
  });
});
