import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getEngineMode: vi.fn(), get: vi.fn(), generation: 1 }));
vi.mock('./mdfCorrectionApi', () => ({ mdfCorrectionApi: { getEngineMode: api.getEngineMode } }));
vi.mock('./mdfPublishedApi', () => ({ mdfPublishedApi: { get: api.get } }));
vi.mock('./authSession', () => ({ authSession: { getSessionGeneration: () => api.generation } }));

import { prefetchMdfBoardOpen, takePrefetchedMdfEngineMode, takePrefetchedMdfSnapshot } from './mdfBoardOpenPrefetch';

const query = { dateTo: '2026-10-27', displayFrom: '2026-09-27' };

describe('MDF board open prefetch', () => {
  beforeEach(() => {
    api.generation = 1;
    api.getEngineMode.mockReset().mockResolvedValue({ mode: 'active' });
    api.get.mockReset().mockResolvedValue({ sessionGeneration: 1, snapshot: 'S' });
    takePrefetchedMdfEngineMode();
    takePrefetchedMdfSnapshot(query);
    api.getEngineMode.mockClear();
    api.get.mockClear();
  });

  it('hands each prefetched read to the first cycle once', async () => {
    prefetchMdfBoardOpen(query);
    prefetchMdfBoardOpen(query);
    expect(api.getEngineMode).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledTimes(1);
    await expect(takePrefetchedMdfEngineMode()).resolves.toEqual({ mode: 'active' });
    await expect(takePrefetchedMdfSnapshot(query)).resolves.toEqual({ sessionGeneration: 1, snapshot: 'S' });
    expect(takePrefetchedMdfEngineMode()).toBeNull();
    expect(takePrefetchedMdfSnapshot(query)).toBeNull();
  });

  it('is not used for another query or another session', () => {
    prefetchMdfBoardOpen(query);
    expect(takePrefetchedMdfSnapshot({ ...query, displayFrom: '2026-10-21' })).toBeNull();
    api.generation = 2;
    expect(takePrefetchedMdfSnapshot(query)).toBeNull();
    expect(takePrefetchedMdfEngineMode()).toBeNull();
  });

  it('reads again when the prefetch failed', async () => {
    api.get.mockRejectedValueOnce(new Error('offline'));
    api.getEngineMode.mockRejectedValueOnce(new Error('offline'));
    prefetchMdfBoardOpen(query);
    await expect(takePrefetchedMdfSnapshot(query)).resolves.toEqual({ sessionGeneration: 1, snapshot: 'S' });
    await expect(takePrefetchedMdfEngineMode()).resolves.toEqual({ mode: 'active' });
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.getEngineMode).toHaveBeenCalledTimes(2);
  });
});
