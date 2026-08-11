import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { orderStatusBoardApi } from './orderStatusBoardApi';

describe('orderStatusBoardApi MDF manual moves', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('lists shared MDF manual moves from the backend board endpoint', async () => {
    const response = {
      generatedAt: '2026-08-11T00:00:00.000Z',
      moves: [],
    };
    const fetchMock = mockFetch(response);

    await expect(orderStatusBoardApi.listMdfManualMoves()).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/orders/status-board/mdf-manual-moves',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('saves and clears a card move with encoded card identity', async () => {
    const upsertResponse = {
      generatedAt: '2026-08-11T00:00:00.000Z',
      changed: true,
      move: {
        cardKind: 'bath',
        cardId: 'cut-result:42',
        targetColumn: 'baths_laminated',
        version: 2,
        createdAt: '2026-08-11T00:00:00.000Z',
        createdByUserId: 7,
        updatedAt: '2026-08-11T00:00:01.000Z',
        updatedByUserId: 7,
      },
      auditId: 'audit-1',
    };
    const deleteResponse = {
      generatedAt: '2026-08-11T00:00:02.000Z',
      cardKind: 'bath',
      cardId: 'cut-result:42',
      deleted: true,
      auditId: 'audit-2',
    };
    const fetchMock = mockFetch(upsertResponse, deleteResponse);

    await expect(
      orderStatusBoardApi.upsertMdfManualMove('bath', 'cut-result:42', 'baths_laminated'),
    ).resolves.toEqual(upsertResponse);
    await expect(
      orderStatusBoardApi.deleteMdfManualMove('bath', 'cut-result:42'),
    ).resolves.toEqual(deleteResponse);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/orders/status-board/mdf-manual-moves/bath/cut-result%3A42');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('PUT');
    expect(fetchMock.mock.calls[0][1]?.body).toBe(JSON.stringify({ targetColumn: 'baths_laminated' }));
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/orders/status-board/mdf-manual-moves/bath/cut-result%3A42');
    expect(fetchMock.mock.calls[1][1]?.method).toBe('DELETE');
  });

  it('normalizes safe card ids before building the request path', async () => {
    const fetchMock = mockFetch({
      generatedAt: '2026-08-11T00:00:00.000Z',
      changed: false,
      move: {
        cardKind: 'packet',
        cardId: 'packet-1',
        targetColumn: 'completed',
        version: 1,
        createdAt: '2026-08-11T00:00:00.000Z',
        createdByUserId: null,
        updatedAt: '2026-08-11T00:00:00.000Z',
        updatedByUserId: null,
      },
    });

    await orderStatusBoardApi.upsertMdfManualMove('packet', ' packet-1 ', 'completed');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/orders/status-board/mdf-manual-moves/packet/packet-1');
  });

  it('rejects unsafe card ids before fetch', () => {
    const fetchMock = mockFetch({});
    expect(() => orderStatusBoardApi.upsertMdfManualMove('packet', '../bad', 'completed')).toThrow('Invalid cardId');
    expect(fetchMock).not.toHaveBeenCalled();
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
