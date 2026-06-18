import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEligibleQuery, cutApi, validateCutJobId } from './cutApi';
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

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/cut-jobs/42/groups/100/sheets/0.svg');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/cut-jobs/42/groups/100/sheets/0.png?preset=thumb');
  });

  it('returns pending on a cold-cache 202 PDF and the blob once warm', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'pending' }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('%PDF-1', { status: 200, headers: { 'Content-Type': 'application/pdf' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(cutApi.fetchJobPdf(42)).resolves.toEqual({ pending: true });
    await expect(cutApi.fetchGroupPdf(42, 100)).resolves.toMatchObject({ pending: false });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/cut-jobs/42/export.pdf');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/cut-jobs/42/groups/100/export.pdf');
  });

  it('validates cut job ids before fetch', async () => {
    const fetchMock = mockFetch(jobDto());
    expect(() => validateCutJobId(0)).toThrow('Invalid cutJobId');
    await expect(cutApi.get(1.5)).rejects.toThrow('Invalid cutJobId');
    expect(fetchMock).not.toHaveBeenCalled();
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
    items: [],
    groups: [],
    ...overrides,
  };
}
