import { describe, expect, it } from 'vitest';
import { LAYOUT_CONFIG } from '../utils/calendarLayout';
import { classifyWidth, DEFAULT_RESPONSIVE_STATE } from './useResponsive';

describe('classifyWidth', () => {
  it('treats width <= 480 as isNarrow + isMobile', () => {
    const state = classifyWidth(375);
    expect(state).toEqual({ isMobile: true, isNarrow: true, width: 375 });
  });

  it('treats width 481-768 as isMobile but not isNarrow', () => {
    const state = classifyWidth(600);
    expect(state.isMobile).toBe(true);
    expect(state.isNarrow).toBe(false);
    expect(state.width).toBe(600);
  });

  it('treats width exactly at the mobile breakpoint as mobile (consistent with isMobileDevice)', () => {
    const state = classifyWidth(LAYOUT_CONFIG.MOBILE_BREAKPOINT);
    expect(state.isMobile).toBe(true);
    expect(state.isNarrow).toBe(false);
    expect(state.width).toBe(LAYOUT_CONFIG.MOBILE_BREAKPOINT);
  });

  it('treats width above the mobile breakpoint as desktop', () => {
    const state = classifyWidth(1280);
    expect(state.isMobile).toBe(false);
    expect(state.isNarrow).toBe(false);
    expect(state.width).toBe(1280);
  });

  it('returns the provided fallback for non-positive or NaN widths', () => {
    const fallback = { isMobile: true, isNarrow: true, width: 0 } as const;
    expect(classifyWidth(0, fallback)).toBe(fallback);
    expect(classifyWidth(-10, fallback)).toBe(fallback);
    expect(classifyWidth(Number.NaN, fallback)).toBe(fallback);
  });

  it('returns DEFAULT_RESPONSIVE_STATE for invalid widths when no fallback is given', () => {
    expect(classifyWidth(0)).toBe(DEFAULT_RESPONSIVE_STATE);
    expect(classifyWidth(Number.NaN)).toBe(DEFAULT_RESPONSIVE_STATE);
  });
});
