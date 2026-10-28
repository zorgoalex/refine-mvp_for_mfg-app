import { describe, expect, it } from 'vitest';
import { mdfDeepLinkLookup } from './mdfDeepLink';

const shownHybrid = {
  active: true,
  loading: false,
  loadFailed: false,
  ordersLoading: false,
  renderMode: 'published' as const,
  engineViewShown: false,
  publishedLoading: false,
  publishedSettledForQuery: true,
  kind: 'packet',
  cardId: 'p-1',
  todayFocusBathCardId: null,
};

describe('mdfDeepLinkLookup', () => {
  it('looks for the card once the shown data were read for this very link', () => {
    expect(mdfDeepLinkLookup(shownHybrid)).toBe('look');
    expect(mdfDeepLinkLookup({ ...shownHybrid, renderMode: 'legacy', publishedSettledForQuery: false })).toBe('look');
  });

  it('a hidden board, the engine view (it marks the card itself) and an unavailable board are skipped', () => {
    expect(mdfDeepLinkLookup({ ...shownHybrid, active: false })).toBe('skip');
    expect(mdfDeepLinkLookup({ ...shownHybrid, engineViewShown: true })).toBe('skip');
    expect(mdfDeepLinkLookup({ ...shownHybrid, renderMode: 'unavailable' })).toBe('skip');
  });

  it('waits while the engine mode or the snapshot of this focus is not in yet (prefetched today already shown)', () => {
    expect(mdfDeepLinkLookup({ ...shownHybrid, renderMode: 'loading' })).toBe('wait');
    expect(mdfDeepLinkLookup({ ...shownHybrid, publishedLoading: true })).toBe('wait');
    // the card was linked on an open board: what is shown is the snapshot of the previous focus
    expect(mdfDeepLinkLookup({ ...shownHybrid, publishedSettledForQuery: false })).toBe('wait');
    expect(mdfDeepLinkLookup({ ...shownHybrid, loading: true })).toBe('wait');
    // today shown, its order cards (planned-today filter) still loading
    expect(mdfDeepLinkLookup({ ...shownHybrid, ordersLoading: true })).toBe('wait');
    // the background read on return failed: older data is shown — no "not found" until a read succeeds
    expect(mdfDeepLinkLookup({ ...shownHybrid, loadFailed: true })).toBe('wait');
    expect(mdfDeepLinkLookup({ ...shownHybrid, renderMode: 'legacy', loadFailed: true })).toBe('wait');
  });

  it('a linked bath waits for today read with it as its focus, on the legacy board too', () => {
    const bath = { ...shownHybrid, kind: 'bath', cardId: 'b-7' };
    expect(mdfDeepLinkLookup(bath)).toBe('wait');
    expect(mdfDeepLinkLookup({ ...bath, renderMode: 'legacy', todayFocusBathCardId: 'b-1' })).toBe('wait');
    expect(mdfDeepLinkLookup({ ...bath, todayFocusBathCardId: 'b-7' })).toBe('look');
    expect(mdfDeepLinkLookup({ ...bath, renderMode: 'legacy', todayFocusBathCardId: 'b-7' })).toBe('look');
  });
});
