import { describe, expect, it } from 'vitest';
import {
  calculateColumnsPerRow,
  calculateRowWidth,
  groupDaysIntoRows,
  isMobileDevice,
  isNarrowDevice,
  LAYOUT_CONFIG,
} from './calendarLayout';

describe('isNarrowDevice', () => {
  it('returns true for width <= 480', () => {
    expect(isNarrowDevice(375)).toBe(true);
    expect(isNarrowDevice(480)).toBe(true);
  });

  it('returns false for width > 480', () => {
    expect(isNarrowDevice(481)).toBe(false);
    expect(isNarrowDevice(600)).toBe(false);
    expect(isNarrowDevice(1280)).toBe(false);
  });
});

describe('isMobileDevice', () => {
  it('treats width <= MOBILE_BREAKPOINT as mobile', () => {
    expect(isMobileDevice(375)).toBe(true);
    expect(isMobileDevice(600)).toBe(true);
    expect(isMobileDevice(LAYOUT_CONFIG.MOBILE_BREAKPOINT)).toBe(true);
  });

  it('treats width > MOBILE_BREAKPOINT as desktop', () => {
    expect(isMobileDevice(769)).toBe(false);
    expect(isMobileDevice(1024)).toBe(false);
  });
});

describe('calculateColumnsPerRow — AD-6 narrow branch', () => {
  it('forces 1 column at narrow widths with full container width', () => {
    const result = calculateColumnsPerRow(375, true, 1.0, true);
    expect(result.columnsPerRow).toBe(1);
    expect(result.columnWidth).toBe(375 - LAYOUT_CONFIG.CONTAINER_PADDING);
  });

  it('narrow branch takes precedence over mobile branch', () => {
    const result = calculateColumnsPerRow(480, true, 1.0, true);
    expect(result.columnsPerRow).toBe(1);
  });

  it('narrow branch ignores cardScale (column always fits container)', () => {
    const narrow = calculateColumnsPerRow(375, true, 1.0, true);
    const narrowZoomed = calculateColumnsPerRow(375, true, 1.5, true);
    expect(narrow.columnWidth).toBe(narrowZoomed.columnWidth);
  });

  it('column width is at least MOBILE_MIN_COLUMN_WIDTH on tiny containers', () => {
    const result = calculateColumnsPerRow(0, true, 1.0, true);
    expect(result.columnWidth).toBeGreaterThanOrEqual(LAYOUT_CONFIG.MOBILE_MIN_COLUMN_WIDTH);
  });
});

describe('calculateColumnsPerRow — mobile branch (existing)', () => {
  it('returns 2 columns on very narrow mobile (between 2x MIN + gap)', () => {
    const width = 360;
    const result = calculateColumnsPerRow(width, true, 1.0, false);
    expect(result.columnsPerRow).toBe(2);
  });

  it('returns 2-3 columns on wider mobile', () => {
    const result = calculateColumnsPerRow(700, true, 1.0, false);
    expect(result.columnsPerRow).toBeGreaterThanOrEqual(2);
    expect(result.columnsPerRow).toBeLessThanOrEqual(3);
  });
});

describe('calculateColumnsPerRow — desktop branch', () => {
  it('uses fixed DESKTOP_COLUMN_WIDTH for desktop', () => {
    const result = calculateColumnsPerRow(1280, false, 1.0, false);
    expect(result.columnWidth).toBe(LAYOUT_CONFIG.DESKTOP_COLUMN_WIDTH);
    expect(result.columnsPerRow).toBeGreaterThan(0);
  });
});

describe('groupDaysIntoRows', () => {
  it('groups items by columnsPerRow', () => {
    const days = [1, 2, 3, 4, 5, 6, 7];
    const rows = groupDaysIntoRows(days, 3);
    expect(rows).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });

  it('returns single row when items fit in one row', () => {
    const days = [1, 2, 3];
    const rows = groupDaysIntoRows(days, 5);
    expect(rows).toEqual([[1, 2, 3]]);
  });

  it('returns empty array for empty input', () => {
    expect(groupDaysIntoRows([], 3)).toEqual([]);
  });
});

describe('calculateRowWidth', () => {
  it('sums column widths and gaps', () => {
    expect(calculateRowWidth(100, 1)).toBe(100);
    expect(calculateRowWidth(100, 2)).toBe(100 * 2 + LAYOUT_CONFIG.COLUMN_GAP);
    expect(calculateRowWidth(100, 3)).toBe(100 * 3 + LAYOUT_CONFIG.COLUMN_GAP * 2);
  });
});
