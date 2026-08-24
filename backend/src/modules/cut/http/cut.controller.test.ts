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
  parseListCutJobsQuery,
  parseSetProfileBody,
  parseSetSheetMaterialBody,
  parseSetCombineFilmsBody,
  parseSetNameBody,
  parseSetPdfTemplateBody,
  parseSetRotationAllowedBody,
  parseSetSplitByMaterialBody,
  parseSetTextureDirectionBody,
  parseSaveManualLayoutBody,
  parseVariant,
  parseOriginTopLeft,
  parseAxisOrigin,
  canonicalOriginTopLeft,
  parseCalculateBody,
  parseMdfBoardCardBody,
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

it('requires an expected result id for MDF-board card mutations', () => {
  expect(parseMdfBoardCardBody({ expectedCutResultId: 9 })).toEqual({ expectedCutResultId: 9 });
  expect(() => parseMdfBoardCardBody({})).toThrow();
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
    createdAt: '2026-08-07T00:00:00.000Z',
    version: 0,
    pdfPrewarmState: 'pending',
    failureCode: null,
    failureReason: null,
    paramProfileId: null,
    sheetMaterialTypeId: null,
    pdfTemplate: 'standard',
    combineFilms: false,
    splitByMaterial: true,
    rotationAllowed: true,
    textureDirection: 'none',
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

  it('parses and delegates backend-side cut job list filters', async () => {
    expect(parseListCutJobsQuery({
      orderSearch: ' 2700 ',
      jobNumber: ' №67 ',
      createdFrom: '2026-08-01',
      createdTo: '2026-08-07',
    })).toEqual({
      orderSearch: '2700',
      jobNumber: '№67',
      createdFrom: '2026-08-01',
      createdTo: '2026-08-07',
    });
    expect(() => parseListCutJobsQuery({ createdFrom: '08.01.2026' })).toThrow();

    const listJobs = vi.fn(async () => [jobDto()]);
    const controller = createController({ service: { listJobs } });
    await controller.list(
      { user: currentUser(), requestId: 'req-list' } as never,
      { orderSearch: '2700', jobNumber: '67', createdFrom: '2026-08-01', createdTo: '2026-08-07' },
    );

    expect(listJobs).toHaveBeenCalledWith(expect.objectContaining({
      filters: {
        orderSearch: '2700',
        jobNumber: '67',
        createdFrom: '2026-08-01',
        createdTo: '2026-08-07',
      },
      requestId: 'req-list',
    }));
  });

  it('blocks mutations (503) when read-only mode is on', async () => {
    const controller = createController({ flags: { cutReadOnly: true } });
    await expect(
      controller.create({ user: currentUser() } as never, { name: 'Тест' }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'SERVICE_READ_ONLY' } satisfies Partial<ApiError>);
  });

  it('delegates create / calculate / archive and result-state commands to the service', async () => {
    const calls: string[] = [];
    const controller = createController({
      service: {
        createJob: vi.fn(async (c) => { calls.push(`create:${c.dto.name}`); return jobDto(); }),
        calculate: vi.fn(async (c) => { calls.push(`calc:${c.cutJobId}:${c.version}`); return jobDto(); }),
        archive: vi.fn(async (c) => { calls.push(`archive:${c.cutJobId}:${c.version}`); return jobDto(); }),
        createMdfBoardCard: vi.fn(async (c) => { calls.push(`mdf:${c.cutJobId}`); return jobDto(); }),
        deleteMdfBoardCard: vi.fn(async (c) => { calls.push(`mdfDelete:${c.cutJobId}`); return jobDto(); }),
        setCurrentResult: vi.fn(async (c) => { calls.push(`current:${c.cutJobId}:${c.resultNo}`); return jobDto(); }),
        archiveResult: vi.fn(async (c) => { calls.push(`archiveResult:${c.cutJobId}:${c.resultNo}`); return jobDto(); }),
        unarchiveResult: vi.fn(async (c) => { calls.push(`unarchiveResult:${c.cutJobId}:${c.resultNo}`); return jobDto(); }),
      },
    });

    await expect(controller.create({ user: currentUser() } as never, { name: 'Тест' })).resolves.toMatchObject({ cutJobId: 42 });
    await controller.calculate({ user: currentUser() } as never, '42', { version: 3, commandId: TEST_COMMAND_ID });
    await controller.archive({ user: currentUser() } as never, '42', { version: 5 });
    await controller.createMdfBoardCard({ user: currentUser(), requestId: 'req-mdf' } as never, '42', { expectedCutResultId: 9 });
    await controller.deleteMdfBoardCard({ user: currentUser(), requestId: 'req-mdf-delete' } as never, '42', { expectedCutResultId: 9 });
    await controller.setResultCurrent({ user: currentUser() } as never, '42', '2');
    await controller.archiveResult({ user: currentUser() } as never, '42', '3');
    await controller.unarchiveResult({ user: currentUser() } as never, '42', '4');
    expect(calls).toEqual([
      'create:Тест',
      'calc:42:3',
      'archive:42:5',
      'mdf:42',
      'mdfDelete:42',
      'current:42:2',
      'archiveResult:42:3',
      'unarchiveResult:42:4',
    ]);
  });

  it('serves eligible-details as a backend read (no Hasura)', async () => {
    const listEligibleDetails = vi.fn(async () => ({ details: [], noSheetSpecCount: 4 }));
    const controller = createController({ service: { listEligibleDetails } });
    const result = await controller.eligibleDetails(
      { user: currentUser() } as never,
      '42',
      { orderIds: '9,10', dateFrom: '2026-07-16', dateTo: '2026-07-26' },
    );
    expect(result.noSheetSpecCount).toBe(4);
    expect(listEligibleDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        criteria: expect.objectContaining({
          orderIds: [9, 10],
          dateFrom: '2026-07-16',
          dateTo: '2026-07-26',
        }),
      }),
    );
  });

  it('previews eligible-details before a cut job exists', async () => {
    const listEligibleDetails = vi.fn(async () => ({ details: [], noSheetSpecCount: 0 }));
    const controller = createController({ service: { listEligibleDetails } });
    const result = await controller.previewEligibleDetails(
      { user: currentUser(), requestId: 'req-preview' } as never,
      { filmIds: '7', dateFrom: '2026-07-01', dateTo: '2026-07-31' },
    );
    expect(result.details).toEqual([]);
    expect(listEligibleDetails).toHaveBeenCalledWith(expect.objectContaining({
      criteria: expect.objectContaining({ filmIds: [7], dateFrom: '2026-07-01', dateTo: '2026-07-31' }),
      includeAllStatuses: true,
      requestId: 'req-preview',
    }));
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

  it('passes renderStyle from sheet render routes to the cut service', async () => {
    const pngCalls: Array<{ renderStyle?: string }> = [];
    const svgCalls: Array<{ renderStyle?: string }> = [];
    const renderSheetPng = vi.fn(async (query: { renderStyle?: string }) => {
      pngCalls.push(query);
      return Buffer.from('PNG');
    });
    const renderSheetSvg = vi.fn(async (query: { renderStyle?: string }) => {
      svgCalls.push(query);
      return '<svg/>';
    });
    const controller = createController({ service: { renderSheetPng, renderSheetSvg } });
    const fakeRes = {
      setHeader: () => undefined,
      send: () => undefined,
    };

    await controller.renderPng({ user: currentUser() } as never, '42', '100', '0', { renderStyle: 'mdf_board_preview' }, fakeRes as never);
    await controller.renderSvg({ user: currentUser() } as never, '42', '100', '0', { renderStyle: 'mdf_board_preview' }, fakeRes as never);

    expect(pngCalls[0]?.renderStyle).toBe('mdf_board_preview');
    expect(svgCalls[0]?.renderStyle).toBe('mdf_board_preview');
  });

  it('passes a request-level PDF template to frozen group and whole-result exports', async () => {
    const pdf = Buffer.from('%PDF-result');
    const renderGroupPdf = vi.fn(async () => pdf);
    const renderJobPdf = vi.fn(async () => pdf);
    const controller = createController({ service: { renderGroupPdf, renderJobPdf } });

    await controller.exportResultGroupPdf(
      { user: currentUser() } as never,
      '42',
      '3',
      '100',
      { template: 'bath_profiles' },
      fakeResponse().res as never,
    );
    await controller.exportResultJobPdf(
      { user: currentUser() } as never,
      '42',
      '3',
      { template: 'bath_profiles' },
      fakeResponse().res as never,
    );

    expect(renderGroupPdf).toHaveBeenCalledWith(expect.objectContaining({
      cutJobId: 42,
      resultNo: 3,
      cutGroupId: 100,
      pdfTemplate: 'bath_profiles',
    }));
    expect(renderJobPdf).toHaveBeenCalledWith(expect.objectContaining({
      cutJobId: 42,
      resultNo: 3,
      pdfTemplate: 'bath_profiles',
    }));
  });

  it('leaves the frozen snapshot template unchanged when query override is omitted', async () => {
    const renderJobPdf = vi.fn(async () => Buffer.from('%PDF-result'));
    const controller = createController({ service: { renderJobPdf } });

    await controller.exportResultJobPdf(
      { user: currentUser() } as never,
      '42',
      '3',
      {},
      fakeResponse().res as never,
    );

    expect(renderJobPdf).toHaveBeenCalledWith(expect.objectContaining({ pdfTemplate: undefined }));
  });

  it('group PDF: renders fresh on every export request', async () => {
    let renderNo = 0;
    const renderGroupPdf = vi.fn(async () => Buffer.from(`%PDF-${++renderNo}`));
    const controller = createController({ service: { renderGroupPdf } });

    const first = fakeResponse();
    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', {}, first.res as never);
    expect(first.headers['Content-Type']).toBe('application/pdf');
    expect(first.headers['Cache-Control']).toBe('private, no-store, max-age=0');
    expect(first.state.sent).toEqual(Buffer.from('%PDF-1'));

    const second = fakeResponse();
    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', {}, second.res as never);
    expect(second.headers['Content-Type']).toBe('application/pdf');
    expect(second.state.sent).toEqual(Buffer.from('%PDF-2'));
    expect(renderGroupPdf).toHaveBeenCalledTimes(2);
  });

  it('group PDF: surfaces a deterministic render failure immediately', async () => {
    const renderGroupPdf = vi.fn(async () => { throw new ApiError(404, 'CUT_GROUP_SHEET_NOT_FOUND', 'no sheets'); });
    const controller = createController({ service: { renderGroupPdf } });

    await expect(
      controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', {}, fakeResponse().res as never),
    ).rejects.toMatchObject({ statusCode: 404, code: 'CUT_GROUP_SHEET_NOT_FOUND' });
  });

  it('job PDF: renders fresh on every export request', async () => {
    let renderNo = 0;
    const renderJobPdf = vi.fn(async () => Buffer.from(`%PDF-job-${++renderNo}`));
    const controller = createController({ service: { renderJobPdf } });

    const first = fakeResponse();
    await controller.exportJobPdf({ user: currentUser() } as never, '42', {}, first.res as never);
    expect(first.headers['Content-Type']).toBe('application/pdf');
    expect(first.state.sent).toEqual(Buffer.from('%PDF-job-1'));

    const second = fakeResponse();
    await controller.exportJobPdf({ user: currentUser() } as never, '42', {}, second.res as never);
    expect(second.headers['Content-Type']).toBe('application/pdf');
    expect(second.state.sent).toEqual(Buffer.from('%PDF-job-2'));
    expect(renderJobPdf).toHaveBeenCalledTimes(2);
  });

  it('group PDF: passes auto and active variants to separate fresh renders', async () => {
    const renderGroupPdf = vi.fn(async (q: { variant?: string }) =>
      Buffer.from(q.variant === 'active' ? '%PDF-active' : '%PDF-auto'));
    const controller = createController({ service: { renderGroupPdf } });

    const auto = fakeResponse();
    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', { variant: 'auto' }, auto.res as never);
    const active = fakeResponse();
    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', { variant: 'active' }, active.res as never);

    expect(auto.state.sent).toEqual(Buffer.from('%PDF-auto'));
    expect(active.state.sent).toEqual(Buffer.from('%PDF-active'));
    expect(renderGroupPdf).toHaveBeenCalledTimes(2);
  });

  it('group PDF: re-renders repeated active exports even when layout token is unchanged', async () => {
    let n = 0;
    const renderGroupPdf = vi.fn(async () => Buffer.from(`%PDF-${++n}`));
    const controller = createController({ service: { renderGroupPdf } });

    const first = fakeResponse();
    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', { variant: 'active', renderVersion: 'tok-v1' }, first.res as never);
    const second = fakeResponse();
    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', { variant: 'active', renderVersion: 'tok-v1' }, second.res as never);

    expect(first.state.sent).toEqual(Buffer.from('%PDF-1'));
    expect(second.state.sent).toEqual(Buffer.from('%PDF-2'));
    expect(renderGroupPdf).toHaveBeenCalledTimes(2);
  });

  it('post-calculate readiness render uses the surfaced active variant, while export still renders fresh', async () => {
    const pdf = Buffer.from('%PDF-job');
    const renderJobPdf = vi.fn(async () => pdf);
    const calculate = vi.fn(async () => ({ ...jobDto(), status: 'ready' as const, version: 7 }));
    const setPdfPrewarmState = vi.fn(async () => undefined);
    const controller = createController({
      service: { calculate, renderJobPdf, setPdfPrewarmState },
    });

    await controller.calculate({ user: currentUser() } as never, '42', { version: 0, commandId: TEST_COMMAND_ID });
    for (let i = 0; i < 50 && setPdfPrewarmState.mock.calls.length === 0; i++) await Promise.resolve();

    expect(renderJobPdf).toHaveBeenCalledWith(expect.objectContaining({ variant: 'active' }));
    expect(setPdfPrewarmState).toHaveBeenCalledWith(expect.objectContaining({ state: 'ready', version: 7 }));

    const fresh = fakeResponse();
    await controller.exportJobPdf({ user: currentUser() } as never, '42', { variant: 'active', axisOrigin: 'bottom-left' }, fresh.res as never);
    expect(fresh.headers['Content-Type']).toBe('application/pdf');
    expect(fresh.state.sent).toBe(pdf);
    expect(renderJobPdf).toHaveBeenCalledTimes(2);
  });

  it('parses ids, bodies, and criteria', () => {
    expect(parseCutJobId('42')).toBe(42);
    expect(() => parseCutJobId('0')).toThrow(ApiError);
    expect(parseCreateCutJobRequest({ name: 'Тест', detailIds: [1, 2] }).detailIds).toEqual([1, 2]);
    expect(() => parseCreateCutJobRequest({ name: '' })).toThrow(ApiError);
    expect(parseAddItemsRequest({ detailIds: [3], version: 2 }).version).toBe(2);
    expect(parseEligibleCriteria({ orderIds: '9,10', filmIds: '5', dateFrom: '2026-07-16', dateTo: '2026-07-26' })).toMatchObject({
      orderIds: [9, 10],
      filmIds: [5],
      dateFrom: '2026-07-16',
      dateTo: '2026-07-26',
    });
    expect(() => parseEligibleCriteria({ dateFrom: '16.07.2026' })).toThrow(ApiError);
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

  it('group PDF: origin=tl and origin=raw are passed to separate fresh renders', async () => {
    const renderGroupPdf = vi.fn(async (q: { originTopLeft?: boolean }) =>
      Buffer.from(q.originTopLeft ? '%PDF-tl' : '%PDF-raw'));
    const controller = createController({ service: { renderGroupPdf } });

    const tl = fakeResponse();
    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', {}, tl.res as never); // default tl
    const raw = fakeResponse();
    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', { origin: 'raw' }, raw.res as never);

    expect(tl.state.sent).toEqual(Buffer.from('%PDF-tl'));
    expect(raw.state.sent).toEqual(Buffer.from('%PDF-raw'));
    expect(renderGroupPdf).toHaveBeenCalledTimes(2);
  });

  it('prewarm uses the surfaced bottom-left axis and export still renders fresh', async () => {
    const pdf = Buffer.from('%PDF-job-tl');
    const renderJobPdf = vi.fn(async () => pdf);
    const calculate = vi.fn(async () => ({ ...jobDto(), status: 'ready' as const, version: 7 }));
    const setPdfPrewarmState = vi.fn(async () => undefined);
    const controller = createController({
      service: { calculate, renderJobPdf, setPdfPrewarmState },
    });

    await controller.calculate({ user: currentUser() } as never, '42', { version: 0, commandId: TEST_COMMAND_ID });
    for (let i = 0; i < 50 && setPdfPrewarmState.mock.calls.length === 0; i++) await Promise.resolve();

    expect(renderJobPdf).toHaveBeenCalledWith(expect.objectContaining({
      originTopLeft: false,
      axisOrigin: 'bottom-left',
    }));

    // FE explicitly sends bottom-left; absent axisOrigin remains top-left for old clients.
    const fresh = fakeResponse();
    await controller.exportJobPdf({ user: currentUser() } as never, '42', { variant: 'active', axisOrigin: 'bottom-left' }, fresh.res as never);
    expect(fresh.state.sent).toBe(pdf);
    expect(renderJobPdf).toHaveBeenCalledTimes(2);
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

  it('listFilmOptions: delegates date-filtered criteria to the service', async () => {
    const films = [
      { filmId: 7, name: 'Белый матовый' },
      { filmId: 8, name: 'Дуб натуральный' },
    ];
    const listFilmOptionsForCut = vi.fn(async () => films);
    const controller = createController({ service: { listFilmOptionsForCut } });
    const request = { user: currentUser(), requestId: 'req-films' } as never;

    const result = await controller.listFilmOptions(request, {
      dateFrom: '2026-07-01',
      dateTo: '2026-07-31',
      orderIds: '10,11',
      sheetMaterialTypeIds: '3',
    });

    expect(result).toEqual(films);
    expect(listFilmOptionsForCut).toHaveBeenCalledWith(expect.objectContaining({
      criteria: {
        dateFrom: '2026-07-01',
        dateTo: '2026-07-31',
        orderIds: [10, 11],
        sheetMaterialTypeIds: [3],
        filmIds: undefined,
        productionStatusIds: undefined,
      },
      requestId: 'req-films',
    }));
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

describe('parseSetRotationAllowedBody', () => {
  it('accepts a boolean + version', () => {
    expect(parseSetRotationAllowedBody({ rotationAllowed: false, version: 2 })).toEqual({ rotationAllowed: false, version: 2 });
  });
  it('rejects a non-boolean rotationAllowed', () => {
    expect(() => parseSetRotationAllowedBody({ rotationAllowed: 'no', version: 0 })).toThrow();
  });
  it('rejects unknown keys (strict)', () => {
    expect(() => parseSetRotationAllowedBody({ rotationAllowed: true, version: 0, extra: 1 })).toThrow();
  });
});

it('PATCH setRotationAllowed delegates parsed args to CutService.setRotationAllowed', async () => {
  const serviceReturn = jobDto();
  const service = {
    setRotationAllowed: vi.fn(async () => serviceReturn),
  };
  const controller = createController({ service });
  const request = { user: currentUser(), requestId: 'req-rotation' } as never;
  const dto = await controller.setRotationAllowed(request, '42', { rotationAllowed: false, version: 3 });
  expect(service.setRotationAllowed).toHaveBeenCalledWith(expect.objectContaining({
    cutJobId: 42, rotationAllowed: false, version: 3, requestId: 'req-rotation',
  }));
  expect(dto).toBe(serviceReturn);
});

describe('parseSetTextureDirectionBody', () => {
  it('accepts a texture direction + version', () => {
    expect(parseSetTextureDirectionBody({ textureDirection: 'vertical', version: 2 })).toEqual({ textureDirection: 'vertical', version: 2 });
  });
  it('rejects an unknown texture direction', () => {
    expect(() => parseSetTextureDirectionBody({ textureDirection: 'diagonal', version: 0 })).toThrow();
  });
  it('rejects unknown keys (strict)', () => {
    expect(() => parseSetTextureDirectionBody({ textureDirection: 'none', version: 0, extra: 1 })).toThrow();
  });
});

it('PATCH setTextureDirection delegates parsed args to CutService.setTextureDirection', async () => {
  const serviceReturn = jobDto();
  const service = {
    setTextureDirection: vi.fn(async () => serviceReturn),
  };
  const controller = createController({ service });
  const request = { user: currentUser(), requestId: 'req-texture' } as never;
  const dto = await controller.setTextureDirection(request, '42', { textureDirection: 'horizontal', version: 3 });
  expect(service.setTextureDirection).toHaveBeenCalledWith(expect.objectContaining({
    cutJobId: 42, textureDirection: 'horizontal', version: 3, requestId: 'req-texture',
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

describe('parseSetNameBody', () => {
  it('trims and accepts a non-empty name + version', () => {
    expect(parseSetNameBody({ name: '  Раскрой 2709  ', version: 4 })).toEqual({ name: 'Раскрой 2709', version: 4 });
  });
  it('rejects an empty name and unknown fields', () => {
    expect(() => parseSetNameBody({ name: '   ', version: 0 })).toThrow();
    expect(() => parseSetNameBody({ name: 'Раскрой', version: 0, extra: true })).toThrow();
  });
});

it('PATCH setName delegates parsed args to CutService.setName', async () => {
  const serviceReturn = jobDto();
  const service = {
    setName: vi.fn(async () => serviceReturn),
  };
  const controller = createController({ service });
  const request = { user: currentUser(), requestId: 'req-name' } as never;
  const dto = await controller.setName(request, '42', { name: 'Раскрой 2709', version: 3 });
  expect(service.setName).toHaveBeenCalledWith(expect.objectContaining({
    cutJobId: 42, name: 'Раскрой 2709', version: 3, requestId: 'req-name',
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
