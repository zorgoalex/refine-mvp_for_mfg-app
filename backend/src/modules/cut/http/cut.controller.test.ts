import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { CutService } from '../application/cut.service';
import type { CutJobDto } from '../dto/cut.dto';
import {
  CutController,
  parseAddItemsRequest,
  parseCreateCutJobRequest,
  parseCutJobId,
  parseEligibleCriteria,
  parseSetProfileBody,
  parseSetSheetMaterialBody,
  parseSetCombineFilmsBody,
  parseSetPdfTemplateBody,
  parseSetSplitByMaterialBody,
  parseSaveManualLayoutBody,
  parseVariant,
  parseOriginTopLeft,
  parseAxisOrigin,
  canonicalOriginTopLeft,
  parseCalculateBody,
} from './cut.controller';
import { CutPdfCache } from '../application/cut-pdf-cache';
import type { CutRuntimeConfigService } from './cut-runtime-config.service';

const TEST_COMMAND_ID = '11111111-1111-4111-8111-111111111111';

it('requires a stable commandId for calculate retries', () => {
  expect(parseCalculateBody({ version: 1, commandId: TEST_COMMAND_ID })).toEqual({
    version: 1,
    commandId: TEST_COMMAND_ID,
  });
  expect(() => parseCalculateBody({ version: 1 })).toThrow();
});

function currentUser(id = '7'): CurrentUser {
  return { id, username: 'cutter', role: 'operator', permissions: ['cut.view', 'cut.manage'] } as CurrentUser;
}

function jobDto(): CutJobDto {
  return {
    cutJobId: 42,
    name: 'J',
    status: 'draft',
    source: 'manual',
    version: 0,
    pdfPrewarmState: 'pending',
    failureCode: null,
    failureReason: null,
    paramProfileId: null,
    sheetMaterialTypeId: null,
    pdfTemplate: 'standard',
    combineFilms: false,
    splitByMaterial: true,
    materialNames: [],
    totals: { positions: 0, details: 0, area: 0, sheets: 0, materialsCount: 0, filmsCount: 0 },
    items: [],
    groups: [],
    // Task 7: renderToken is populated by getJob (aggregates job version + per-group manual tokens).
    renderToken: 'j0:',
  };
}

function createController(options: {
  flags?: { cutEnabled?: boolean; cutReadOnly?: boolean; cutAutoTrigger?: boolean };
  service?: Partial<CutService>;
  pdfCache?: CutPdfCache;
} = {}) {
  const runtimeConfig = {
    getFeatureFlags: () => ({
      cutEnabled: options.flags?.cutEnabled ?? true,
      cutReadOnly: options.flags?.cutReadOnly ?? false,
      cutAutoTrigger: options.flags?.cutAutoTrigger ?? false,
    }),
  } as unknown as CutRuntimeConfigService;
  const pdfCache = options.pdfCache ?? new CutPdfCache({ ttlMs: 1000 });
  // Task 7: provide a default getRenderCacheToken so group/job PDF tests don't need
  // to mock it explicitly. Returns a stable 'tok' sentinel.
  const defaultService: Partial<CutService> = {
    getRenderCacheToken: vi.fn(async () => 'tok'),
  };
  const service = { ...defaultService, ...options.service };
  return new CutController(service as unknown as CutService, runtimeConfig, pdfCache);
}

function fakeResponse() {
  const headers: Record<string, string> = {};
  const state = { status: 200, body: null as unknown, sent: null as unknown };
  const res = {
    setHeader: (k: string, v: string) => { headers[k] = v; },
    status: (code: number) => { state.status = code; return res; },
    json: (b: unknown) => { state.body = b; },
    send: (b: unknown) => { state.sent = b; },
  };
  return { res, headers, state };
}

describe('CutController', () => {
  it('fails closed (503) when the cut feature flag is disabled', async () => {
    const controller = createController({ flags: { cutEnabled: false } });
    await expect(
      controller.list({ user: currentUser() } as never),
    ).rejects.toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' } satisfies Partial<ApiError>);
  });

  it('requires an authenticated user', async () => {
    const controller = createController({});
    await expect(controller.list({} as never)).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    } satisfies Partial<ApiError>);
  });

  it('blocks mutations (503) when read-only mode is on', async () => {
    const controller = createController({ flags: { cutReadOnly: true } });
    await expect(
      controller.create({ user: currentUser() } as never, { name: 'Тест' }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'SERVICE_READ_ONLY' } satisfies Partial<ApiError>);
  });

  it('delegates create / calculate / archive to the service', async () => {
    const calls: string[] = [];
    const controller = createController({
      service: {
        createJob: vi.fn(async (c) => { calls.push(`create:${c.dto.name}`); return jobDto(); }),
        calculate: vi.fn(async (c) => { calls.push(`calc:${c.cutJobId}:${c.version}`); return jobDto(); }),
        archive: vi.fn(async (c) => { calls.push(`archive:${c.cutJobId}:${c.version}`); return jobDto(); }),
      },
    });

    await expect(controller.create({ user: currentUser() } as never, { name: 'Тест' })).resolves.toMatchObject({ cutJobId: 42 });
    await controller.calculate({ user: currentUser() } as never, '42', { version: 3, commandId: TEST_COMMAND_ID });
    await controller.archive({ user: currentUser() } as never, '42', { version: 5 });
    expect(calls).toEqual(['create:Тест', 'calc:42:3', 'archive:42:5']);
  });

  it('serves eligible-details as a backend read (no Hasura)', async () => {
    const listEligibleDetails = vi.fn(async () => ({ details: [], noSheetSpecCount: 4 }));
    const controller = createController({ service: { listEligibleDetails } });
    const result = await controller.eligibleDetails({ user: currentUser() } as never, '42', { orderIds: '9,10' });
    expect(result.noSheetSpecCount).toBe(4);
    expect(listEligibleDetails).toHaveBeenCalledWith(
      expect.objectContaining({ criteria: expect.objectContaining({ orderIds: [9, 10] }) }),
    );
  });

  it('renders a sheet PNG to the response with the image content type', async () => {
    const png = Buffer.from('PNGDATA');
    const controller = createController({ service: { renderSheetPng: vi.fn(async () => png) } });
    const headers: Record<string, string> = {};
    let sent: Buffer | null = null;
    const res = {
      setHeader: (k: string, v: string) => { headers[k] = v; },
      send: (b: Buffer) => { sent = b; },
    };
    await controller.renderPng({ user: currentUser() } as never, '42', '100', '0', { preset: 'screen' }, res as never);
    expect(headers['Content-Type']).toBe('image/png');
    expect(sent).toBe(png);
  });

  it('PNG route: labels=off → showLabels:false; absent/other → showLabels:true', async () => {
    const calls: Array<{ showLabels: boolean | undefined }> = [];
    const renderSheetPng = vi.fn(async (q: { showLabels?: boolean }) => {
      calls.push({ showLabels: q.showLabels });
      return Buffer.from('PNG');
    });
    const controller = createController({ service: { renderSheetPng } });
    const fakeRes = {
      setHeader: () => undefined,
      send: () => undefined,
    };

    // labels=off → showLabels: false
    await controller.renderPng({ user: currentUser() } as never, '42', '100', '0', { preset: 'screen', labels: 'off' }, fakeRes as never);
    // no labels param → showLabels: true (default)
    await controller.renderPng({ user: currentUser() } as never, '42', '100', '0', { preset: 'screen' }, fakeRes as never);
    // labels=on → showLabels: true
    await controller.renderPng({ user: currentUser() } as never, '42', '100', '0', { preset: 'screen', labels: 'on' }, fakeRes as never);

    expect(calls[0]?.showLabels).toBe(false);
    expect(calls[1]?.showLabels).toBe(true);
    expect(calls[2]?.showLabels).toBe(true);
  });

  it('renders a sheet SVG with the svg content type', async () => {
    const controller = createController({ service: { renderSheetSvg: vi.fn(async () => '<svg/>') } });
    const { res, headers, state } = fakeResponse();
    await controller.renderSvg({ user: currentUser() } as never, '42', '100', '0', {}, res as never);
    expect(headers['Content-Type']).toBe('image/svg+xml');
    expect(state.sent).toBe('<svg/>');
  });

  it('group PDF: 202 + Retry-After on a cold cache, then 200 application/pdf once warm', async () => {
    const pdf = Buffer.from('%PDF-1');
    const renderGroupPdf = vi.fn(async () => pdf);
    const pdfCache = new CutPdfCache({ ttlMs: 1000 });
    const controller = createController({ service: { renderGroupPdf }, pdfCache });

    const cold = fakeResponse();
    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', {}, cold.res as never);
    expect(cold.state.status).toBe(202);
    expect(cold.headers['Retry-After']).toBe('2');
    expect(cold.headers['Cache-Control']).toBe('private, no-store, max-age=0');

    await pdfCache.whenIdle();

    const warm = fakeResponse();
    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', {}, warm.res as never);
    expect(warm.headers['Content-Type']).toBe('application/pdf');
    expect(warm.headers['Cache-Control']).toBe('private, no-store, max-age=0');
    expect(warm.state.sent).toBe(pdf);
    expect(renderGroupPdf).toHaveBeenCalledTimes(1);
  });

  it('group PDF: surfaces a deterministic render failure as an error (no 202 loop)', async () => {
    const renderGroupPdf = vi.fn(async () => { throw new ApiError(404, 'CUT_GROUP_SHEET_NOT_FOUND', 'no sheets'); });
    const pdfCache = new CutPdfCache({ ttlMs: 1000, failureTtlMs: 5000 });
    const controller = createController({ service: { renderGroupPdf }, pdfCache });

    // First call kicks the render and returns 202.
    const cold = fakeResponse();
    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', {}, cold.res as never);
    expect(cold.state.status).toBe(202);
    await pdfCache.whenIdle();

    // Retry surfaces the ApiError instead of looping 202 forever.
    const warm = fakeResponse();
    await expect(
      controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', {}, warm.res as never),
    ).rejects.toMatchObject({ statusCode: 404, code: 'CUT_GROUP_SHEET_NOT_FOUND' });
  });

  it('job PDF: discriminates the cache by version and serves the whole-job PDF when warm', async () => {
    const pdf = Buffer.from('%PDF-job');
    const renderJobPdf = vi.fn(async () => pdf);
    const getJob = vi.fn(async () => ({ ...jobDto(), status: 'ready', version: 7 }));
    const setPdfPrewarmState = vi.fn(async () => undefined);
    const pdfCache = new CutPdfCache({ ttlMs: 1000 });
    const controller = createController({ service: { renderJobPdf, getJob, setPdfPrewarmState }, pdfCache });

    const cold = fakeResponse();
    await controller.exportJobPdf({ user: currentUser() } as never, '42', {}, cold.res as never);
    expect(cold.state.status).toBe(202);

    await pdfCache.whenIdle();

    const warm = fakeResponse();
    await controller.exportJobPdf({ user: currentUser() } as never, '42', {}, warm.res as never);
    expect(warm.headers['Content-Type']).toBe('application/pdf');
    expect(warm.state.sent).toBe(pdf);
    expect(renderJobPdf).toHaveBeenCalledTimes(1);
  });

  // Task 7 FIX 2: variant is a cache-key dimension — auto and active must not collide.
  it('FIX 2: group PDF auto and active do NOT share a cache slot (same layout token)', async () => {
    const renderGroupPdf = vi.fn(async (q: { variant?: string }) =>
      Buffer.from(q.variant === 'active' ? '%PDF-active' : '%PDF-auto'));
    // Same token for both → only `variant` separates the keys.
    const getRenderCacheToken = vi.fn(async () => 'tok');
    const pdfCache = new CutPdfCache({ ttlMs: 5000 });
    const controller = createController({ service: { renderGroupPdf, getRenderCacheToken }, pdfCache });

    // Warm both variants.
    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', { variant: 'auto' }, fakeResponse().res as never);
    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', { variant: 'active' }, fakeResponse().res as never);
    await pdfCache.whenIdle();

    const autoWarm = fakeResponse();
    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', { variant: 'auto' }, autoWarm.res as never);
    const activeWarm = fakeResponse();
    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', { variant: 'active' }, activeWarm.res as never);

    // Each variant gets ITS OWN bytes — no cross-serving from one shared slot.
    expect(autoWarm.state.sent).toEqual(Buffer.from('%PDF-auto'));
    expect(activeWarm.state.sent).toEqual(Buffer.from('%PDF-active'));
    expect(renderGroupPdf).toHaveBeenCalledTimes(2);
  });

  // Task 7 FIX 2: a render-token change (manual save / active flip) busts the cache.
  it('FIX 2: group PDF re-renders after the render token changes', async () => {
    let n = 0;
    const renderGroupPdf = vi.fn(async () => Buffer.from(`%PDF-${++n}`));
    let token = 'tok-v1';
    const getRenderCacheToken = vi.fn(async () => token);
    const pdfCache = new CutPdfCache({ ttlMs: 5000 });
    const controller = createController({ service: { renderGroupPdf, getRenderCacheToken }, pdfCache });

    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', { variant: 'active' }, fakeResponse().res as never);
    await pdfCache.whenIdle();
    // Manual save changes the layout token.
    token = 'tok-v2';
    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', { variant: 'active' }, fakeResponse().res as never);
    await pdfCache.whenIdle();

    const after = fakeResponse();
    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', { variant: 'active' }, after.res as never);
    expect(after.state.sent).toEqual(Buffer.from('%PDF-2'));
    expect(renderGroupPdf).toHaveBeenCalledTimes(2);
  });

  // Task 7 FIX 3 + FIX 4: prewarm (post-calculate) and the REAL FE export must share
  // the SAME key — same token AND same `variant` dimension. The FE always passes
  // job.renderToken → variant=active, so the prewarm must warm the `active` slot,
  // not `auto`. Otherwise the first export is a cold synchronous miss.
  it('FIX 3/4: post-calculate prewarm warms the variant=active key the FE export reads (first export is warm)', async () => {
    const pdf = Buffer.from('%PDF-job');
    const renderJobPdf = vi.fn(async () => pdf);
    const calculate = vi.fn(async () => ({ ...jobDto(), status: 'ready' as const, version: 7 }));
    const getJob = vi.fn(async () => ({ ...jobDto(), status: 'ready' as const, version: 7, renderToken: 'jtok' }));
    // getRenderCacheToken({cutJobId}) === job.renderToken from getJob.
    const getRenderCacheToken = vi.fn(async () => 'jtok');
    const setPdfPrewarmState = vi.fn(async () => undefined);
    const pdfCache = new CutPdfCache({ ttlMs: 5000 });
    const controller = createController({
      service: { calculate, renderJobPdf, getJob, getRenderCacheToken, setPdfPrewarmState },
      pdfCache,
    });

    // calculate → fires fire-and-forget prewarm (status ready).
    await controller.calculate({ user: currentUser() } as never, '42', { version: 0, commandId: TEST_COMMAND_ID });
    // Wait for the async prewarm chain (getRenderCacheToken → ensure → render) to register.
    for (let i = 0; i < 50 && renderJobPdf.mock.calls.length === 0; i++) await Promise.resolve();
    await pdfCache.whenIdle();

    // FIX 4: the prewarm rendered the ACTIVE variant (what the FE surfaces), not auto.
    expect(renderJobPdf).toHaveBeenCalledWith(expect.objectContaining({ variant: 'active' }));

    // The REAL FE export passes job.renderToken → variant=active. It must be served WARM
    // from the prewarmed slot (identical id + variant + token + orientation).
    const warm = fakeResponse();
    await controller.exportJobPdf({ user: currentUser() } as never, '42', { variant: 'active', axisOrigin: 'bottom-left' }, warm.res as never);
    expect(warm.headers['Content-Type']).toBe('application/pdf');
    expect(warm.state.sent).toBe(pdf);
    expect(renderJobPdf).toHaveBeenCalledTimes(1); // prewarm rendered once; export reused it
  });

  it('parses ids, bodies, and criteria', () => {
    expect(parseCutJobId('42')).toBe(42);
    expect(() => parseCutJobId('0')).toThrow(ApiError);
    expect(parseCreateCutJobRequest({ name: 'Тест', detailIds: [1, 2] }).detailIds).toEqual([1, 2]);
    expect(() => parseCreateCutJobRequest({ name: '' })).toThrow(ApiError);
    expect(parseAddItemsRequest({ detailIds: [3], version: 2 }).version).toBe(2);
    expect(parseEligibleCriteria({ orderIds: '9,10', filmIds: '5' })).toMatchObject({ orderIds: [9, 10], filmIds: [5] });
  });

  // Task 7: parseVariant
  it('parseVariant defaults to auto and maps manual/active (R25 MAJOR: no default flip)', () => {
    expect(parseVariant(undefined)).toBe('auto');
    expect(parseVariant('')).toBe('auto');
    expect(parseVariant('MANUAL')).toBe('manual');
    expect(parseVariant('manual')).toBe('manual');
    expect(parseVariant('active')).toBe('active');
    expect(parseVariant('ACTIVE')).toBe('active');
    expect(parseVariant('unknown')).toBe('auto');
  });

  // Origin top-left: default ON; only explicit 'raw' selects the legacy 90° CW.
  it('parseOriginTopLeft defaults to true and only false on explicit raw', () => {
    expect(parseOriginTopLeft(undefined)).toBe(true);
    expect(parseOriginTopLeft('')).toBe(true);
    expect(parseOriginTopLeft('tl')).toBe(true);
    expect(parseOriginTopLeft('anything')).toBe(true);
    expect(parseOriginTopLeft('raw')).toBe(false);
    expect(parseOriginTopLeft('RAW')).toBe(false);
  });

  it('parseAxisOrigin preserves old clients as top-left and accepts only explicit bottom-left', () => {
    expect(parseAxisOrigin(undefined)).toBe('top-left');
    expect(parseAxisOrigin('')).toBe('top-left');
    expect(parseAxisOrigin('top-left')).toBe('top-left');
    expect(parseAxisOrigin('anything')).toBe('top-left');
    expect(parseAxisOrigin('bottom-left')).toBe('bottom-left');
    expect(parseAxisOrigin('BOTTOM-LEFT')).toBe('bottom-left');
  });

  it('canonicalizes bottom-left to the RAW/CW orientation path', () => {
    expect(canonicalOriginTopLeft(true, 'bottom-left')).toBe(false);
    expect(canonicalOriginTopLeft(false, 'bottom-left')).toBe(false);
    expect(canonicalOriginTopLeft(true, 'top-left')).toBe(true);
    expect(canonicalOriginTopLeft(false, 'top-left')).toBe(false);
  });

  // R2-round2 finding #2: the RAW half must not be silently dead — the render
  // endpoints forward the parsed origin into the service render call.
  it('PNG/SVG canonicalize bottom-left to RAW while preserving top-left clients', async () => {
    const pngCalls: Array<boolean | undefined> = [];
    const svgCalls: Array<boolean | undefined> = [];
    const renderSheetPng = vi.fn(async (q: { originTopLeft?: boolean }) => { pngCalls.push(q.originTopLeft); return Buffer.from('P'); });
    const renderSheetSvg = vi.fn(async (q: { originTopLeft?: boolean }) => { svgCalls.push(q.originTopLeft); return '<svg/>'; });
    const controller = createController({ service: { renderSheetPng, renderSheetSvg } });
    const noop = { setHeader: () => undefined, send: () => undefined };

    await controller.renderPng({ user: currentUser() } as never, '42', '100', '0', { preset: 'screen' }, noop as never);
    await controller.renderPng({ user: currentUser() } as never, '42', '100', '0', { preset: 'screen', origin: 'raw' }, noop as never);
    await controller.renderSvg({ user: currentUser() } as never, '42', '100', '0', {}, noop as never);
    await controller.renderSvg({ user: currentUser() } as never, '42', '100', '0', { origin: 'raw' }, noop as never);
    await controller.renderPng({ user: currentUser() } as never, '42', '100', '0', { preset: 'screen', origin: 'tl', axisOrigin: 'bottom-left' }, noop as never);
    await controller.renderSvg({ user: currentUser() } as never, '42', '100', '0', { origin: 'tl', axisOrigin: 'bottom-left' }, noop as never);

    expect(pngCalls).toEqual([true, false, false]);
    expect(svgCalls).toEqual([true, false, false]);
  });

  // R1: origin (TL/RAW) is a PDF cache-key dimension — a top-left and a raw render
  // produce different bytes for the same layout+orientation and must not collide.
  it('group PDF: origin=tl and origin=raw do NOT share a cache slot (same token)', async () => {
    const renderGroupPdf = vi.fn(async (q: { originTopLeft?: boolean }) =>
      Buffer.from(q.originTopLeft ? '%PDF-tl' : '%PDF-raw'));
    const getRenderCacheToken = vi.fn(async () => 'tok');
    const pdfCache = new CutPdfCache({ ttlMs: 5000 });
    const controller = createController({ service: { renderGroupPdf, getRenderCacheToken }, pdfCache });

    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', {}, fakeResponse().res as never); // default tl
    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', { origin: 'raw' }, fakeResponse().res as never);
    await pdfCache.whenIdle();

    const tlWarm = fakeResponse();
    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', {}, tlWarm.res as never);
    const rawWarm = fakeResponse();
    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', { origin: 'raw' }, rawWarm.res as never);

    expect(tlWarm.state.sent).toEqual(Buffer.from('%PDF-tl'));
    expect(rawWarm.state.sent).toEqual(Buffer.from('%PDF-raw'));
    expect(renderGroupPdf).toHaveBeenCalledTimes(2);
  });

  // The current FE surfaces RAW/CW layout transform plus bottom-left display axis.
  it('prewarm warms the surfaced bottom-left axis and that export is served warm', async () => {
    const pdf = Buffer.from('%PDF-job-tl');
    const renderJobPdf = vi.fn(async () => pdf);
    const calculate = vi.fn(async () => ({ ...jobDto(), status: 'ready' as const, version: 7 }));
    const getJob = vi.fn(async () => ({ ...jobDto(), status: 'ready' as const, version: 7, renderToken: 'jtok' }));
    const getRenderCacheToken = vi.fn(async () => 'jtok');
    const setPdfPrewarmState = vi.fn(async () => undefined);
    const pdfCache = new CutPdfCache({ ttlMs: 5000 });
    const controller = createController({
      service: { calculate, renderJobPdf, getJob, getRenderCacheToken, setPdfPrewarmState },
      pdfCache,
    });

    await controller.calculate({ user: currentUser() } as never, '42', { version: 0, commandId: TEST_COMMAND_ID });
    for (let i = 0; i < 50 && renderJobPdf.mock.calls.length === 0; i++) await Promise.resolve();
    await pdfCache.whenIdle();

    expect(renderJobPdf).toHaveBeenCalledWith(expect.objectContaining({
      originTopLeft: false,
      axisOrigin: 'bottom-left',
    }));

    // FE explicitly sends bottom-left; absent axisOrigin remains top-left for old clients.
    const warm = fakeResponse();
    await controller.exportJobPdf({ user: currentUser() } as never, '42', { variant: 'active', axisOrigin: 'bottom-left' }, warm.res as never);
    expect(warm.state.sent).toBe(pdf);
    expect(renderJobPdf).toHaveBeenCalledTimes(1);
  });

  // Variant B Task 11: GET /cut-jobs/sheet-types — cut.view-gated sheet lookup.
  it('listSheetTypes: worker (cut.view only, no sheet_materials.view) gets sheet type options', async () => {
    const sheetTypes = [
      { sheetMaterialTypeId: 3, name: 'ЛДСП 16мм', widthMm: 2750, heightMm: 1830, isCuttable: true },
    ];
    const listSheetTypesForCut = vi.fn(async () => sheetTypes);
    const controller = createController({ service: { listSheetTypesForCut } });
    // worker has cut.view but NOT sheet_materials.view
    const workerUser: CurrentUser = {
      id: '20',
      username: 'worker1',
      role: 'worker',
      permissions: ['cut.view'],
    } as CurrentUser;
    const result = await controller.listSheetTypes({ user: workerUser } as never);
    expect(result).toEqual(sheetTypes);
    expect(listSheetTypesForCut).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser: workerUser }),
    );
  });

  it('listSheetTypes: 401 without an authenticated user', async () => {
    const controller = createController({});
    await expect(controller.listSheetTypes({} as never)).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    } satisfies Partial<ApiError>);
  });

  it('listSheetTypes: 503 when the cut feature flag is disabled', async () => {
    const controller = createController({ flags: { cutEnabled: false } });
    await expect(
      controller.listSheetTypes({ user: currentUser() } as never),
    ).rejects.toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' } satisfies Partial<ApiError>);
  });
});

describe('parseSetProfileBody', () => {
  it('accepts a positive id or null + nonnegative version', () => {
    expect(parseSetProfileBody({ paramProfileId: 5, version: 2 })).toEqual({ paramProfileId: 5, version: 2 });
    expect(parseSetProfileBody({ paramProfileId: null, version: 0 })).toEqual({ paramProfileId: null, version: 0 });
  });
  it('rejects a non-integer / negative id, missing version, or extra fields (.strict)', () => {
    expect(() => parseSetProfileBody({ paramProfileId: 0, version: 1 })).toThrow();
    expect(() => parseSetProfileBody({ paramProfileId: 1.5, version: 1 })).toThrow();
    expect(() => parseSetProfileBody({ paramProfileId: 1 })).toThrow();
    expect(() => parseSetProfileBody({ paramProfileId: 1, version: 1, extra: true })).toThrow();
  });
});

it('PATCH setProfile delegates parsed args to CutService.setProfile', async () => {
  const serviceReturn = jobDto();
  const service = {
    setProfile: vi.fn(async () => serviceReturn),
  };
  const controller = createController({ service });
  const request = { user: currentUser(), requestId: 'req-xyz' } as never;
  const dto = await controller.setProfile(request, '42', { paramProfileId: 5, version: 2 });
  expect(service.setProfile).toHaveBeenCalledWith(expect.objectContaining({
    cutJobId: 42, paramProfileId: 5, version: 2, requestId: 'req-xyz',
  }));
  expect(dto).toBe(serviceReturn);
});

describe('parseSetSheetMaterialBody', () => {
  it('accepts a numeric sheet id + version', () => {
    expect(parseSetSheetMaterialBody({ sheetMaterialTypeId: 7, version: 2 })).toEqual({ sheetMaterialTypeId: 7, version: 2 });
  });
  it('accepts null (clear override)', () => {
    expect(parseSetSheetMaterialBody({ sheetMaterialTypeId: null, version: 0 })).toEqual({ sheetMaterialTypeId: null, version: 0 });
  });
  it('rejects a negative version', () => {
    expect(() => parseSetSheetMaterialBody({ sheetMaterialTypeId: 7, version: -1 })).toThrow();
  });
  it('rejects a non-integer sheet id', () => {
    expect(() => parseSetSheetMaterialBody({ sheetMaterialTypeId: 1.5, version: 0 })).toThrow();
  });
});

it('PATCH setSheetMaterial delegates parsed args to CutService.setSheetMaterial', async () => {
  const serviceReturn = jobDto();
  const service = {
    setSheetMaterial: vi.fn(async () => serviceReturn),
  };
  const controller = createController({ service });
  const request = { user: currentUser(), requestId: 'req-sheet' } as never;
  const dto = await controller.setSheetMaterial(request, '42', { sheetMaterialTypeId: 7, version: 3 });
  expect(service.setSheetMaterial).toHaveBeenCalledWith(expect.objectContaining({
    cutJobId: 42, sheetMaterialTypeId: 7, version: 3, requestId: 'req-sheet',
  }));
  expect(dto).toBe(serviceReturn);
});

describe('parseSetCombineFilmsBody', () => {
  it('accepts a boolean + version', () => {
    expect(parseSetCombineFilmsBody({ combineFilms: true, version: 2 })).toEqual({ combineFilms: true, version: 2 });
  });
  it('rejects a non-boolean combineFilms', () => {
    expect(() => parseSetCombineFilmsBody({ combineFilms: 'yes', version: 0 })).toThrow();
  });
  it('rejects a negative version', () => {
    expect(() => parseSetCombineFilmsBody({ combineFilms: true, version: -1 })).toThrow();
  });
  it('rejects unknown keys (strict)', () => {
    expect(() => parseSetCombineFilmsBody({ combineFilms: true, version: 0, extra: 1 })).toThrow();
  });
});

it('PATCH setCombineFilms delegates parsed args to CutService.setCombineFilms', async () => {
  const serviceReturn = jobDto();
  const service = {
    setCombineFilms: vi.fn(async () => serviceReturn),
  };
  const controller = createController({ service });
  const request = { user: currentUser(), requestId: 'req-combine' } as never;
  const dto = await controller.setCombineFilms(request, '42', { combineFilms: true, version: 3 });
  expect(service.setCombineFilms).toHaveBeenCalledWith(expect.objectContaining({
    cutJobId: 42, combineFilms: true, version: 3, requestId: 'req-combine',
  }));
  expect(dto).toBe(serviceReturn);
});

describe('parseSetSplitByMaterialBody', () => {
  it('accepts a boolean + version', () => {
    expect(parseSetSplitByMaterialBody({ splitByMaterial: false, version: 2 })).toEqual({ splitByMaterial: false, version: 2 });
  });
  it('rejects a non-boolean splitByMaterial', () => {
    expect(() => parseSetSplitByMaterialBody({ splitByMaterial: 'no', version: 0 })).toThrow();
  });
  it('rejects unknown keys (strict)', () => {
    expect(() => parseSetSplitByMaterialBody({ splitByMaterial: true, version: 0, extra: 1 })).toThrow();
  });
});

it('PATCH setSplitByMaterial delegates parsed args to CutService.setSplitByMaterial', async () => {
  const serviceReturn = jobDto();
  const service = {
    setSplitByMaterial: vi.fn(async () => serviceReturn),
  };
  const controller = createController({ service });
  const request = { user: currentUser(), requestId: 'req-split' } as never;
  const dto = await controller.setSplitByMaterial(request, '42', { splitByMaterial: false, version: 3 });
  expect(service.setSplitByMaterial).toHaveBeenCalledWith(expect.objectContaining({
    cutJobId: 42, splitByMaterial: false, version: 3, requestId: 'req-split',
  }));
  expect(dto).toBe(serviceReturn);
});

describe('parseSetPdfTemplateBody', () => {
  it('accepts a safe PDF template code', () => {
    expect(parseSetPdfTemplateBody({ pdfTemplate: 'bath_profiles' })).toEqual({ pdfTemplate: 'bath_profiles' });
  });
  it('rejects unsafe or unknown fields', () => {
    expect(() => parseSetPdfTemplateBody({ pdfTemplate: '../bad' })).toThrow();
    expect(() => parseSetPdfTemplateBody({ pdfTemplate: 'bath_profiles', version: 1 })).toThrow();
  });
});

it('PATCH setJobPdfTemplate delegates parsed args to CutService.setJobPdfTemplate', async () => {
  const serviceReturn = jobDto();
  const service = {
    setJobPdfTemplate: vi.fn(async () => serviceReturn),
  };
  const controller = createController({ service });
  const request = { user: currentUser(), requestId: 'req-job-template' } as never;
  const dto = await controller.setJobPdfTemplate(request, '42', { pdfTemplate: 'bath_profiles' });
  expect(service.setJobPdfTemplate).toHaveBeenCalledWith(expect.objectContaining({
    cutJobId: 42, pdfTemplate: 'bath_profiles', requestId: 'req-job-template',
  }));
  expect(dto).toBe(serviceReturn);
});

it('PATCH setGroupPdfTemplate delegates parsed args to CutService.setGroupPdfTemplate', async () => {
  const serviceReturn = jobDto();
  const service = {
    setGroupPdfTemplate: vi.fn(async () => serviceReturn),
  };
  const controller = createController({ service });
  const request = { user: currentUser(), requestId: 'req-group-template' } as never;
  const dto = await controller.setGroupPdfTemplate(request, '42', '100', { pdfTemplate: 'bath_profiles' });
  expect(service.setGroupPdfTemplate).toHaveBeenCalledWith(expect.objectContaining({
    cutJobId: 42, cutGroupId: 100, pdfTemplate: 'bath_profiles', requestId: 'req-group-template',
  }));
  expect(dto).toBe(serviceReturn);
});

describe('parseSaveManualLayoutBody', () => {
  it('parses a valid moves body', () => {
    const out = parseSaveManualLayoutBody({
      jobVersion: 3,
      active: true,
      placements: [{ itemId: 'det-1', instance: 1, sheetIndex: 0, xMm: 5, yMm: 7, rotated: false }],
      sheetTransforms: [{ sheetIndex: 0, rotationDeg: 270, mirrorHorizontal: true, mirrorVertical: false }],
      commandId: TEST_COMMAND_ID,
    });
    expect(out.jobVersion).toBe(3);
    expect(out.placements[0].itemId).toBe('det-1');
    expect(out.sheetTransforms[0]).toEqual({ sheetIndex: 0, rotationDeg: 270, mirrorHorizontal: true, mirrorVertical: false });
  });
  it('defaults transforms for older clients and rejects unsupported angles', () => {
    expect(parseSaveManualLayoutBody({ jobVersion: 1, active: true, placements: [], commandId: TEST_COMMAND_ID }).sheetTransforms).toEqual([]);
    expect(() => parseSaveManualLayoutBody({
      jobVersion: 1,
      active: true,
      placements: [],
      commandId: TEST_COMMAND_ID,
      sheetTransforms: [{ sheetIndex: 0, rotationDeg: 45, mirrorHorizontal: false, mirrorVertical: false }],
    })).toThrow();
  });
  it('rejects a body carrying geometry (width/height not allowed — strict)', () => {
    expect(() => parseSaveManualLayoutBody({
      jobVersion: 1,
      active: false,
      commandId: TEST_COMMAND_ID,
      placements: [{ itemId: 'det-1', instance: 1, sheetIndex: 0, xMm: 0, yMm: 0, rotated: false, widthMm: 999 }],
    })).toThrow();
  });
  it('rejects a move missing sheetIndex', () => {
    expect(() => parseSaveManualLayoutBody({
      jobVersion: 1,
      active: false,
      commandId: TEST_COMMAND_ID,
      placements: [{ itemId: 'det-1', instance: 1, xMm: 0, yMm: 0, rotated: false }],
    })).toThrow();
  });
});

it('PATCH saveManualLayout delegates parsed args to CutService.saveManualLayout', async () => {
  const serviceReturn = jobDto();
  const service = {
    saveManualLayout: vi.fn(async () => serviceReturn),
  };
  const controller = createController({ service });
  const request = { user: currentUser(), requestId: 'req-manual' } as never;
  const placements = [{ itemId: 'det-1', instance: 1, sheetIndex: 0, xMm: 5, yMm: 7, rotated: false }];
  const dto = await controller.saveManualLayout(request, '42', '100', {
    jobVersion: 3,
    active: true,
    placements,
    commandId: TEST_COMMAND_ID,
  });
  expect(service.saveManualLayout).toHaveBeenCalledWith(expect.objectContaining({
    cutJobId: 42, cutGroupId: 100, jobVersion: 3, active: true, placements, requestId: 'req-manual',
  }));
  expect(dto).toBe(serviceReturn);
});
