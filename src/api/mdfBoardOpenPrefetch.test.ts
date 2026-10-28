import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getEngineMode: vi.fn(), get: vi.fn(), generation: 1 }));
vi.mock('./mdfCorrectionApi', () => ({ mdfCorrectionApi: { getEngineMode: api.getEngineMode } }));
vi.mock('./mdfPublishedApi', () => ({ mdfPublishedApi: { get: api.get } }));
vi.mock('./authSession', () => ({ authSession: { getSessionGeneration: () => api.generation } }));

import {
  mdfBoardOpenPrefetchFresh,
  prefetchMdfBoardOpen,
  takePrefetchedMdfEngineMode,
  takePrefetchedMdfSnapshot,
} from './mdfBoardOpenPrefetch';

const query = { dateTo: '2026-10-27', displayFrom: '2026-09-27' };

describe('MDF board open prefetch', () => {
  beforeEach(() => {
    api.generation = 1;
    api.getEngineMode.mockReset().mockResolvedValue({ mode: 'active' });
    api.get.mockReset().mockResolvedValue({ sessionGeneration: 1, snapshot: 'S' });
    takePrefetchedMdfSnapshot(query);
    takePrefetchedMdfEngineMode();
    takePrefetchedMdfEngineMode();
    api.getEngineMode.mockClear();
    api.get.mockClear();
  });

  it('hands each prefetched read to the first cycle once', async () => {
    prefetchMdfBoardOpen(query);
    prefetchMdfBoardOpen(query);
    expect(api.getEngineMode).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledTimes(1);
    // the board's cycle takes the snapshot first, then the mode
    await expect(takePrefetchedMdfSnapshot(query)).resolves.toEqual({ sessionGeneration: 1, snapshot: 'S' });
    await expect(takePrefetchedMdfEngineMode()).resolves.toEqual({ mode: 'active' });
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

  it('keeps a warm-up for minutes (sign-in → the board opened later) and says when it is no longer fresh', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-28T08:00:00Z'));
      prefetchMdfBoardOpen(query);
      expect(mdfBoardOpenPrefetchFresh()).toBe(true);
      vi.setSystemTime(new Date('2026-10-28T08:03:00Z')); // 3 min later
      expect(mdfBoardOpenPrefetchFresh()).toBe(false);
      expect(takePrefetchedMdfEngineMode()).not.toBeNull();
      expect(takePrefetchedMdfSnapshot(query)).not.toBeNull();
      prefetchMdfBoardOpen(query);
      vi.setSystemTime(new Date('2026-10-28T08:09:00Z')); // past 5 min: not used
      expect(takePrefetchedMdfEngineMode()).toBeNull();
      expect(takePrefetchedMdfSnapshot(query)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a first cycle on a default period use the mode without consuming it; the matching cycle takes both', async () => {
    prefetchMdfBoardOpen(query);
    // first cycle: default period, its snapshot is not the prefetched one
    expect(takePrefetchedMdfSnapshot({ ...query, displayFrom: '2026-09-28' })).toBeNull();
    await expect(takePrefetchedMdfEngineMode()).resolves.toEqual({ mode: 'active' });
    // second cycle: the user's period restored — snapshot and mode are both prefetched
    await expect(takePrefetchedMdfSnapshot(query)).resolves.toEqual({ sessionGeneration: 1, snapshot: 'S' });
    await expect(takePrefetchedMdfEngineMode()).resolves.toEqual({ mode: 'active' });
    expect(takePrefetchedMdfEngineMode()).toBeNull();
    expect(api.getEngineMode).toHaveBeenCalledTimes(1);
  });
});
