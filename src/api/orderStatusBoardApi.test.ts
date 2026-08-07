import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { orderStatusBoardApi } from './orderStatusBoardApi';

describe('orderStatusBoardApi', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('serializes initial and per-column cursor queries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          board: 'production',
          generatedAt: '2026-07-19T00:00:00.000Z',
          filterKey: 'filter',
          financialsVisible: false,
          columns: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await orderStatusBoardApi.get({
      board: 'production',
      column: 'unassigned',
      cursor: 'opaque',
      limit: 24,
      search: 'ABC 1',
      onlyMyOrders: true,
      overdueOnly: false,
      includeDone: true,
      plannedFrom: '2026-07-01',
      sortBy: 'orderNumber',
      sortOrder: 'desc',
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/v1/orders/status-board?board=production&column=unassigned&cursor=opaque&limit=24&search=ABC+1&onlyMyOrders=true&overdueOnly=false&includeDone=true&plannedFrom=2026-07-01&sortBy=orderNumber&sortOrder=desc',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
