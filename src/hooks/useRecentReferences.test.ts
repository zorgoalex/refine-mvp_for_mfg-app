import { describe, expect, it } from 'vitest';
import {
  FollowUpRefreshCoordinator,
  normalizeRecentReferences,
  shouldApplyLoadedRecentResponse,
  shouldApplyRecentResponse,
  shouldRefreshRecentReferences,
  sortOptionsByRecency,
} from './useRecentReferences';

describe('recent reference ordering', () => {
  const options = [
    { value: 1, label: 'Ясень', sortOrder: 20 },
    { value: 2, label: 'Берёза', sortOrder: 10 },
    { value: 3, label: 'Акация', sortOrder: 10 },
    { value: 4, label: 'Дуб', sortOrder: 10 },
  ];

  it('puts known recents first and keeps deterministic catalog fallback', () => {
    expect(sortOptionsByRecency(options, [4, 1, 999]).map((option) => option.value))
      .toEqual([4, 1, 3, 2]);
  });

  it('normalizes malformed ids, deduplicates and caps each resource', () => {
    const normalized = normalizeRecentReferences({
      sheet_material_types: [3, 3, 0, '4', ...Array.from({ length: 30 }, (_, index) => index + 10)],
      __proto_pollution_attempt: [1],
    });
    expect(normalized.sheet_material_types).toHaveLength(20);
    expect(normalized.sheet_material_types?.slice(0, 2)).toEqual([3, 10]);
    expect(normalized).not.toHaveProperty('__proto_pollution_attempt');
  });

  it('accepts cross-tab invalidation only for the active user', () => {
    expect(shouldRefreshRecentReferences({ type: 'invalidate', userId: '7' }, '7')).toBe(true);
    expect(shouldRefreshRecentReferences({ type: 'invalidate', userId: '8' }, '7')).toBe(false);
    expect(shouldRefreshRecentReferences({ type: 'other', userId: '7' }, '7')).toBe(false);
    expect(shouldRefreshRecentReferences(null, '7')).toBe(false);
    expect(shouldRefreshRecentReferences({ type: 'invalidate', userId: '7' }, null)).toBe(false);
  });

  it('rejects queued or stale responses after an account switch or newer promotion', () => {
    expect(shouldApplyRecentResponse('7', '8', 2, 2)).toBe(false);
    expect(shouldApplyRecentResponse('7', '7', 1, 2)).toBe(false);
    expect(shouldApplyRecentResponse('7', '7', 2, 2)).toBe(true);
  });

  it('does not let a GET started around a pending POST roll back optimistic recency', () => {
    expect(shouldApplyLoadedRecentResponse('7', '7', 2, 2, true)).toBe(false);
    expect(shouldApplyLoadedRecentResponse('7', '7', 1, 2, false)).toBe(false);
    expect(shouldApplyLoadedRecentResponse('7', '7', 2, 2, false)).toBe(true);
  });

  it('runs one follow-up GET when invalidation arrives during an older GET', async () => {
    const coordinator = new FollowUpRefreshCoordinator();
    const resolvers: Array<() => void> = [];
    const load = () => new Promise<void>((resolve) => {
      resolvers.push(resolve);
    });

    const first = coordinator.run('7', load);
    coordinator.run('7', load, true);
    coordinator.run('7', load, true);
    expect(resolvers).toHaveLength(1);

    resolvers[0]();
    await first;
    await Promise.resolve();
    expect(resolvers).toHaveLength(2);

    resolvers[1]();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolvers).toHaveLength(2);
  });
});
