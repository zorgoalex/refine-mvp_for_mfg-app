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
} from './cut.controller';
import { CutPdfCache } from '../application/cut-pdf-cache';
import type { CutRuntimeConfigService } from './cut-runtime-config.service';

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
    items: [],
    groups: [],
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
  return new CutController(options.service as unknown as CutService, runtimeConfig, pdfCache);
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
    await controller.calculate({ user: currentUser() } as never, '42', { version: 3 });
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

  it('renders a sheet SVG with the svg content type', async () => {
    const controller = createController({ service: { renderSheetSvg: vi.fn(async () => '<svg/>') } });
    const { res, headers, state } = fakeResponse();
    await controller.renderSvg({ user: currentUser() } as never, '42', '100', '0', res as never);
    expect(headers['Content-Type']).toBe('image/svg+xml');
    expect(state.sent).toBe('<svg/>');
  });

  it('group PDF: 202 + Retry-After on a cold cache, then 200 application/pdf once warm', async () => {
    const pdf = Buffer.from('%PDF-1');
    const renderGroupPdf = vi.fn(async () => pdf);
    const pdfCache = new CutPdfCache({ ttlMs: 1000 });
    const controller = createController({ service: { renderGroupPdf }, pdfCache });

    const cold = fakeResponse();
    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', cold.res as never);
    expect(cold.state.status).toBe(202);
    expect(cold.headers['Retry-After']).toBe('2');

    await pdfCache.whenIdle();

    const warm = fakeResponse();
    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', warm.res as never);
    expect(warm.headers['Content-Type']).toBe('application/pdf');
    expect(warm.state.sent).toBe(pdf);
    expect(renderGroupPdf).toHaveBeenCalledTimes(1);
  });

  it('group PDF: surfaces a deterministic render failure as an error (no 202 loop)', async () => {
    const renderGroupPdf = vi.fn(async () => { throw new ApiError(404, 'CUT_GROUP_SHEET_NOT_FOUND', 'no sheets'); });
    const pdfCache = new CutPdfCache({ ttlMs: 1000, failureTtlMs: 5000 });
    const controller = createController({ service: { renderGroupPdf }, pdfCache });

    // First call kicks the render and returns 202.
    const cold = fakeResponse();
    await controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', cold.res as never);
    expect(cold.state.status).toBe(202);
    await pdfCache.whenIdle();

    // Retry surfaces the ApiError instead of looping 202 forever.
    const warm = fakeResponse();
    await expect(
      controller.exportGroupPdf({ user: currentUser() } as never, '42', '100', warm.res as never),
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
    await controller.exportJobPdf({ user: currentUser() } as never, '42', cold.res as never);
    expect(cold.state.status).toBe(202);

    await pdfCache.whenIdle();

    const warm = fakeResponse();
    await controller.exportJobPdf({ user: currentUser() } as never, '42', warm.res as never);
    expect(warm.headers['Content-Type']).toBe('application/pdf');
    expect(warm.state.sent).toBe(pdf);
    expect(renderJobPdf).toHaveBeenCalledTimes(1);
  });

  it('parses ids, bodies, and criteria', () => {
    expect(parseCutJobId('42')).toBe(42);
    expect(() => parseCutJobId('0')).toThrow(ApiError);
    expect(parseCreateCutJobRequest({ name: 'Тест', detailIds: [1, 2] }).detailIds).toEqual([1, 2]);
    expect(() => parseCreateCutJobRequest({ name: '' })).toThrow(ApiError);
    expect(parseAddItemsRequest({ detailIds: [3], version: 2 }).version).toBe(2);
    expect(parseEligibleCriteria({ orderIds: '9,10', filmIds: '5' })).toMatchObject({ orderIds: [9, 10], filmIds: [5] });
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
