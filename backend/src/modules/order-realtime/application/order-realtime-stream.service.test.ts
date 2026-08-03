import { describe, expect, it, vi } from 'vitest';
import { OrderRealtimeStreamService, projectEventCursor } from './order-realtime-stream.service';

describe('order realtime stream cursor projection', () => {
  it('does not expose hidden cut-only progress to a status-only subscriber', () => {
    const cursor = projectEventCursor(
      { schemaVersion: 1, detailStatusRevision: 12 },
      {
        orderId: 42,
        commitSequence: 99,
        detailStatusRevision: null,
        cutRefsRevision: 8,
        domains: ['cut_refs'],
        detailIds: [1],
        occurredAt: '2026-08-03T00:00:00.000Z',
      },
      false,
    );

    expect(cursor).toEqual({ schemaVersion: 1, detailStatusRevision: 12 });
    expect(JSON.stringify(cursor)).not.toContain('99');
    expect(JSON.stringify(cursor)).not.toContain('8');
  });

  it('advances only affected components for a full-permission subscriber', () => {
    expect(
      projectEventCursor(
        { schemaVersion: 1, detailStatusRevision: 12, cutRefsRevision: 7 },
        {
          orderId: 42,
          commitSequence: 13,
          detailStatusRevision: 13,
          cutRefsRevision: null,
          domains: ['detail_status'],
          detailIds: null,
          occurredAt: '2026-08-03T00:00:00.000Z',
        },
        true,
      ),
    ).toEqual({ schemaVersion: 1, detailStatusRevision: 13, cutRefsRevision: 7 });
  });

  it('releases a dedicated client when LISTEN setup fails', async () => {
    vi.useFakeTimers();
    const client = {
      query: vi.fn().mockRejectedValue(new Error('listen unavailable')),
      release: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
    };
    const database = {
      connectDedicated: vi.fn().mockResolvedValue(client),
    };
    const service = new OrderRealtimeStreamService(
      database as never,
      {} as never,
      { catchupMs: 1000 } as never,
    );

    await (service as unknown as { connectListener(): Promise<void> }).connectListener();

    expect(client.release).toHaveBeenCalledWith(true);
    expect((service as unknown as { listenerClient: unknown }).listenerClient).toBeNull();
    await service.onModuleDestroy();
    vi.useRealTimers();
  });

  it('hard-closes a connected stream at the verified absolute token expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const currentUser = { id: 'user-1' };
    const reader = {
      authorize: vi.fn().mockResolvedValue({
        currentUser,
        permissionVariant: 'orders.read:all',
        cutRefsAllowed: false,
      }),
      loadSnapshot: vi.fn().mockResolvedValue({
        detailStatusRevision: 0,
        cutRefsRevision: 0,
      }),
      loadReplay: vi.fn().mockResolvedValue({
        highWatermark: 0,
        cursorFuture: false,
        retentionGap: false,
        overflow: false,
        currentCursor: { schemaVersion: 1, detailStatusRevision: 0 },
        events: [],
      }),
    };
    const response = {
      status: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      once: vi.fn(),
      write: vi.fn().mockReturnValue(true),
      end: vi.fn(),
      writableEnded: false,
    };
    const service = new OrderRealtimeStreamService(
      { isConfigured: true } as never,
      reader as never,
      {
        isStreamEnabledForUser: vi.fn().mockResolvedValue(true),
        maxConnections: 10,
        maxConnectionsPerUser: 2,
        maxQueueEvents: 250,
        maxDetailIds: 100,
      } as never,
    );

    await service.open({
      tokenUser: currentUser as never,
      accessTokenExpiresAt: new Date('2026-08-03T12:00:01.000Z'),
      orderId: 42,
      lastEventId: undefined,
      response: response as never,
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(response.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(response.end).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
    vi.useRealTimers();
  });

  it('resets instead of sending an oversized replay', async () => {
    const currentUser = { id: 'user-1' };
    const reader = {
      authorize: vi.fn().mockResolvedValue({
        currentUser,
        permissionVariant: 'status',
        cutRefsAllowed: false,
      }),
      loadSnapshot: vi.fn().mockResolvedValue({
        detailStatusRevision: 0,
        cutRefsRevision: 0,
      }),
      loadReplay: vi.fn().mockResolvedValue({
        highWatermark: 300,
        cursorFuture: false,
        retentionGap: false,
        overflow: true,
        currentCursor: { schemaVersion: 1, detailStatusRevision: 300 },
        events: [],
      }),
    };
    const response = {
      status: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      once: vi.fn(),
      write: vi.fn().mockReturnValue(true),
      end: vi.fn(),
      writableEnded: false,
    };
    const service = new OrderRealtimeStreamService(
      { isConfigured: true } as never,
      reader as never,
      {
        isStreamEnabledForUser: vi.fn().mockResolvedValue(true),
        maxConnections: 10,
        maxConnectionsPerUser: 2,
        maxQueueEvents: 250,
        maxDetailIds: 100,
      } as never,
    );

    await service.open({
      tokenUser: currentUser as never,
      accessTokenExpiresAt: new Date(Date.now() + 60_000),
      orderId: 42,
      lastEventId: undefined,
      response: response as never,
    });

    expect(reader.loadReplay).toHaveBeenCalledWith(
      42,
      { schemaVersion: 1, detailStatusRevision: 0 },
      false,
      250,
    );
    expect(response.write).toHaveBeenCalledWith(expect.stringContaining('event: order.reset'));
    expect(response.write).toHaveBeenCalledWith(expect.stringContaining('"reason":"buffer_overflow"'));

    await service.onModuleDestroy();
  });
});
