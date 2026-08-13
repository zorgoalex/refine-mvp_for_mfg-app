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

  it('submits manual SVG uploads with idempotency header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          packet: { packetId: 'p1' },
          requestId: 'r1',
          applied: true,
          ignoredStaleSourceVersion: false,
          cutJobId: 42,
          cutResultId: 100,
          cutJobPath: '/cut?job=42',
          createdMdfMachineFileCard: true,
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await cncTelegramApi.manualSvgUpload({
      selectedOrderIds: [1],
      createMdfMachineFileCard: true,
      matchMode: 'informational',
      requestedCutJobId: 777,
      svgContentHash: 'a'.repeat(64),
      cutLayout: {
        status: 'valid',
        reasons: [],
        sheet: { widthMm: 2070, heightMm: 2800 },
        items: [],
      },
      items: [{
        sourceItemKey: 'i1',
        orderName: '2689',
        detailNumber: 31,
        widthMm: 497,
        heightMm: 477,
        quantity: 1,
        source: 'vector',
        confidence: 0.99,
      }],
    }, 'manual-svg:key-1');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/cnc-telegram/manual-svg-upload');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('manual-svg:key-1');
    expect(JSON.parse(String(init.body))).toMatchObject({
      selectedOrderIds: [1],
      createMdfMachineFileCard: true,
      matchMode: 'informational',
      requestedCutJobId: 777,
    });
  });

  it('creates manual SVG comment presets with idempotency header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          presetId: 1,
          label: 'Переделка',
          commentText: 'переделка',
          category: 'rework',
          isActive: true,
          sortOrder: 500,
          version: 1,
          createdAt: '2026-08-12T00:00:00.000Z',
          updatedAt: '2026-08-12T00:00:00.000Z',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await cncTelegramApi.createManualSvgCommentPreset({
      label: 'Переделка',
      commentText: 'переделка',
      category: 'rework',
    }, 'manual-svg-preset:key-1');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/cnc-telegram/manual-svg-comment-presets');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('manual-svg-preset:key-1');
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

  it('lists, downloads and restores order-scoped Telegram screenshots', async () => {
    const packetId = '00000000-0000-4000-8000-000000000001';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        orderId: 2700, generatedAt: '2026-08-07T10:00:00.000Z',
        originalRetentionDays: 30, screenshots: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(new Blob(['preview'], { type: 'image/jpeg' }), {
        status: 200, headers: { 'Content-Type': 'image/jpeg' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        requestId: '00000000-0000-4000-8000-000000000002', packetId,
        status: 'pending', requestedAt: '2026-08-07T10:00:00.000Z', availableUntil: null,
      }), { status: 202, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await cncTelegramApi.orderScreenshots(2700);
    await cncTelegramApi.downloadOrderScreenshotPreview(2700, packetId);
    await cncTelegramApi.restoreOrderScreenshot(2700, packetId);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/cnc-telegram/orders/2700/screenshots');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/cnc-telegram/orders/2700/screenshots/${packetId}/preview`);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`/api/v1/cnc-telegram/orders/2700/screenshots/${packetId}/restore`);
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ method: 'POST' }));
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
