import { describe, expect, it } from 'vitest';
import { getColumnWidths, getGridCell, getEdgeVelocity, getScrollFrameScale, moveRange } from './excelGridGeometry';
import type { ParsedSheet } from '../types/importTypes';

describe('Excel preview geometry', () => {
  it('scales sparse animation frames by elapsed time and caps stalled frames', () => {
    expect(getScrollFrameScale(100, null)).toBe(1);
    expect(getScrollFrameScale(150, 100)).toBeCloseTo(3);
    expect(getScrollFrameScale(1100, 100)).toBeCloseTo(3.84);
    expect(getScrollFrameScale(90, 100)).toBe(0);
    const sparseDistance = Array.from({ length: 20 }, (_, i) => 18 * getScrollFrameScale((i + 1) * 50, i * 50)).reduce((a, b) => a + b, 0);
    expect(sparseDistance).toBeCloseTo(18 * 60);
  });
  const sheet: ParsedSheet = { name: 'test', data: [[123, 'Длинное значение', null], [12345, 'x', null]],
    rowCount: 2, colCount: 3, headers: ['A', 'B', 'C'] };
  it('fits each column to its longest value, keeps empty columns compact and dropdowns usable', () => {
    const widths = getColumnWidths(sheet, text => text.length * 7, new Set([0]));
    expect(widths[0]).toBe(64);
    expect(widths[1]).toBe('Длинное значение'.length * 7 + 14);
    expect(widths[2]).toBe(24);
  });
  it('measures longest line, bounds long notes and distributes merged banners', () => {
    const sample = { ...sheet, data: [['x'.repeat(1000), 'a\nbb', null]],
      merges: [{ startRow: 0, endRow: 0, startCol: 0, endCol: 2 }] };
    expect(getColumnWidths(sample, text => text.length * 7, new Set())[0]).toBe(280);
    expect(getColumnWidths(sample, text => text.length * 7, new Set())[1]).toBe(36);
  });
  it('maps scrolled content coordinates to all rows/columns, including beyond the old limits', () => {
    const widths = Array(40).fill(64);
    expect(getGridCell(widths, 400, 40 + 35 * 64 + 1, 52 + 250 * 26 + 1)).toEqual({ row: 250, col: 35 });
    expect(getGridCell(widths, 400, -100, -100)).toEqual({ row: 0, col: 0 });
    expect(getGridCell(widths, 400, 99999, 99999)).toEqual({ row: 399, col: 39 });
  });
  it('scrolls towards each edge, including outside, but not at the center', () => {
    expect(getEdgeVelocity(5, 0, 500)).toBeLessThan(0);
    expect(getEdgeVelocity(495, 0, 500)).toBeGreaterThan(0);
    expect(getEdgeVelocity(250, 0, 500)).toBe(0);
    expect(getEdgeVelocity(-500, 0, 500)).toBe(-18);
  });
  it('moves the whole range without resizing, clamping at every sheet boundary', () => {
    const range = { id: 'a', startRow: 4, endRow: 2, startCol: 3, endCol: 1 };
    expect(moveRange(range, 100, 100, 10, 8)).toMatchObject({ startRow: 7, endRow: 9, startCol: 5, endCol: 7 });
    expect(moveRange(range, -100, -100, 10, 8)).toMatchObject({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 });
  });
});
