import { describe, expect, it } from 'vitest';
import { isKeepAliveEligible, nextKeepAliveCache } from './keepAlive';

describe('keep-alive policy', () => {
  it('keeps /orders list always; calendar never', () => {
    expect(isKeepAliveEligible('/orders', { dirty: false })).toBe(true);
    expect(isKeepAliveEligible('/calendar', { dirty: false })).toBe(false);
    expect(isKeepAliveEligible('/calendar', { dirty: true })).toBe(false); // calendar excluded even if dirty
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
  it('evicts active clean dirty-only entry so outlet is not rendered twice', () => {
    const cache = new Set(['/orders/edit/42']);
    const tabs = [{ key: '/orders/edit/42', dirty: false }];
    const next = nextKeepAliveCache(cache, { activeKey: '/orders/edit/42', tabs });
    expect(next.has('/orders/edit/42')).toBe(false);
  });
  it('drops entries whose tab was closed', () => {
    const cache = new Set(['/orders', '/clients/edit/3']);
    const next = nextKeepAliveCache(cache, { activeKey: '/orders', tabs: [{ key: '/orders', dirty: false }] });
    expect(next.has('/clients/edit/3')).toBe(false);
  });
});
