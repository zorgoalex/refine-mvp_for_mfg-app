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
          cutJobPath: '/cut?cutJobId=42',
          createdMdfMachineFileCard: true,
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await cncTelegramApi.manualSvgUpload({
      selectedOrderIds: [1],
      createMdfMachineFileCard: true,
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
    });
  });

  it('creates a cut-job MDF card with idempotency header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          cutJobId: 42,
          cutResultId: 100,
          cardKind: 'bath',
          cardId: 'cut-result:100',
          workday: '2026-08-19',
          created: true,
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await cncTelegramApi.createMdfCard(42, 'cut-mdf-card:test-42');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/cnc-telegram/cut-jobs/42/mdf-card');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('cut-mdf-card:test-42');
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
});
