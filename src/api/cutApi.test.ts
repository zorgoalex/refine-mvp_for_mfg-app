import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEligibleQuery, cutApi, validateCutJobId } from './cutApi';
import { cutConfigApi } from './cutConfigApi';
import type { CutJobDto } from './types/cutApi.types';

describe('cutApi', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('builds a CSV eligible-details query string from criteria', () => {
    expect(buildEligibleQuery({ orderIds: [9, 10], filmIds: [5] })).toBe('orderIds=9%2C10&filmIds=5');
    expect(buildEligibleQuery({})).toBe('');
  });

  it('drives the cut-jobs backend command/read endpoints', async () => {
    const job = jobDto();
    const fetchMock = mockFetch(
      job, // create
      { ...job, items: [{ cutJobItemId: 1, orderDetailId: 1, orderId: 9, qty: 1, cutGroupId: null }] }, // addItems
      { ...job, status: 'ready' }, // calculate
      { ...job, status: 'archived' }, // archive
      { details: [], noSheetSpecCount: 2 }, // eligible
    );

    await expect(cutApi.create({ name: 'Тест', detailIds: [1] })).resolves.toEqual(job);
    await cutApi.addItems(42, { detailIds: [1], version: 0 });
    await cutApi.calculate(42, 1);
    await cutApi.archive(42, 2);
    await expect(cutApi.listEligibleDetails(42, { orderIds: [9] })).resolves.toMatchObject({ noSheetSpecCount: 2 });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/cut-jobs');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/cut-jobs/42/items');
    expect(fetchMock.mock.calls[2][0]).toBe('/api/v1/cut-jobs/42/calculate');
    expect(fetchMock.mock.calls[3][0]).toBe('/api/v1/cut-jobs/42');
    expect(fetchMock.mock.calls[3][1]?.method).toBe('DELETE');
    expect(fetchMock.mock.calls[4][0]).toBe('/api/v1/cut-jobs/42/eligible-details?orderIds=9');
  });

  it('fetches a per-sheet SVG and the preset PNG from the render endpoints', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('<svg/>', { status: 200, headers: { 'Content-Type': 'image/svg+xml' } }))
      .mockResolvedValueOnce(new Response('PNG', { status: 200, headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchMock);

    await cutApi.fetchSheetSvg(42, 100, 0);
    await cutApi.fetchSheetPng(42, 100, 0, 'thumb');

    const svgUrl = fetchMock.mock.calls[0][0] as string;
    expect(svgUrl).toContain('/api/v1/cut-jobs/42/groups/100/sheets/0.svg');
    // origin defaults to top-left (transpose); emitted explicitly so the RAW half
    // is never silently dead and browser cache keys differ.
    expect(svgUrl).toContain('origin=tl');
    // PNG always includes labels=off (no baked labels; HTML overlay is the sole label source)
    const pngUrl = fetchMock.mock.calls[1][0] as string;
    expect(pngUrl).toContain('/api/v1/cut-jobs/42/groups/100/sheets/0.png');
    expect(pngUrl).toContain('preset=thumb');
    expect(pngUrl).toContain('labels=off');
    expect(pngUrl).toContain('origin=tl');
  });

  it('emits origin=raw on every render URL when originTopLeft is false (RAW half not dead)', async () => {
    const fetchMock = vi.fn()
      .mockImplementation(() => new Response('PNG', { status: 200, headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchMock);

    await cutApi.fetchSheetPng(42, 100, 0, 'screen', false, undefined, undefined, false);
    await cutApi.fetchSheetSvg(42, 100, 0, false, undefined, undefined, false);
    await cutApi.fetchGroupPdf(42, 100, false, undefined, false);
    await cutApi.fetchJobPdf(42, false, undefined, false);

    for (const call of fetchMock.mock.calls) {
      expect(call[0] as string).toContain('origin=raw');
      expect(call[0] as string).not.toContain('origin=tl');
    }
  });

  it('emits origin=tl on every render URL by default (originTopLeft omitted)', async () => {
    const fetchMock = vi.fn()
      .mockImplementation(() => new Response('PNG', { status: 200, headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchMock);

    await cutApi.fetchSheetPng(42, 100, 0);
    await cutApi.fetchSheetSvg(42, 100, 0);
    await cutApi.fetchGroupPdf(42, 100);
    await cutApi.fetchJobPdf(42);

    for (const call of fetchMock.mock.calls) {
      expect(call[0] as string).toContain('origin=tl');
    }
  });

  it('returns pending on a cold-cache 202 PDF and the blob once warm', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'pending' }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('%PDF-1', { status: 200, headers: { 'Content-Type': 'application/pdf' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(cutApi.fetchJobPdf(42)).resolves.toEqual({ pending: true });
    await expect(cutApi.fetchGroupPdf(42, 100)).resolves.toMatchObject({ pending: false });
    expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/cut-jobs/42/export.pdf');
    expect(fetchMock.mock.calls[0][0]).toContain('origin=tl');
    expect(fetchMock.mock.calls[1][0]).toContain('/api/v1/cut-jobs/42/groups/100/export.pdf');
    expect(fetchMock.mock.calls[1][0]).toContain('origin=tl');
  });

  it('passes the selected PDF template to group PDF export', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('%PDF-1', { status: 200, headers: { 'Content-Type': 'application/pdf' } }));
    vi.stubGlobal('fetch', fetchMock);

    await cutApi.fetchGroupPdf(42, 100, false, undefined, true, 'bath_profiles');

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/cut-jobs/42/groups/100/export.pdf');
    expect(url).toContain('template=bath_profiles');
  });

  it('passes the selected PDF template to whole-job PDF export', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('%PDF-1', { status: 200, headers: { 'Content-Type': 'application/pdf' } }));
    vi.stubGlobal('fetch', fetchMock);

    await cutApi.fetchJobPdf(42, false, undefined, true, 'bath_profiles');

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/cut-jobs/42/export.pdf');
    expect(url).toContain('template=bath_profiles');
  });

  it('validates cut job ids before fetch', async () => {
    const fetchMock = mockFetch(jobDto());
    expect(() => validateCutJobId(0)).toThrow('Invalid cutJobId');
    await expect(cutApi.get(1.5)).rejects.toThrow('Invalid cutJobId');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('setProfile PATCHes the profile route with { paramProfileId, version }', async () => {
    const job = jobDto(); // file's CutJobDto fixture (now incl. paramProfileId + totals)
    const fetchMock = mockFetch(job, job);
    await cutApi.setProfile(42, 5, 2);
    await cutApi.setProfile(42, null, 3);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/cut-jobs/42/profile');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('PATCH');
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({ paramProfileId: 5, version: 2 });
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual({ paramProfileId: null, version: 3 });
  });

  it('setSheetMaterial PATCHes the sheet-material route with body', async () => {
    const job = jobDto({ sheetMaterialTypeId: 9 });
    const fetchMock = mockFetch(job);
    await cutApi.setSheetMaterial(3, 9, 5);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/cut-jobs/3/sheet-material');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('PATCH');
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({ sheetMaterialTypeId: 9, version: 5 });
  });

  it('setSheetMaterial sends null to clear the override', async () => {
    const job = jobDto({ sheetMaterialTypeId: null });
    const fetchMock = mockFetch(job);
    await cutApi.setSheetMaterial(3, null, 6);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/cut-jobs/3/sheet-material');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('PATCH');
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({ sheetMaterialTypeId: null, version: 6 });
  });

  it('setCombineFilms PATCHes the combine-films route with body', async () => {
    const job = jobDto({ combineFilms: true });
    const fetchMock = mockFetch(job);
    await cutApi.setCombineFilms(3, true, 5);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/cut-jobs/3/combine-films');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('PATCH');
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({ combineFilms: true, version: 5 });
  });

  it('setSplitByMaterial PATCHes the split-by-material route with body', async () => {
    const job = jobDto({ splitByMaterial: false });
    const fetchMock = mockFetch(job);
    await cutApi.setSplitByMaterial(3, false, 7);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/cut-jobs/3/split-by-material');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('PATCH');
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({ splitByMaterial: false, version: 7 });
  });

  it('updates PDF template layouts through cut-config API', async () => {
    const fetchMock = mockFetch({ cutPdfTemplateId: 2, code: 'bath_profiles', name: 'Bath', layout: { elements: [] }, isActive: true, version: 3 });

    await cutConfigApi.updatePdfTemplate(2, { name: 'Bath', layout: { elements: [] }, isActive: true }, 2);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/cut-config/pdf-templates/2');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('PUT');
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toMatchObject({ name: 'Bath', layout: { elements: [] }, version: 2 });
  });

  it('creates PDF template layouts through cut-config API', async () => {
    const fetchMock = mockFetch({ cutPdfTemplateId: 3, code: 'bath_copy', name: 'Bath copy', layout: { elements: [] }, isActive: true, version: 0 });

    await cutConfigApi.createPdfTemplate({ code: 'bath_copy', name: 'Bath copy', layout: { elements: [] }, isActive: true });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/cut-config/pdf-templates');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toMatchObject({ code: 'bath_copy', name: 'Bath copy', layout: { elements: [] } });
  });
});

function mockFetch(...bodies: unknown[]) {
  const fetchMock = vi.fn();
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function jobDto(overrides: Partial<CutJobDto> = {}): CutJobDto {
  return {
    cutJobId: 42,
    name: 'Тест',
    status: 'draft',
    source: 'manual',
    version: 0,
    pdfPrewarmState: 'pending',
    paramProfileId: null,
    sheetMaterialTypeId: null,
    combineFilms: false,
    splitByMaterial: true,
    materialNames: [],
    failureCode: null,
    failureReason: null,
    totals: { positions: 0, details: 0, area: 0, sheets: 0, materialsCount: 0, filmsCount: 0 },
    items: [],
    groups: [],
    ...overrides,
  } satisfies CutJobDto;
}
