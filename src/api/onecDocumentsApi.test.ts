import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { onecDocumentsApi } from './onecDocumentsApi';

describe('onecDocumentsApi', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('lists documents with the whitelisted query shape', async () => {
    const fetchMock = mockFetch({
      data: [],
      pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 },
      capabilities: { procurement: true, byMaterial: true, cardDetails: true, onecDocuments: true },
      amountsVisible: true,
    });

    await onecDocumentsApi.list({
      tab: 'receipts',
      page: 2,
      pageSize: 20,
      search: 'ООО Мебель',
      unlinkedOnly: true,
      postedOnly: undefined,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/procurement/onec-documents?tab=receipts&page=2&pageSize=20&search=%D0%9E%D0%9E%D0%9E+%D0%9C%D0%B5%D0%B1%D0%B5%D0%BB%D1%8C&unlinkedOnly=true',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('gets a document card by id', async () => {
    const fetchMock = mockFetch({
      data: { documentId: 42 },
      capabilities: { procurement: true, byMaterial: true, cardDetails: true, onecDocuments: true },
      amountsVisible: true,
    });

    await onecDocumentsApi.getCard(42);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/procurement/onec-documents/42',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('rejects non-positive ids before fetch', () => {
    const fetchMock = mockFetch({});

    expect(() => onecDocumentsApi.getCard(0)).toThrow('Invalid documentId');
    expect(() => onecDocumentsApi.addAllocation(1, 0, {
      orderId: 1,
      resourceKey: 'sheet_material:1',
      quantity: 1,
      expectedVersion: 0,
      expectedDemandFingerprint: 'a'.repeat(64),
    })).toThrow('Invalid lineId');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('adds an allocation by POSTing to the document line', async () => {
    const fetchMock = mockFetch({ changed: true, allocationId: 5, orderId: 9001, resourceKey: 'sheet_material:1', line: {} });

    await onecDocumentsApi.addAllocation(42, 7, {
      orderId: 9001,
      resourceKey: 'sheet_material:1',
      quantity: 3.2,
      expectedVersion: 0,
      expectedDemandFingerprint: 'a'.repeat(64),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/procurement/onec-documents/42/lines/7/allocations',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('removes an allocation by DELETEing with a JSON body carrying expectedVersion', async () => {
    const fetchMock = mockFetch({ changed: true, allocationId: 5, orderId: 9001, resourceKey: 'sheet_material:1', line: {} });

    await onecDocumentsApi.removeAllocation(42, 7, 5, { expectedVersion: 1 });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/procurement/onec-documents/42/lines/7/allocations/5',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ expectedVersion: 1 }),
      }),
    );
  });
});

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
