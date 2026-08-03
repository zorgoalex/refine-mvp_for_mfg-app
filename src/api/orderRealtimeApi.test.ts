import { beforeEach, describe, expect, it, vi } from 'vitest';
import { httpClient } from './httpClient';
import { orderRealtimeApi, OrderRealtimeHttpError } from './orderRealtimeApi';

describe('orderRealtimeApi', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps snapshot ETag and authoritative cursor from response headers', async () => {
    vi.spyOn(httpClient, 'raw').mockResolvedValue(new Response(JSON.stringify({
      orderId: 42,
      streamEnabled: true,
      streamCursor: 'body-cursor',
      cutRefsAccess: 'denied',
      details: [{ detailId: 7, productionStatusId: 3 }],
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ETag: '"state-1"',
        'X-ERP-Stream-Cursor': 'header-cursor',
        'X-ERP-Realtime-Enabled': 'true',
      },
    }));

    await expect(orderRealtimeApi.getDetailLiveState(42, { etag: '"state-0"' }))
      .resolves.toMatchObject({
        status: 200,
        etag: '"state-1"',
        streamCursor: 'header-cursor',
        streamEnabled: true,
      });
    const options = vi.mocked(httpClient.raw).mock.calls[0][1];
    expect(new Headers(options?.headers).get('If-None-Match')).toBe('"state-0"');
  });

  it('accepts 304 without reading a body', async () => {
    vi.spyOn(httpClient, 'raw').mockResolvedValue(new Response(null, {
      status: 304,
      headers: {
        ETag: '"state-1"',
        'X-ERP-Stream-Cursor': 'snapshot-cursor',
        'X-ERP-Realtime-Enabled': 'true',
      },
    }));

    await expect(orderRealtimeApi.getDetailLiveState(42, { etag: '"state-1"' }))
      .resolves.toEqual({
        status: 304,
        etag: '"state-1"',
        streamCursor: 'snapshot-cursor',
        streamEnabled: true,
        snapshot: null,
      });
  });

  it('passes only the supplied snapshot cursor to the SSE request', async () => {
    vi.spyOn(httpClient, 'raw').mockResolvedValue(new Response(null, { status: 204 }));
    const controller = new AbortController();

    await orderRealtimeApi.openLiveEvents(42, 'snapshot-cursor', controller.signal);

    const options = vi.mocked(httpClient.raw).mock.calls[0][1];
    expect(new Headers(options?.headers).get('Last-Event-ID')).toBe('snapshot-cursor');
    expect(options?.signal).toBe(controller.signal);
  });

  it('rejects object-shaped values in scalar detail fields', async () => {
    vi.spyOn(httpClient, 'raw').mockResolvedValue(new Response(JSON.stringify({
      orderId: 42,
      streamEnabled: true,
      streamCursor: 'cursor',
      cutRefsAccess: 'denied',
      details: [{ detailId: 7, productionStatusId: { id: 3 } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(orderRealtimeApi.getDetailLiveState(42)).rejects.toBeInstanceOf(
      OrderRealtimeHttpError,
    );
  });
});
