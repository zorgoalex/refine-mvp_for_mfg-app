import { describe, expect, it } from 'vitest';
import { resolveStickySummaryStuck } from './stickySummaryStuck';

describe('resolveStickySummaryStuck', () => {
  it('is false when disabled, even if the sentinel is above the threshold', () => {
    expect(resolveStickySummaryStuck({
      enabled: false,
      wasStuck: false,
      sentinelTop: 0,
      stickyTop: 77,
      expandedHeight: 0,
      currentHeight: 0,
    })).toBe(false);
  });

  it('is false when there is no sentinel node', () => {
    expect(resolveStickySummaryStuck({
      enabled: true,
      wasStuck: true,
      sentinelTop: null,
      stickyTop: 77,
      expandedHeight: 221,
      currentHeight: 143,
    })).toBe(false);
  });

  it('sticks when not stuck and sentinel reaches the threshold', () => {
    expect(resolveStickySummaryStuck({
      enabled: true,
      wasStuck: false,
      sentinelTop: 77,
      stickyTop: 77,
      expandedHeight: 0,
      currentHeight: 0,
    })).toBe(true);
  });

  it('stays unstuck when not stuck and sentinel is below the threshold', () => {
    expect(resolveStickySummaryStuck({
      enabled: true,
      wasStuck: false,
      sentinelTop: 78,
      stickyTop: 77,
      expandedHeight: 0,
      currentHeight: 0,
    })).toBe(false);
  });

  it('stays stuck when the sentinel moves down by exactly the collapse delta (198<->276 scenario)', () => {
    // stickyTop 77, expanded 221, compact 143 -> collapseDelta 78.
    // Sentinel shifted from ~top(stuck) to stickyTop + 78 due to the scroll
    // clamp caused by the header's own collapse; must remain stuck.
    expect(resolveStickySummaryStuck({
      enabled: true,
      wasStuck: true,
      sentinelTop: 77 + 78,
      stickyTop: 77,
      expandedHeight: 221,
      currentHeight: 143,
    })).toBe(true);
  });

  it('unsticks when the sentinel moves beyond threshold + collapse delta (real scroll-up)', () => {
    expect(resolveStickySummaryStuck({
      enabled: true,
      wasStuck: true,
      sentinelTop: 77 + 78 + 5,
      stickyTop: 77,
      expandedHeight: 221,
      currentHeight: 143,
    })).toBe(false);
  });

  it('falls back to the plain threshold rule when expandedHeight is unknown (0)', () => {
    expect(resolveStickySummaryStuck({
      enabled: true,
      wasStuck: true,
      sentinelTop: 77,
      stickyTop: 77,
      expandedHeight: 0,
      currentHeight: 143,
    })).toBe(true);

    // Beyond the 1px subpixel tolerance, it still unsticks like the old rule.
    expect(resolveStickySummaryStuck({
      enabled: true,
      wasStuck: true,
      sentinelTop: 79,
      stickyTop: 77,
      expandedHeight: 0,
      currentHeight: 143,
    })).toBe(false);
  });

  it('tolerates 1px of subpixel rounding at the boundary', () => {
    expect(resolveStickySummaryStuck({
      enabled: true,
      wasStuck: true,
      sentinelTop: 77 + 78 + 1,
      stickyTop: 77,
      expandedHeight: 221,
      currentHeight: 143,
    })).toBe(true);
  });
});
