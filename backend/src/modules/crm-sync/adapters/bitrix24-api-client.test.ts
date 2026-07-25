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

let noWaitNow = 0;
const noWait = {
  now: () => noWaitNow,
  sleep: async (delayMs: number) => {
    noWaitNow += delayMs;
  },
};

describe('Bitrix24ApiClient', () => {
  it('creates a CRM item through incoming webhook', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(
      jsonResponse({ result: { item: { id: 42 } } }),
    );
    const client = new Bitrix24ApiClient(
      'https://portal.bitrix24.kz/rest/1/secret/',
      fetchFn,
      30_000,
      noWait,
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
    const client = new Bitrix24ApiClient(
      'https://portal/rest/1/token',
      fetchFn,
      30_000,
      noWait,
    );

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
    const client = new Bitrix24ApiClient(
      'https://portal/rest/1/token',
      fetchFn,
      30_000,
      noWait,
    );

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
    const client = new Bitrix24ApiClient(
      'https://portal/rest/1/token',
      fetchFn,
      30_000,
      noWait,
    );

    await client.updateCrmItem(3, '42', { name: 'Иван', fm: [] });

    const update = JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body));
    expect(update.fields.fm).toEqual({ 71: { value: '' } });
  });

  it('proves writer ownership before every REST call and blocks the next call after loss', async () => {
    const fetchFn = vi.fn<FetchFn>()
      .mockResolvedValueOnce(jsonResponse({
        result: { item: { fm: [{ id: 71, typeId: 'PHONE' }] } },
      }));
    const client = new Bitrix24ApiClient(
      'https://portal/rest/1/token',
      fetchFn,
      30_000,
      noWait,
    );
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
    const client = new Bitrix24ApiClient(
      'https://portal/rest/1/token',
      fetchFn,
      30_000,
      noWait,
    );

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
    const client = new Bitrix24ApiClient(
      'https://portal/rest/1/token',
      fetchFn,
      30_000,
      noWait,
    );

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
    const client = new Bitrix24ApiClient(
      'https://portal/rest/1/token',
      fetchFn,
      30_000,
      noWait,
    );

    await expect(client.listDealPaymentIds('55')).resolves.toHaveLength(51);
    expect(
      fetchFn.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).start),
    ).toEqual([0, 50]);
  });

  it('recovers payment ID by xmlId', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(
      jsonResponse({ result: { payments: [{ id: 99, xmlId: 'MEBELKZ_ERP_PAYMENT_7' }] } }),
    );
    const client = new Bitrix24ApiClient(
      'https://portal/rest/1/token',
      fetchFn,
      30_000,
      noWait,
    );
    await expect(client.findPaymentByXmlId('MEBELKZ_ERP_PAYMENT_7')).resolves.toBe('99');
  });

  it('surfaces Bitrix error without leaking webhook URL', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(
      jsonResponse({ error: 'ACCESS_DENIED', error_description: 'Denied' }, 403),
    );
    const client = new Bitrix24ApiClient(
      'https://portal/rest/1/top-secret-token',
      fetchFn,
      30_000,
      noWait,
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
    const client = new Bitrix24ApiClient(webhook, fetchFn, 30_000, noWait);

    const error = await client.createCrmItem(3, {}).catch((value) => value);
    expect(String(error)).toContain('[redacted-webhook]');
    expect(String(error)).not.toContain('top-secret-token');
  });

  it('wraps and redacts failures while reading the response body', async () => {
    const webhook = 'https://portal/rest/1/top-secret-token';
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue({
      status: 200,
      text: vi.fn().mockRejectedValue(
        new Error(`stream failed for ${webhook}/crm.item.add`),
      ),
    } as unknown as Response);
    const client = new Bitrix24ApiClient(webhook, fetchFn, 30_000, noWait);

    const error = await client.createCrmItem(3, {}).catch((value) => value);
    expect(error).toBeInstanceOf(Bitrix24ApiError);
    expect(String(error)).toContain('RESPONSE_READ_ERROR');
    expect(String(error)).toContain('[redacted-webhook]');
    expect(String(error)).not.toContain('top-secret-token');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('redacts the webhook credential from unexpected successful payloads', async () => {
    const webhook = 'https://portal/rest/1/top-secret-token';
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(
      jsonResponse({ result: { echoed: `${webhook}/crm.item.add` } }),
    );
    const client = new Bitrix24ApiClient(webhook, fetchFn, 30_000, noWait);

    const error = await client.createCrmItem(3, {}).catch((value) => value);
    expect(String(error)).toContain('[redacted-webhook]');
    expect(String(error)).not.toContain('top-secret-token');
  });

  it('treats not-found delete as idempotent success', async () => {
    const fetchFn = vi.fn<FetchFn>().mockImplementation(async () =>
      jsonResponse({ error: 'ENTITY_NOT_FOUND', error_description: 'not found' }, 404),
    );
    const client = new Bitrix24ApiClient(
      'https://portal/rest/1/token',
      fetchFn,
      30_000,
      noWait,
    );
    await expect(client.deleteCrmItem(2, '7')).resolves.toBeUndefined();
    await expect(client.deletePayment('8')).resolves.toBeUndefined();
  });

  it('spaces concurrent REST starts through one global client limiter', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const starts: number[] = [];
      const fetchFn = vi.fn<FetchFn>().mockImplementation(async () => {
        starts.push(Date.now());
        return jsonResponse({ result: { item: { id: starts.length } } });
      });
      const client = new Bitrix24ApiClient(
        'https://portal/rest/1/token',
        fetchFn,
        30_000,
        { maxRequestsPerSecond: 2 },
      );

      const result = Promise.all([
        client.createCrmItem(3, { name: '1' }),
        client.createCrmItem(3, { name: '2' }),
        client.createCrmItem(3, { name: '3' }),
      ]);
      await vi.advanceTimersByTimeAsync(0);
      expect(starts).toEqual([0]);
      await vi.advanceTimersByTimeAsync(499);
      expect(starts).toEqual([0]);
      await vi.advanceTimersByTimeAsync(1);
      expect(starts).toEqual([0, 500]);
      await vi.advanceTimersByTimeAsync(500);

      await expect(result).resolves.toEqual(['1', '2', '3']);
      expect(starts).toEqual([0, 500, 1000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries QUERY_LIMIT_EXCEEDED with increasing delay only', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const retries: unknown[] = [];
    const fetchFn = vi.fn<FetchFn>()
      .mockResolvedValueOnce(jsonResponse({
        error: 'QUERY_LIMIT_EXCEEDED',
        error_description: 'Too many requests',
      }, 503))
      .mockResolvedValueOnce(jsonResponse({
        error: 'QUERY_LIMIT_EXCEEDED',
        error_description: 'Too many requests',
      }, 503))
      .mockResolvedValueOnce(jsonResponse({ result: { item: { id: 42 } } }));
    const client = new Bitrix24ApiClient(
      'https://portal/rest/1/token',
      fetchFn,
      30_000,
      {
        maxRequestsPerSecond: 2,
        limitRetryMaxAttempts: 3,
        queryLimitBaseDelayMs: 1000,
        now: () => now,
        sleep: async (delayMs) => {
          sleeps.push(delayMs);
          now += delayMs;
        },
        onLimitRetry: (event) => retries.push(event),
      },
    );

    await expect(client.createCrmItem(3, {})).resolves.toBe('42');
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 2000]);
    expect(retries).toEqual([
      expect.objectContaining({ code: 'QUERY_LIMIT_EXCEEDED', attempt: 1, delayMs: 1000 }),
      expect.objectContaining({ code: 'QUERY_LIMIT_EXCEEDED', attempt: 2, delayMs: 2000 }),
    ]);
  });

  it('uses operating_reset_at for OPERATION_TIME_LIMIT and then retries', async () => {
    let now = 1_000_000;
    const sleeps: number[] = [];
    const fetchFn = vi.fn<FetchFn>()
      .mockResolvedValueOnce(jsonResponse({
        error: 'OPERATION_TIME_LIMIT',
        error_description: 'Method is temporarily blocked',
        time: { operating_reset_at: 1005 },
      }, 429))
      .mockResolvedValueOnce(jsonResponse({ result: { items: [] } }));
    const client = new Bitrix24ApiClient(
      'https://portal/rest/1/token',
      fetchFn,
      30_000,
      {
        limitRetryMaxAttempts: 2,
        now: () => now,
        sleep: async (delayMs) => {
          sleeps.push(delayMs);
          now += delayMs;
        },
      },
    );

    await expect(client.findCrmItemByOrigin(2, 'ORDER_9')).resolves.toBeNull();
    expect(sleeps).toEqual([6000]);
  });

  it('uses the operation-limit fallback when Bitrix omits reset time', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const fetchFn = vi.fn<FetchFn>()
      .mockResolvedValueOnce(jsonResponse({
        error: 'OPERATION_TIME_LIMIT',
        error_description: 'Method is temporarily blocked',
      }, 429))
      .mockResolvedValueOnce(jsonResponse({ result: { items: [] } }));
    const client = new Bitrix24ApiClient(
      'https://portal/rest/1/token',
      fetchFn,
      30_000,
      {
        limitRetryMaxAttempts: 2,
        operationLimitFallbackDelayMs: 1234,
        now: () => now,
        sleep: async (delayMs) => {
          sleeps.push(delayMs);
          now += delayMs;
        },
      },
    );

    await expect(client.findCrmItemByOrigin(2, 'ORDER_9')).resolves.toBeNull();
    expect(sleeps).toEqual([1234]);
  });

  it('re-proves ownership after retry wait before issuing another attempt', async () => {
    let now = 0;
    const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(jsonResponse({
      error: 'QUERY_LIMIT_EXCEEDED',
      error_description: 'Too many requests',
    }, 503));
    const guard = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('writer ownership lost'));
    const client = new Bitrix24ApiClient(
      'https://portal/rest/1/token',
      fetchFn,
      30_000,
      {
        limitRetryMaxAttempts: 2,
        now: () => now,
        sleep: async (delayMs) => {
          now += delayMs;
        },
      },
    );

    await expect(client.withRequestGuard(
      guard,
      () => client.createCrmItem(3, {}),
    )).rejects.toThrow('writer ownership lost');
    expect(guard).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does not retry a generic 503 without an explicit Bitrix limit code', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(
      jsonResponse({ error: 'INTERNAL_ERROR', error_description: 'Failed' }, 503),
    );
    const client = new Bitrix24ApiClient(
      'https://portal/rest/1/token',
      fetchFn,
      30_000,
      noWait,
    );

    await expect(client.createCrmItem(3, {})).rejects.toThrow(/INTERNAL_ERROR/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('applies QUERY_LIMIT_EXCEEDED cooldown to other queued methods', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const starts: number[] = [];
      const fetchFn = vi.fn<FetchFn>()
        .mockImplementationOnce(async () => {
          starts.push(Date.now());
          return jsonResponse({
            error: 'QUERY_LIMIT_EXCEEDED',
            error_description: 'Too many requests',
          }, 503);
        })
        .mockImplementationOnce(async () => {
          starts.push(Date.now());
          return jsonResponse({ result: { item: { id: 2 } } });
        });
      const client = new Bitrix24ApiClient(
        'https://portal/rest/1/token',
        fetchFn,
        30_000,
        {
          limitRetryMaxAttempts: 1,
          queryLimitBaseDelayMs: 1000,
        },
      );

      const limited = client.findCrmItemByOrigin(2, 'ORDER_1').catch((error) => error);
      const queued = client.createCrmItem(3, {});
      await vi.advanceTimersByTimeAsync(0);
      expect(await limited).toBeInstanceOf(Bitrix24ApiError);
      expect(starts).toEqual([0]);
      await vi.advanceTimersByTimeAsync(500);
      expect(starts).toEqual([0]);
      await vi.advanceTimersByTimeAsync(500);

      await expect(queued).resolves.toBe('2');
      expect(starts).toEqual([0, 1000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies OPERATION_TIME_LIMIT cooldown only to the blocked method', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const starts: Array<{ method: string; at: number }> = [];
      const fetchFn = vi.fn<FetchFn>()
        .mockImplementationOnce(async (url) => {
          starts.push({ method: url.split('/').at(-1)!, at: Date.now() });
          return jsonResponse({
            error: 'OPERATION_TIME_LIMIT',
            error_description: 'Method is temporarily blocked',
          }, 429);
        })
        .mockImplementationOnce(async (url) => {
          starts.push({ method: url.split('/').at(-1)!, at: Date.now() });
          return jsonResponse({ result: { item: { id: 2 } } });
        })
        .mockImplementationOnce(async (url) => {
          starts.push({ method: url.split('/').at(-1)!, at: Date.now() });
          return jsonResponse({ result: { items: [] } });
        });
      const client = new Bitrix24ApiClient(
        'https://portal/rest/1/token',
        fetchFn,
        30_000,
        {
          limitRetryMaxAttempts: 1,
          operationLimitFallbackDelayMs: 1234,
        },
      );

      const limited = client.findCrmItemByOrigin(2, 'ORDER_1').catch((error) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(await limited).toBeInstanceOf(Bitrix24ApiError);

      // Queue the blocked method first. It must release the admission queue so
      // the unrelated create can run at the normal 500ms pace.
      const blockedMethod = client.findCrmItemByOrigin(2, 'ORDER_2');
      const otherMethod = client.createCrmItem(3, {});
      await vi.advanceTimersByTimeAsync(500);
      await expect(otherMethod).resolves.toBe('2');
      expect(starts).toEqual([
        { method: 'crm.item.list', at: 0 },
        { method: 'crm.item.add', at: 500 },
      ]);
      await vi.advanceTimersByTimeAsync(734);
      await expect(blockedMethod).resolves.toBeNull();
      expect(starts[2]).toEqual({ method: 'crm.item.list', at: 1234 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the admission queue when an admitted request rejects', async () => {
    let now = 0;
    const fetchFn = vi.fn<FetchFn>()
      .mockRejectedValueOnce(new Error('network failed'))
      .mockResolvedValueOnce(jsonResponse({ result: { item: { id: 2 } } }));
    const client = new Bitrix24ApiClient(
      'https://portal/rest/1/token',
      fetchFn,
      30_000,
      {
        now: () => now,
        sleep: async (delayMs) => {
          now += delayMs;
        },
      },
    );

    await expect(client.createCrmItem(3, {})).rejects.toThrow(/NETWORK_ERROR/);
    await expect(client.createCrmItem(3, {})).resolves.toBe('2');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('Noop client performs zero fetches and returns numeric dry-run IDs', async () => {
    const log = vi.fn();
    const client = new NoopBitrix24ApiClient(log);
    await expect(client.createCrmItem(4, { title: 'ООО' })).resolves.toBe('1');
    await expect(client.createDealPayment('2')).resolves.toBe('2');
    expect(log).toHaveBeenCalledTimes(2);
  });
});
