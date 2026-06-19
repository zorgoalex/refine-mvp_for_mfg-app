import { describe, expect, it, vi } from 'vitest';
import { TwentyApiClient, NoopTwentyApiClient, type FetchFn } from './twenty-api-client';

// Minimal Response-like mock factory
function makeResponse(ok: boolean, status: number, body: unknown): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

// Response mock with a headers map (for Retry-After tests)
function makeResponseWithHeaders(
  ok: boolean,
  status: number,
  body: unknown,
  headers: Record<string, string>,
): Response {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ok,
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe('TwentyApiClient', () => {
  const BASE = 'http://twenty:3000';
  const KEY = 'test-api-key';

  describe('createRecord', () => {
    it('companies → extracts id from data.createCompany.id', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        makeResponse(true, 200, { data: { createCompany: { id: 'company-abc' } } }),
      );
      const client = new TwentyApiClient(BASE, KEY, mockFetch);
      const result = await client.createRecord('companies', { name: 'Acme' });
      expect(result).toEqual({ id: 'company-abc' });
      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE}/rest/companies`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'Acme' }),
        }),
      );
    });

    it('erpOrders → extracts id from data.createErpOrder.id', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        makeResponse(true, 200, { data: { createErpOrder: { id: 'order-xyz' } } }),
      );
      const client = new TwentyApiClient(BASE, KEY, mockFetch);
      const result = await client.createRecord('erpOrders', { erpId: '42' });
      expect(result).toEqual({ id: 'order-xyz' });
      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE}/rest/erpOrders`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('throws on non-ok response', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        makeResponse(false, 422, 'Unprocessable Entity'),
      );
      const client = new TwentyApiClient(BASE, KEY, mockFetch);
      await expect(client.createRecord('companies', {})).rejects.toThrow(/422/);
    });

    it('throws a clear error when 200 response has unexpected shape (malformed body)', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        makeResponse(true, 200, { data: {} }),
      );
      const client = new TwentyApiClient(BASE, KEY, mockFetch);
      await expect(client.createRecord('companies', {})).rejects.toThrow(
        /unexpected response shape/,
      );
    });
  });

  describe('updateRecord', () => {
    it('issues PATCH to /rest/{object}/{id} and resolves void', async () => {
      const mockFetch = vi.fn().mockResolvedValue(makeResponse(true, 200, {}));
      const client = new TwentyApiClient(BASE, KEY, mockFetch);
      const result = await client.updateRecord('companies', 'id-123', { name: 'Updated' });
      expect(result).toBeUndefined();
      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE}/rest/companies/id-123`,
        expect.objectContaining({ method: 'PATCH' }),
      );
    });

    it('throws on non-ok response', async () => {
      const mockFetch = vi.fn().mockResolvedValue(makeResponse(false, 500, 'Server Error'));
      const client = new TwentyApiClient(BASE, KEY, mockFetch);
      await expect(client.updateRecord('erpOrders', 'id-99', {})).rejects.toThrow(/500/);
    });
  });

  describe('findIdByErpId', () => {
    it('builds URL-encoded filter and returns first id', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        makeResponse(true, 200, { data: { companies: [{ id: 'found-id' }, { id: 'other' }] } }),
      );
      const client = new TwentyApiClient(BASE, KEY, mockFetch);
      const result = await client.findIdByErpId('companies', 'ERP-001');
      expect(result).toBe('found-id');
      // Filter must be URL-encoded: erpId[eq]:ERP-001 → erpId%5Beq%5D%3AERP-001
      const calledUrl = (mockFetch.mock.calls[0][0] as string);
      expect(calledUrl).toContain('erpId%5Beq%5D%3AERP-001');
      expect(calledUrl).toContain(`${BASE}/rest/companies?filter=`);
    });

    it('returns null when array is empty', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        makeResponse(true, 200, { data: { erpOrders: [] } }),
      );
      const client = new TwentyApiClient(BASE, KEY, mockFetch);
      const result = await client.findIdByErpId('erpOrders', 'ERP-999');
      expect(result).toBeNull();
    });

    it('throws on non-ok response', async () => {
      const mockFetch = vi.fn().mockResolvedValue(makeResponse(false, 401, 'Unauthorized'));
      const client = new TwentyApiClient(BASE, KEY, mockFetch);
      await expect(client.findIdByErpId('companies', 'x')).rejects.toThrow(/401/);
    });
  });

  describe('deleteRecord', () => {
    it('issues DELETE to /rest/{object}/{id} and resolves void', async () => {
      const mockFetch = vi.fn().mockResolvedValue(makeResponse(true, 200, {}));
      const client = new TwentyApiClient(BASE, KEY, mockFetch);
      const result = await client.deleteRecord('companies', 'del-id');
      expect(result).toBeUndefined();
      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE}/rest/companies/del-id`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('throws on non-ok response with method/object/status info', async () => {
      const mockFetch = vi.fn().mockResolvedValue(makeResponse(false, 404, 'Not Found'));
      const client = new TwentyApiClient(BASE, KEY, mockFetch);
      await expect(client.deleteRecord('erpOrders', 'missing-id')).rejects.toThrow(
        /delete.*erpOrders.*missing-id.*404/i,
      );
    });
  });

  describe('auth headers', () => {
    it('sends Authorization: Bearer <apiKey> and Content-Type on all requests', async () => {
      const mockFetch = vi.fn().mockResolvedValue(makeResponse(true, 200, {}));
      const client = new TwentyApiClient(BASE, KEY, mockFetch);
      await client.updateRecord('companies', 'id-1', {});
      const options = mockFetch.mock.calls[0][1] as RequestInit;
      const headers = options.headers as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${KEY}`);
      expect(headers['Content-Type']).toBe('application/json');
    });
  });
});

describe('TwentyApiClient retry on 429', () => {
  const BASE = 'http://twenty:3000';
  const KEY = 'test-api-key';
  const okBody = { data: { createCompany: { id: 'company-abc' } } };

  function makeRetryClient(
    fetchFn: FetchFn,
    sleeps: number[],
    overrides: Record<string, unknown> = {},
  ): TwentyApiClient {
    return new TwentyApiClient(BASE, KEY, fetchFn, {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      sleepFn: async (ms: number) => {
        sleeps.push(ms);
      },
      randomFn: () => 1, // full jitter → exactly the capped delay (deterministic)
      ...overrides,
    });
  }

  it('retries a 429 then succeeds on the next attempt', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(false, 429, { statusCode: 429 }))
      .mockResolvedValueOnce(makeResponse(true, 200, okBody));
    const sleeps: number[] = [];
    const client = makeRetryClient(mockFetch as unknown as FetchFn, sleeps);

    const result = await client.createRecord('companies', { name: 'Acme' });
    expect(result).toEqual({ id: 'company-abc' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(sleeps).toHaveLength(1);
  });

  it('honors a numeric Retry-After header (seconds → ms)', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponseWithHeaders(false, 429, { statusCode: 429 }, { 'Retry-After': '2' }),
      )
      .mockResolvedValueOnce(makeResponse(true, 200, okBody));
    const sleeps: number[] = [];
    const client = makeRetryClient(mockFetch as unknown as FetchFn, sleeps);

    await client.createRecord('companies', {});
    expect(sleeps).toEqual([2000]);
  });

  it('honors a Retry-After LARGER than the exponential backoff cap (not clamped to maxDelayMs)', async () => {
    // Twenty's LONG bucket can ask for 60s; clamping to maxDelayMs(30s) would
    // retry early, re-429, and burn the retry budget. Server header is authoritative.
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponseWithHeaders(false, 429, {}, { 'Retry-After': '60' }),
      )
      .mockResolvedValueOnce(makeResponse(true, 200, okBody));
    const sleeps: number[] = [];
    const client = makeRetryClient(mockFetch as unknown as FetchFn, sleeps, {
      maxDelayMs: 30000,
      maxRetryAfterMs: 120000,
    });
    await client.createRecord('companies', {});
    expect(sleeps).toEqual([60000]); // honored fully, NOT clamped to 30000
  });

  it('caps a pathologically large Retry-After at maxRetryAfterMs', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeResponseWithHeaders(false, 429, {}, { 'Retry-After': '99999' }));
    const sleeps: number[] = [];
    const client = makeRetryClient(mockFetch as unknown as FetchFn, sleeps, {
      maxRetries: 1,
      maxRetryAfterMs: 120000,
    });
    await expect(client.createRecord('companies', {})).rejects.toThrow(/429/);
    expect(sleeps).toEqual([120000]); // 99999s clamped to 120s
  });

  it('parses an HTTP-date Retry-After header', async () => {
    const aboutTenSeconds = new Date(Date.now() + 10_000).toUTCString();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponseWithHeaders(false, 429, {}, { 'Retry-After': aboutTenSeconds }),
      )
      .mockResolvedValueOnce(makeResponse(true, 200, okBody));
    const sleeps: number[] = [];
    const client = makeRetryClient(mockFetch as unknown as FetchFn, sleeps);
    await client.createRecord('companies', {});
    expect(sleeps).toHaveLength(1);
    // ~10s, allow scheduling slack (HTTP-date has 1s resolution + test timing)
    expect(sleeps[0]).toBeGreaterThanOrEqual(8000);
    expect(sleeps[0]).toBeLessThanOrEqual(11000);
  });

  it('uses exponential backoff when no Retry-After header is present', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(false, 429, {}))
      .mockResolvedValueOnce(makeResponse(false, 429, {}))
      .mockResolvedValueOnce(makeResponse(true, 200, okBody));
    const sleeps: number[] = [];
    const client = makeRetryClient(mockFetch as unknown as FetchFn, sleeps);

    await client.createRecord('companies', {});
    // base*2^0=1000, base*2^1=2000 (randomFn=()=>1 → exactly the capped value)
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('caps the backoff delay at maxDelayMs', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeResponse(false, 429, {}));
    const sleeps: number[] = [];
    const client = makeRetryClient(mockFetch as unknown as FetchFn, sleeps, {
      maxRetries: 6,
      baseDelayMs: 10000,
      maxDelayMs: 30000,
    });
    await expect(client.createRecord('companies', {})).rejects.toThrow(/429/);
    // 10000, 20000, then capped at 30000 thereafter
    expect(sleeps.every((d) => d <= 30000)).toBe(true);
    expect(sleeps).toContain(30000);
  });

  it('throws after exhausting maxRetries on persistent 429', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse(false, 429, 'rate limited'));
    const sleeps: number[] = [];
    const client = makeRetryClient(mockFetch as unknown as FetchFn, sleeps);

    await expect(client.createRecord('companies', {})).rejects.toThrow(/429/);
    // maxRetries=3 → 1 initial + 3 retries = 4 calls, 3 sleeps
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(sleeps).toHaveLength(3);
  });

  it('does NOT retry a non-429 error (e.g. 500)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse(false, 500, 'Server Error'));
    const sleeps: number[] = [];
    const client = makeRetryClient(mockFetch as unknown as FetchFn, sleeps);

    await expect(client.createRecord('companies', {})).rejects.toThrow(/500/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sleeps).toHaveLength(0);
  });

  it('retries 429 on all verbs (findIdByErpId)', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(false, 429, {}))
      .mockResolvedValueOnce(makeResponse(true, 200, { data: { companies: [{ id: 'x' }] } }));
    const sleeps: number[] = [];
    const client = makeRetryClient(mockFetch as unknown as FetchFn, sleeps);

    const id = await client.findIdByErpId('companies', 'ERP-1');
    expect(id).toBe('x');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('NoopTwentyApiClient', () => {
  it('createRecord makes NO fetch call and returns dryrun-{object} id', async () => {
    const spyFetch = vi.fn();
    // NoopTwentyApiClient takes a logger, not fetch — verify no real fetch is called
    const logs: string[] = [];
    const client = new NoopTwentyApiClient((msg) => logs.push(msg));
    const result = await client.createRecord('companies', { name: 'Test' });
    expect(result).toEqual({ id: 'dryrun-companies' });
    expect(spyFetch).not.toHaveBeenCalled();
    expect(logs[0]).toContain('[dry-run]');
    expect(logs[0]).toContain('create');
  });

  it('updateRecord makes NO fetch call and resolves void', async () => {
    const spyFetch = vi.fn();
    const logs: string[] = [];
    const client = new NoopTwentyApiClient((msg) => logs.push(msg));
    const result = await client.updateRecord('erpOrders', 'id-1', { x: 1 });
    expect(result).toBeUndefined();
    expect(spyFetch).not.toHaveBeenCalled();
    expect(logs[0]).toContain('[dry-run]');
  });

  it('findIdByErpId makes NO fetch call and returns null', async () => {
    const spyFetch = vi.fn();
    const client = new NoopTwentyApiClient();
    const result = await client.findIdByErpId('companies', 'ERP-001');
    expect(result).toBeNull();
    expect(spyFetch).not.toHaveBeenCalled();
  });

  it('deleteRecord makes NO fetch call and resolves void', async () => {
    const spyFetch = vi.fn();
    const logs: string[] = [];
    const client = new NoopTwentyApiClient((msg) => logs.push(msg));
    const result = await client.deleteRecord('erpOrders', 'id-2');
    expect(result).toBeUndefined();
    expect(spyFetch).not.toHaveBeenCalled();
    expect(logs[0]).toContain('[dry-run]');
    expect(logs[0]).toContain('delete');
  });

  it('works with default logger (no args constructor)', async () => {
    const client = new NoopTwentyApiClient();
    // Should not throw
    await expect(client.createRecord('companies', {})).resolves.toEqual({ id: 'dryrun-companies' });
    await expect(client.updateRecord('companies', 'id', {})).resolves.toBeUndefined();
    await expect(client.findIdByErpId('erpOrders', 'x')).resolves.toBeNull();
    await expect(client.deleteRecord('companies', 'id')).resolves.toBeUndefined();
  });
});
