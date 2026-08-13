/**
 * Task 8: Frontend API client tests — manual-layout endpoints and render-variant URL helpers.
 * Node-only (no jsdom). Stubs global `fetch` like sibling cutApi.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cutApi } from './cutApi';
import type { SaveManualLayoutRequest } from './types/cutApi.types';

describe('cutApi manual-layout', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // ── saveManualLayout ──────────────────────────────────────────────────────

  it('PATCHes manual-layout moves to the group route', async () => {
    const body: SaveManualLayoutRequest = {
      commandId: '11111111-1111-4111-8111-111111111111',
      jobVersion: 2,
      active: true,
      placements: [
        { itemId: 'det-1', instance: 1, sheetIndex: 0, xMm: 10.5, yMm: 20, rotated: false },
      ],
      sheetTransforms: [
        { sheetIndex: 0, rotationDeg: 90, mirrorHorizontal: true, mirrorVertical: false },
      ],
    };
    const fetchMock = mockFetch({ cutJobId: 5, version: 3 });
    await cutApi.saveManualLayout(5, 9, body);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/cut-jobs/5/groups/9/manual-layout');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('PATCH');
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual(body);
  });

  it('saveManualLayout rejects invalid cutJobId', async () => {
    const body: SaveManualLayoutRequest = { commandId: '11111111-1111-4111-8111-111111111111', jobVersion: 1, active: false, placements: [], sheetTransforms: [] };
    await expect(cutApi.saveManualLayout(0, 9, body)).rejects.toThrow('Invalid cutJobId');
    await expect(cutApi.saveManualLayout(5, -1, body)).rejects.toThrow('Invalid cutJobId');
  });

  // ── fetchGroupPdf with renderToken ────────────────────────────────────────

  it('fetchGroupPdf appends variant=active and renderVersion when token given', async () => {
    const fetchMock = pdfFetch();
    await cutApi.fetchGroupPdf(5, 9, false, 'tok123');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('variant=active');
    expect(url).toContain('renderVersion=tok123');
    expect(url).toContain('/api/v1/cut-jobs/5/groups/9/export.pdf');
  });

  it('fetchGroupPdf without renderToken does NOT add variant or renderVersion', async () => {
    const fetchMock = pdfFetch();
    await cutApi.fetchGroupPdf(42, 100);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/cut-jobs/42/groups/100/export.pdf');
    expect(url).toContain('origin=tl');
    expect(url).not.toContain('variant');
    expect(url).not.toContain('renderVersion');
  });

  it('fetchGroupPdf with landscape + renderToken includes orientation, variant and renderVersion', async () => {
    const fetchMock = pdfFetch();
    await cutApi.fetchGroupPdf(5, 9, true, 'tokL');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('orientation=landscape');
    expect(url).toContain('variant=active');
    expect(url).toContain('renderVersion=tokL');
  });

  // ── fetchJobPdf with renderToken ──────────────────────────────────────────

  it('fetchJobPdf appends variant=active and renderVersion when token given', async () => {
    const fetchMock = pdfFetch();
    await cutApi.fetchJobPdf(5, false, 'tok456');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('variant=active');
    expect(url).toContain('renderVersion=tok456');
    expect(url).toContain('/api/v1/cut-jobs/5/export.pdf');
  });

  it('fetchJobPdf without renderToken keeps plain URL', async () => {
    const fetchMock = pdfFetch();
    await cutApi.fetchJobPdf(42);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/cut-jobs/42/export.pdf?origin=tl&axisOrigin=top-left');
  });

  it('fetchJobPdf with landscape + renderToken composes params correctly', async () => {
    const fetchMock = pdfFetch();
    await cutApi.fetchJobPdf(5, true, 'tokJ');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('orientation=landscape');
    expect(url).toContain('variant=active');
    expect(url).toContain('renderVersion=tokJ');
  });

  // ── fetchSheetPng with variant + renderToken ──────────────────────────────

  it('fetchSheetPng appends variant and renderVersion when given', async () => {
    const fetchMock = imgFetch('image/png', 'PNG');
    await cutApi.fetchSheetPng(5, 9, 0, 'screen', false, 'manual', 'tokPNG');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('variant=manual');
    expect(url).toContain('renderVersion=tokPNG');
    expect(url).toContain('preset=screen');
    // On-screen preview defaults to no baked labels
    expect(url).toContain('labels=off');
  });

  it('fetchSheetPng defaults to labels=off (on-screen preview, no baked labels)', async () => {
    const fetchMock = imgFetch('image/png', 'PNG');
    await cutApi.fetchSheetPng(42, 100, 0, 'thumb');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('labels=off');
    expect(url).toContain('preset=thumb');
    // No other params beyond preset+labels when called with defaults
    expect(url).not.toContain('variant');
    expect(url).not.toContain('renderVersion');
  });

  it('fetchSheetPng with active variant appends variant=active', async () => {
    const fetchMock = imgFetch('image/png', 'PNG');
    await cutApi.fetchSheetPng(5, 9, 2, 'screen', false, 'active');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('variant=active');
    expect(url).toContain('labels=off');
    expect(url).not.toContain('renderVersion');
  });

  // ── fetchSheetSvg with variant + renderToken ──────────────────────────────

  it('fetchSheetSvg appends variant and renderVersion when given', async () => {
    const fetchMock = imgFetch('image/svg+xml', '<svg/>');
    await cutApi.fetchSheetSvg(5, 9, 0, false, 'auto', 'tokSVG');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('variant=auto');
    expect(url).toContain('renderVersion=tokSVG');
  });

  it('fetchSheetSvg without new params keeps existing call style', async () => {
    const fetchMock = imgFetch('image/svg+xml', '<svg/>');
    await cutApi.fetchSheetSvg(42, 100, 0);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/cut-jobs/42/groups/100/sheets/0.svg?origin=tl&axisOrigin=top-left');
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────

function mockFetch(...bodies: unknown[]) {
  const fetchMock = vi.fn();
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function pdfFetch() {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response('%PDF-1', { status: 200, headers: { 'Content-Type': 'application/pdf' } }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function imgFetch(contentType: string, body: string) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(body, { status: 200, headers: { 'Content-Type': contentType } }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
