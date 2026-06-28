/**
 * TDD tests for pieceLabel.ts pure helpers.
 * Runs under vitest env=node (no jsdom, no React).
 */

import { describe, expect, it } from 'vitest';
import { buildPieceLabelLines, fitLabelScale } from './pieceLabel';

describe('buildPieceLabelLines', () => {
  it('returns exactly 3 strings for full data', () => {
    const lines = buildPieceLabelLines({
      orderId: 42,
      detailNumber: 3,
      instance: 1,
      qty: 2,
      widthMm: 300,
      heightMm: 200,
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Заказ 42');
    expect(lines[1]).toBe('Поз. 3 · 1/2');
    expect(lines[2]).toBe('300×200');
  });

  it('omits /qty when qty is null', () => {
    const lines = buildPieceLabelLines({
      orderId: 10,
      detailNumber: 5,
      instance: 2,
      qty: null,
      widthMm: 100,
      heightMm: 100,
    });
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('Поз. 5 · 2');
    expect(lines[1]).not.toContain('/');
  });

  it('falls back gracefully when detailNumber is null', () => {
    const lines = buildPieceLabelLines({
      orderId: 1,
      detailNumber: null,
      instance: 3,
      qty: null,
      widthMm: 200,
      heightMm: 300,
    });
    expect(lines).toHaveLength(3);
    // Line 2 must still contain the instance separator
    expect(lines[1]).toContain('·');
    expect(lines[1]).toContain('3');
  });

  it('handles null orderId gracefully — returns non-empty line 1', () => {
    const lines = buildPieceLabelLines({
      orderId: null,
      detailNumber: 2,
      instance: 1,
      qty: 3,
      widthMm: 200,
      heightMm: 100,
    });
    expect(lines).toHaveLength(3);
    expect(lines[0].length).toBeGreaterThan(0);
    // Line 1 should still contain orderId placeholder
    expect(lines[1]).toBe('Поз. 2 · 1/3');
    expect(lines[2]).toBe('200×100');
  });

  it('formats whole-number dims without decimal', () => {
    const lines = buildPieceLabelLines({
      orderId: 1,
      detailNumber: 1,
      instance: 1,
      qty: 1,
      widthMm: 300,
      heightMm: 200,
    });
    expect(lines[2]).toBe('300×200');
  });

  it('formats non-integer dims with 1 decimal place', () => {
    const lines = buildPieceLabelLines({
      orderId: 1,
      detailNumber: 1,
      instance: 1,
      qty: 1,
      widthMm: 300.5,
      heightMm: 200.25,
    });
    expect(lines[2]).toBe('300.5×200.3');
  });

  it('never returns empty strings even for degenerate inputs', () => {
    const lines = buildPieceLabelLines({
      orderId: null,
      detailNumber: null,
      instance: 0,
      qty: null,
      widthMm: 0,
      heightMm: 0,
    });
    expect(lines).toHaveLength(3);
    lines.forEach((l) => expect(l.length).toBeGreaterThan(0));
  });
});

describe('fitLabelScale', () => {
  it('returns 1 for a large box (font fits easily)', () => {
    const scale = fitLabelScale({
      lines: ['Заказ 1', 'Поз. 1 · 1/1', '200×300'],
      boxW: 5000,
      boxH: 3000,
      baseFont: 10,
    });
    expect(scale).toBe(1);
  });

  it('returns a value strictly in (0.3, 1) for a medium box', () => {
    // longestLine='Поз. 5 · 1/3' (13 chars) → longestLineWidth=13*10*0.6=78, blockH=3*10*1.2=36
    // widthFit=50/78≈0.64, heightFit=18/36=0.5 → scale=0.5 (fits in [0.3,1))
    const scale = fitLabelScale({
      lines: ['Заказ 100', 'Поз. 5 · 1/3', '800×400'],
      boxW: 50,
      boxH: 18,
      baseFont: 10,
    });
    expect(scale).toBeGreaterThanOrEqual(0.3);
    expect(scale).toBeLessThan(1);
  });

  it('clamps to default minScale 0.3 for a tiny box', () => {
    const scale = fitLabelScale({
      lines: ['Заказ 42', 'Поз. 99 · 1/999', '9999×9999'],
      boxW: 5,
      boxH: 2,
      baseFont: 10,
    });
    expect(scale).toBe(0.3);
  });

  it('never goes below the default minScale of 0.3', () => {
    const scale = fitLabelScale({
      lines: ['X'.repeat(100)],
      boxW: 1,
      boxH: 1,
      baseFont: 10,
    });
    expect(scale).toBeGreaterThanOrEqual(0.3);
  });

  it('respects a custom minScale', () => {
    const scale = fitLabelScale({
      lines: ['very long line that definitely does not fit in this box at all'],
      boxW: 1,
      boxH: 1,
      baseFont: 10,
      minScale: 0.5,
    });
    expect(scale).toBe(0.5);
  });

  it('returns minScale for degenerate zero-width box', () => {
    const scale = fitLabelScale({
      lines: ['A'],
      boxW: 0,
      boxH: 100,
      baseFont: 10,
    });
    expect(scale).toBe(0.3);
  });

  it('returns minScale for degenerate zero-height box', () => {
    const scale = fitLabelScale({
      lines: ['A'],
      boxW: 100,
      boxH: 0,
      baseFont: 10,
    });
    expect(scale).toBe(0.3);
  });

  it('returns minScale for degenerate zero baseFont', () => {
    const scale = fitLabelScale({
      lines: ['A'],
      boxW: 100,
      boxH: 100,
      baseFont: 0,
    });
    expect(scale).toBe(0.3);
  });
});
