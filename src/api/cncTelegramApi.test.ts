import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cncTelegramApi } from './cncTelegramApi';

describe('cncTelegramApi', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('loads the current-day CNC Telegram projection through its own route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          workday: '2026-07-24',
          generatedAt: '2026-07-24T08:00:00.000Z',
          columns: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await cncTelegramApi.today({ date: '2026-07-24' });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/v1/cnc-telegram/today?date=2026-07-24',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('loads CNC Telegram projection for an order-search date range', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          workday: '2026-07-24',
          generatedAt: '2026-07-24T08:00:00.000Z',
          columns: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await cncTelegramApi.today({
      dateFrom: '2026-07-18',
      dateTo: '2026-07-24',
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/v1/cnc-telegram/today?dateFrom=2026-07-18&dateTo=2026-07-24',
    );
  });

  it('loads machine-file cutting sequence numbers for an order card', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ orderId: 2700, sequences: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await cncTelegramApi.orderCuttingSequences(2700);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/v1/cnc-telegram/orders/2700/cutting-sequences',
    );
  });
});
