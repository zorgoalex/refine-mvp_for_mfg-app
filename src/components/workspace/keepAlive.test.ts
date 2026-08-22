import { describe, expect, it } from 'vitest';
import {
  commitKeepAliveEvictions,
  countMountedHeavyOrderViews,
  isHeavyOrderViewKey,
  isKeepAliveEligible,
  isLightweightOrdersListKey,
  nextKeepAliveCache,
  planKeepAliveCache,
} from './keepAlive';

describe('keep-alive policy', () => {
  it('keeps /orders list always; calendar never', () => {
    expect(isKeepAliveEligible('/orders', { dirty: false })).toBe(true);
    expect(isKeepAliveEligible('/calendar', { dirty: false })).toBe(false);
    expect(isKeepAliveEligible('/calendar', { dirty: true })).toBe(false); // calendar excluded even if dirty
  });
  it('keeps /bazis and project cards mounted so their UI state survives navigation', () => {
    expect(isKeepAliveEligible('/bazis', { dirty: false })).toBe(true);
    expect(isKeepAliveEligible('/bazis/projects/42', { dirty: false })).toBe(true);

    const cache = new Set(['/bazis/projects/42']);
    const next = nextKeepAliveCache(cache, {
      activeKey: '/orders',
      tabs: [
        { key: '/bazis/projects/42', dirty: false },
        { key: '/orders', dirty: false },
      ],
    });
    expect(next.has('/bazis/projects/42')).toBe(true);
  });

  it('keeps /cut always so the open job survives navigating to an order and back', () => {
    expect(isKeepAliveEligible('/cut', { dirty: false })).toBe(true);
    const cache = new Set(['/cut']);
    const next = nextKeepAliveCache(cache, {
      activeKey: '/orders/show/9',
      tabs: [{ key: '/cut', dirty: false }, { key: '/orders/show/9', dirty: false }],
    });
    expect(next.has('/cut')).toBe(true); // retained while inactive (order tab active)
  });
  it('keeps the MDF board mounted so returning to its tab does not remount into a full spinner', () => {
    expect(isKeepAliveEligible('/mdf-work-board', { dirty: false })).toBe(true);
    const cache = new Set(['/mdf-work-board']);
    const next = nextKeepAliveCache(cache, {
      activeKey: '/orders',
      tabs: [
        { key: '/mdf-work-board', dirty: false },
        { key: '/orders', dirty: false },
      ],
    });
    expect(next.has('/mdf-work-board')).toBe(true);
  });
  it('keeps configuration mounted across the first clean-to-dirty edit', () => {
    expect(isKeepAliveEligible('/configuration', { dirty: false })).toBe(true);
    expect(isKeepAliveEligible('/configuration', { dirty: true })).toBe(true);
  });
  it('keeps order forms mounted across the first clean-to-dirty transition', () => {
    expect(isKeepAliveEligible('/orders/edit/42', { dirty: false })).toBe(true);
    expect(isKeepAliveEligible('/orders/edit/42', { dirty: true })).toBe(true);
    expect(isKeepAliveEligible('/orders/create', { dirty: false })).toBe(true);
  });
  it('keeps a dirty non-orders tab while dirty', () => {
    expect(isKeepAliveEligible('/clients/edit/3', { dirty: true })).toBe(true);
    expect(isKeepAliveEligible('/clients/edit/3', { dirty: false })).toBe(false);
  });
  it('evicts a clean+inactive dirty-only entry; retains /orders', () => {
    const cache = new Set(['/orders', '/clients/edit/3']);
    const tabs = [
      { key: '/orders', dirty: false },
      { key: '/clients/edit/3', dirty: false },
    ];
    const next = nextKeepAliveCache(cache, { activeKey: '/orders', tabs });
    expect(next.has('/orders')).toBe(true);
    expect(next.has('/clients/edit/3')).toBe(false); // clean + inactive → evicted
  });
  it('keeps the active route in its stable owner and evicts it after deactivation', () => {
    const cache = new Set(['/clients/edit/3']);
    const tabs = [{ key: '/clients/edit/3', dirty: false }];
    const next = nextKeepAliveCache(cache, { activeKey: '/clients/edit/3', tabs });
    expect(next.has('/clients/edit/3')).toBe(true);

    const inactive = nextKeepAliveCache(next, {
      activeKey: '/orders',
      tabs: [...tabs, { key: '/orders', dirty: false }],
    });
    expect(inactive.has('/clients/edit/3')).toBe(false);
  });
  it('drops entries whose tab was closed', () => {
    const cache = new Set(['/orders', '/clients/edit/3']);
    const next = nextKeepAliveCache(cache, { activeKey: '/orders', tabs: [{ key: '/orders', dirty: false }] });
    expect(next.has('/clients/edit/3')).toBe(false);
  });
  it('retains a policy-evicted view while its page-owned operation is pinned', () => {
    const blocked: string[] = [];
    const key = '/orders/show/42';
    const next = nextKeepAliveCache(new Set([key]), {
      activeKey: '/orders',
      tabs: [
        { key: '/orders', dirty: false },
        { key, dirty: false },
      ],
      pinnedKeys: new Set([key]),
      onPinnedEviction: (blockedKey) => blocked.push(blockedKey),
    });

    expect(next.has(key)).toBe(true);
    expect(blocked).toEqual([key]);
  });
  it('retains the normally remount-only calendar while its operation is pinned', () => {
    const key = '/calendar';
    const next = nextKeepAliveCache(new Set([key]), {
      activeKey: '/orders',
      tabs: [{ key, dirty: false }, { key: '/orders', dirty: false }],
      pinnedKeys: new Set([key]),
    });

    expect(next.has(key)).toBe(true);
  });

  it('classifies only show/edit/create as heavy and keeps /orders in a separate lightweight slot', () => {
    expect(isHeavyOrderViewKey('/orders/show/1')).toBe(true);
    expect(isHeavyOrderViewKey('/orders/edit/1')).toBe(true);
    expect(isHeavyOrderViewKey('/orders/create')).toBe(true);
    expect(isHeavyOrderViewKey('/orders')).toBe(false);
    expect(isHeavyOrderViewKey('/orders/trash')).toBe(false);
    expect(isLightweightOrdersListKey('/orders')).toBe(true);
  });

  it('uses deterministic activation LRU for A/B/C/D/E and keeps exact C/D/E', () => {
    const keys = ['/orders/show/A', '/orders/show/B', '/orders/show/C', '/orders/show/D', '/orders/show/E'];
    const plan = planKeepAliveCache(new Set(keys), {
      activeKey: '/orders/show/E',
      tabs: keys.map((key) => ({ key, dirty: false })),
      boundedHeavyOrderViews: true,
      activationRevisionByKey: new Map([
        ['/orders/show/A', 1],
        ['/orders/show/B', 2],
        ['/orders/show/D', 3],
        ['/orders/show/C', 4],
        ['/orders/show/E', 5],
      ]),
    });

    expect([...plan.keep].sort()).toEqual([
      '/orders/show/C',
      '/orders/show/D',
      '/orders/show/E',
    ]);
    expect([...plan.evict].sort()).toEqual(['/orders/show/A', '/orders/show/B']);
    expect([...plan.checkpointBeforeEviction].sort()).toEqual([
      '/orders/show/A',
      '/orders/show/B',
    ]);
  });

  it('preserves the legacy clean-show remount policy outside treatment', () => {
    const keys = ['/orders/show/A', '/orders/show/B'];
    const plan = planKeepAliveCache(new Set(keys), {
      activeKey: keys[1],
      tabs: keys.map((key) => ({ key, dirty: false })),
      boundedHeavyOrderViews: false,
    });

    expect(plan.keep).toEqual(new Set([keys[1]]));
    expect(plan.evict).toEqual(new Set([keys[0]]));
  });

  it('uses stable tab key as the LRU tie-break', () => {
    const keys = ['/orders/show/D', '/orders/show/B', '/orders/show/C', '/orders/show/A', '/orders/show/E'];
    const plan = planKeepAliveCache(new Set(keys), {
      activeKey: '/orders/show/E',
      tabs: keys.map((key) => ({ key, dirty: false })),
      boundedHeavyOrderViews: true,
      activationRevisionByKey: new Map(keys.map((key) => [key, key.endsWith('/E') ? 2 : 1])),
    });

    expect([...plan.evict].sort()).toEqual(['/orders/show/A', '/orders/show/B']);
    expect([...plan.keep].sort()).toEqual([
      '/orders/show/C',
      '/orders/show/D',
      '/orders/show/E',
    ]);
  });

  it('bounds ten dirty heavy tabs to three while /orders occupies its own slot', () => {
    const heavyKeys = Array.from({ length: 10 }, (_, index) => `/orders/edit/${index + 1}`);
    const keys = ['/orders', ...heavyKeys];
    const plan = planKeepAliveCache(new Set(keys), {
      activeKey: heavyKeys[9],
      tabs: keys.map((key) => ({ key, dirty: key !== '/orders' })),
      boundedHeavyOrderViews: true,
      activationRevisionByKey: new Map(heavyKeys.map((key, index) => [key, index + 1])),
    });

    expect(plan.keep.has('/orders')).toBe(true);
    expect(countMountedHeavyOrderViews(plan.keep)).toBe(3);
    expect(plan.keep.size).toBe(4);
  });

  it('falls back atomically to legacy mounting when an LRU victim is pinned', () => {
    const keys = Array.from({ length: 5 }, (_, index) => `/orders/edit/${index + 1}`);
    const plan = planKeepAliveCache(new Set(keys), {
      activeKey: keys[4],
      tabs: keys.map((key) => ({ key, dirty: true })),
      pinnedKeys: new Set([keys[0]]),
      boundedHeavyOrderViews: true,
      activationRevisionByKey: new Map(keys.map((key, index) => [key, index + 1])),
    });

    expect(plan.blockedPinnedKeys).toEqual(new Set([keys[0]]));
    expect(plan.keep).toEqual(new Set(keys));
    expect(plan.evict.size).toBe(0);
  });

  it('uses legacy unbounded behavior after the local circuit opens', () => {
    const keys = Array.from({ length: 5 }, (_, index) => `/orders/show/${index + 1}`);
    const plan = planKeepAliveCache(new Set(keys), {
      activeKey: keys[4],
      tabs: keys.map((key) => ({ key, dirty: false })),
      boundedHeavyOrderViews: true,
      circuitOpen: true,
    });

    expect(plan.keep).toEqual(new Set(keys));
    expect(plan.checkpointBeforeEviction.size).toBe(0);
  });

  it('drops a closed heavy tab even while the circuit is open', () => {
    const plan = planKeepAliveCache(new Set(['/orders/show/A', '/orders/show/B']), {
      activeKey: '/orders/show/B',
      tabs: [{ key: '/orders/show/B', dirty: false }],
      boundedHeavyOrderViews: true,
      circuitOpen: true,
    });

    expect(plan.keep).toEqual(new Set(['/orders/show/B']));
    expect(plan.evict).toEqual(new Set(['/orders/show/A']));
  });

  it('captures every LRU victim before deleting any mounted node', () => {
    const calls: string[] = [];
    const plan = {
      keep: new Set(['/orders/show/C']),
      evict: new Set(['/orders/show/A', '/orders/show/B']),
      checkpointBeforeEviction: new Set(['/orders/show/A', '/orders/show/B']),
      blockedPinnedKeys: new Set<string>(),
    };
    const result = commitKeepAliveEvictions({
      plan,
      captureCheckpoint: (key) => { calls.push(`capture:${key}`); return true; },
      evict: (key) => { calls.push(`evict:${key}`); return true; },
      onPinnedEviction: () => undefined,
    });

    expect(result).toEqual({
      circuitOpened: false,
      evictedKeys: ['/orders/show/A', '/orders/show/B'],
    });
    expect(calls).toEqual([
      'capture:/orders/show/A',
      'capture:/orders/show/B',
      'evict:/orders/show/A',
      'evict:/orders/show/B',
    ]);
  });

  it('opens the circuit and retains all heavy victims when one checkpoint fails', () => {
    const evicted: string[] = [];
    const result = commitKeepAliveEvictions({
      plan: {
        keep: new Set(['/orders/show/C']),
        evict: new Set(['/orders/show/A', '/orders/show/B', '/calendar']),
        checkpointBeforeEviction: new Set(['/orders/show/A', '/orders/show/B']),
        blockedPinnedKeys: new Set(),
      },
      captureCheckpoint: (key) => key !== '/orders/show/B',
      evict: (key) => { evicted.push(key); return true; },
      onPinnedEviction: () => undefined,
    });

    expect(result.circuitOpened).toBe(true);
    expect(evicted).toEqual(['/calendar']);
  });

  it('records a blocking pin without attempting checkpoint capture', () => {
    const captureCheckpoint = () => { throw new Error('must not capture'); };
    const pinned: string[] = [];
    const result = commitKeepAliveEvictions({
      plan: {
        keep: new Set(['/orders/edit/1']),
        evict: new Set(),
        checkpointBeforeEviction: new Set(),
        blockedPinnedKeys: new Set(['/orders/edit/1']),
      },
      captureCheckpoint,
      evict: () => true,
      onPinnedEviction: (key) => pinned.push(key),
    });

    expect(result.circuitOpened).toBe(true);
    expect(pinned).toEqual(['/orders/edit/1']);
  });
});
