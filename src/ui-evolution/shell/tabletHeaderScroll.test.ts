import { describe, expect, it } from 'vitest';
import { nextTabletHeaderCompactState } from './tabletHeaderScroll';

describe('nextTabletHeaderCompactState', () => {
  it('uses 32/8px hysteresis for a vertical scroll owner', () => {
    expect(nextTabletHeaderCompactState(false, { scrollTop: 31, scrollHeight: 900, clientHeight: 500 })).toBe(false);
    expect(nextTabletHeaderCompactState(false, { scrollTop: 32, scrollHeight: 900, clientHeight: 500 })).toBe(true);
    expect(nextTabletHeaderCompactState(true, { scrollTop: 9, scrollHeight: 900, clientHeight: 500 })).toBe(true);
    expect(nextTabletHeaderCompactState(true, { scrollTop: 8, scrollHeight: 900, clientHeight: 500 })).toBe(false);
  });

  it('ignores horizontal-only and non-scrollable owners', () => {
    expect(nextTabletHeaderCompactState(false, {
      scrollTop: 40,
      scrollHeight: 500,
      clientHeight: 500,
      horizontalOnly: true,
    })).toBe(false);
    expect(nextTabletHeaderCompactState(true, {
      scrollTop: 0,
      scrollHeight: 500,
      clientHeight: 500,
    })).toBe(true);
  });
});
