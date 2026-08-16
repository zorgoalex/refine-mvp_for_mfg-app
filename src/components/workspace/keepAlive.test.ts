import { describe, expect, it } from 'vitest';
import { isKeepAliveEligible, nextKeepAliveCache } from './keepAlive';

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
});
