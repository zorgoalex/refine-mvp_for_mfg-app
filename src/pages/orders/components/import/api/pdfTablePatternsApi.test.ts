import { afterEach, describe, expect, it, vi } from 'vitest';
import { pdfTablePatternsApi } from './pdfTablePatternsApi';

const signature = {
  fingerprintVersion: 1 as const,
  parserMajor: 1 as const,
  headerBandCount: 1,
  columns: [
    { header: 'Наименование', relativeStart: 0, relativeEnd: 0.5 },
    { header: 'Количество', relativeStart: 0.5, relativeEnd: 0.7 },
    { header: 'Размер', relativeStart: 0.7, relativeEnd: 1 },
  ],
};
const mapping = {
  schemaVersion: 1 as const,
  columns: [
    { columnIndex: 0, target: 'name' as const },
    { columnIndex: 1, target: 'quantity' as const },
    { columnIndex: 2, target: 'compound_size' as const },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('pdfTablePatternsApi', () => {
  it('matches structural signatures without document data', async () => {
    vi.stubEnv('VITE_API_URL', '');
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ results: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    await pdfTablePatternsApi.match([signature]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/bazis/pdf-table-patterns/match');
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(request.method).toBe('POST');
    expect(String(request.body)).not.toMatch(/fileName|pdf|rawRows|documentHash/);
  });

  it('learn uses opaque idempotency UUID', async () => {
    vi.stubEnv('VITE_API_URL', '');
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ id: 1 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    await pdfTablePatternsApi.learn(signature, mapping);
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = request.headers as Headers;
    expect(headers.get('Idempotency-Key')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
