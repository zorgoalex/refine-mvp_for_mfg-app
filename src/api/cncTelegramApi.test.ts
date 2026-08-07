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

  it('downloads the detailed worker audit JSON with bounded filters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"format":"erp.cnc-telegram-worker-audit"}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': 'attachment; filename="telegram-worker-audit_2026-08-01_2026-08-06.json"',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await cncTelegramApi.exportWorkerLogs({
      dateFrom: '2026-08-01',
      dateTo: '2026-08-06',
      status: 'failed',
      messageType: 'svg',
      reasonCode: 'backend_ingest_failed',
      search: 'layout.svg',
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/v1/cnc-telegram/worker-logs/export?dateFrom=2026-08-01&dateTo=2026-08-06&status=failed&messageType=svg&reasonCode=backend_ingest_failed&search=layout.svg',
    );
    expect(result.fileName).toBe('telegram-worker-audit_2026-08-01_2026-08-06.json');
    await expect(result.blob.text()).resolves.toContain('erp.cnc-telegram-worker-audit');
  });

  it('configures auto-cut status with an idempotency header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        settingEnabled: true,
        requestId: 'request-1',
        auditId: 'audit-1',
        completedPacketCount: 4,
        matchedDetailCount: 3,
        wholeOrderCount: 1,
        changedOrderCount: 2,
        changedDetailCount: 3,
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await cncTelegramApi.configureAutoCutStatus(true, 'cnc-auto-cut-status:test');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/cnc-telegram/auto-cut-status');
    const request = fetchMock.mock.calls[0]?.[1];
    expect(request).toEqual(expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    }));
    expect(new Headers(request?.headers).get('Idempotency-Key')).toBe(
      'cnc-auto-cut-status:test',
    );
  });
});
