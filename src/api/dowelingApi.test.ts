import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCreateDowelingRequest,
  createDowelingIdempotencyKey,
  dowelingApi,
} from './dowelingApi';

describe('dowelingApi', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubGlobal('crypto', { randomUUID: () => 'uuid-1' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('buildCreateDowelingRequest trims the name and carries ids + key', () => {
    expect(
      buildCreateDowelingRequest({
        dowelingOrderName: '  Тест присадка  ',
        designEngineerId: 3,
        paymentStatusId: 1,
        idempotencyKey: 'doweling-quick-create:uuid-1',
      }),
    ).toEqual({
      dowelingOrderName: 'Тест присадка',
      designEngineerId: 3,
      paymentStatusId: 1,
      idempotencyKey: 'doweling-quick-create:uuid-1',
    });
  });

  it('createDowelingIdempotencyKey uses the prefix + a uuid', () => {
    expect(createDowelingIdempotencyKey()).toBe('doweling-quick-create:uuid-1');
    expect(createDowelingIdempotencyKey('custom')).toBe('custom:uuid-1');
  });

  it('create POSTs the request to /api/v1/doweling-orders', async () => {
    const response = {
      dowelingOrder: { dowelingOrderId: 7, dowelingOrderName: 'Тест присадка', version: 0 },
      requestId: 'request-1',
    };
    const fetchMock = mockFetch(response);

    await expect(
      dowelingApi.create({
        dowelingOrderName: 'Тест присадка',
        designEngineerId: 3,
        paymentStatusId: 1,
        idempotencyKey: 'doweling-quick-create:uuid-1',
      }),
    ).resolves.toEqual(response);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/doweling-orders');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
    const body = String(fetchMock.mock.calls[0][1]?.body);
    expect(body).toContain('"designEngineerId":3');
    expect(body).toContain('"paymentStatusId":1');
    expect(body).toContain('doweling-quick-create:uuid-1');
  });
});

function mockFetch(...bodies: unknown[]) {
  const fetchMock = vi.fn();
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
