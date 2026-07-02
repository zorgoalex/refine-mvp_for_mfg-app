/**
 * TDD tests for pieceLabel.ts pure helpers.
 * Runs under vitest env=node (no jsdom, no React).
 */

import { describe, expect, it } from 'vitest';
import { buildPieceLabelLines, fitLabelScale, splitDimsLine, LINE1_SCALE } from './pieceLabel';

describe('buildPieceLabelLines', () => {
  it('returns exactly 3 strings for full data with orderName', () => {
    const lines = buildPieceLabelLines({
      orderName: 'Кухня-42',
      orderId: 42,
      detailNumber: 3,
      instance: 1,
      qty: 2,
      widthMm: 300,
      heightMm: 200,
    });
    expect(lines).toHaveLength(3);
    // L1: order name (not "Заказ N")
    expect(lines[0]).toBe('Кухня-42');
    // L2: # prefix (not Поз.)
    expect(lines[1]).toBe('# 3 · 1/2');
    // L3: * separator (not ×)
    expect(lines[2]).toBe('300*200');
  });

  it('appends a 4th material line when materialName is a non-blank string', () => {
    const lines = buildPieceLabelLines({
      orderName: 'Кухня-42',
      orderId: 42,
      detailNumber: 3,
      instance: 1,
      qty: 2,
      widthMm: 300,
      heightMm: 200,
      materialName: 'ЛДСП Белый',
    });
    expect(lines).toHaveLength(4);
    expect(lines[2]).toBe('300*200');
    expect(lines[3]).toBe('ЛДСП Белый');
  });

  it('omits the material line when materialName is null/undefined/blank', () => {
    const base = { orderName: 'X', orderId: 1, detailNumber: 1, instance: 1, qty: 1, widthMm: 10, heightMm: 10 };
    expect(buildPieceLabelLines(base)).toHaveLength(3);
    expect(buildPieceLabelLines({ ...base, materialName: null })).toHaveLength(3);
    expect(buildPieceLabelLines({ ...base, materialName: '   ' })).toHaveLength(3);
  });

  it('falls back to "Заказ N" when orderName is null', () => {
    const lines = buildPieceLabelLines({
      orderName: null,
      orderId: 42,
      detailNumber: 3,
      instance: 1,
      qty: 2,
      widthMm: 300,
      heightMm: 200,
    });
    expect(lines[0]).toBe('Заказ 42');
  });

  it('falls back to "Заказ N" when orderName is empty string', () => {
    const lines = buildPieceLabelLines({
      orderName: '   ',
      orderId: 10,
      detailNumber: 1,
      instance: 1,
      qty: 1,
      widthMm: 100,
      heightMm: 100,
    });
    expect(lines[0]).toBe('Заказ 10');
  });

  it('falls back to "Заказ —" when orderName is null and orderId is null', () => {
    const lines = buildPieceLabelLines({
      orderName: null,
      orderId: null,
      detailNumber: 1,
      instance: 1,
      qty: 1,
      widthMm: 100,
      heightMm: 100,
    });
    expect(lines[0]).toBe('Заказ —');
  });

  it('omits /qty when qty is null', () => {
    const lines = buildPieceLabelLines({
      orderName: null,
      orderId: 10,
      detailNumber: 5,
      instance: 2,
      qty: null,
      widthMm: 100,
      heightMm: 100,
    });
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('# 5 · 2');
    expect(lines[1]).not.toContain('/');
  });

  it('falls back gracefully when detailNumber is null — shows # —', () => {
    const lines = buildPieceLabelLines({
      orderName: null,
      orderId: 1,
      detailNumber: null,
      instance: 3,
      qty: null,
      widthMm: 200,
      heightMm: 300,
    });
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('#');
    expect(lines[1]).toContain('—');
    expect(lines[1]).toContain('·');
    expect(lines[1]).toContain('3');
  });

  it('handles null orderId gracefully — returns non-empty line 1 with fallback', () => {
    const lines = buildPieceLabelLines({
      orderName: null,
      orderId: null,
      detailNumber: 2,
      instance: 1,
      qty: 3,
      widthMm: 200,
      heightMm: 100,
    });
    expect(lines).toHaveLength(3);
    expect(lines[0].length).toBeGreaterThan(0);
    // L2 uses # prefix
    expect(lines[1]).toBe('# 2 · 1/3');
    // L3 uses * separator
    expect(lines[2]).toBe('200*100');
  });

  it('formats whole-number dims without decimal, asterisk separator', () => {
    const lines = buildPieceLabelLines({
      orderName: null,
      orderId: 1,
      detailNumber: 1,
      instance: 1,
      qty: 1,
      widthMm: 300,
      heightMm: 200,
    });
    expect(lines[2]).toBe('300*200');
  });

  it('formats non-integer dims with 1 decimal place, asterisk separator', () => {
    const lines = buildPieceLabelLines({
      orderName: null,
      orderId: 1,
      detailNumber: 1,
      instance: 1,
      qty: 1,
      widthMm: 300.5,
      heightMm: 200.25,
    });
    expect(lines[2]).toBe('300.5*200.3');
  });

  it('never returns empty strings even for degenerate inputs', () => {
    const lines = buildPieceLabelLines({
      orderName: null,
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

  it('does NOT use Поз. prefix in L2', () => {
    const lines = buildPieceLabelLines({
      orderName: null,
      orderId: 1,
      detailNumber: 5,
      instance: 1,
      qty: 2,
      widthMm: 100,
      heightMm: 100,
    });
    expect(lines[1]).not.toMatch(/Поз\./);
    expect(lines[1]).not.toMatch(/^п\./);
  });

  it('does NOT use × in L3', () => {
    const lines = buildPieceLabelLines({
      orderName: null,
      orderId: 1,
      detailNumber: 1,
      instance: 1,
      qty: 1,
      widthMm: 500,
      heightMm: 300,
    });
    expect(lines[2]).not.toContain('×');
    expect(lines[2]).toContain('*');
  });
});

describe('splitDimsLine', () => {
  it('splits "300*200" into w and h', () => {
    expect(splitDimsLine('300*200')).toEqual({ w: '300', h: '200' });
  });

  it('splits with decimal values', () => {
    expect(splitDimsLine('300.5*200.3')).toEqual({ w: '300.5', h: '200.3' });
  });

  it('returns null when no * found', () => {
    expect(splitDimsLine('300×200')).toBeNull();
    expect(splitDimsLine('no separator')).toBeNull();
    expect(splitDimsLine('')).toBeNull();
  });
});

describe('LINE1_SCALE', () => {
  it('is exported and equals 1.7', () => {
    expect(LINE1_SCALE).toBe(1.7);
  });
});

describe('fitLabelScale', () => {
  it('returns 1 for a large box (font fits easily)', () => {
    const scale = fitLabelScale({
      lines: ['Заказ 1', '# 1 · 1/1', '200*300'],
      boxW: 5000,
      boxH: 3000,
      baseFont: 10,
    });
    expect(scale).toBe(1);
  });

  it('returns a value strictly in (0.3, 1) for a medium box', () => {
    const scale = fitLabelScale({
      lines: ['Заказ 100', '# 5 · 1/3', '800*400'],
      boxW: 50,
      boxH: 18,
      baseFont: 10,
    });
    expect(scale).toBeGreaterThanOrEqual(0.3);
    expect(scale).toBeLessThan(1);
  });

  it('clamps to default minScale 0.3 for a tiny box', () => {
    const scale = fitLabelScale({
      lines: ['Заказ 42', '# 99 · 1/999', '9999*9999'],
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

  it('with line1Scale=1.7: a box that fits 3 equal lines at scale=1 shrinks when L1 is larger', () => {
    // Calibrate a box that exactly fits 3 equal lines of 5 chars at baseFont=10:
    // blockH = 3 * 10 * 1.2 = 36; widthFit at 5 chars = 5*10*0.6 = 30
    // Without line1Scale, a box of (31, 37) would return 1 (fits comfortably).
    const scaleNormal = fitLabelScale({
      lines: ['AAAAA', 'BBBBB', 'CCCCC'],
      boxW: 31,
      boxH: 37,
      baseFont: 10,
      line1Scale: 1,
    });
    expect(scaleNormal).toBe(1);

    // Same box with line1Scale=1.7:
    // blockH = (1.7+1+1) * 10 * 1.2 = 3.7 * 12 = 44.4  → heightFit = 37/44.4 < 1
    // L0 width = 5 * 10 * 0.6 * 1.7 = 51 → widthFit = 31/51 < 1
    const scaleLarge = fitLabelScale({
      lines: ['AAAAA', 'BBBBB', 'CCCCC'],
      boxW: 31,
      boxH: 37,
      baseFont: 10,
      line1Scale: 1.7,
    });
    expect(scaleLarge).toBeLessThan(1);
  });

  it('with default line1Scale=1 behaves like the old 3-line uniform calculation', () => {
    // longestLine = 'ABCDEFGH' (8 chars) → width = 8*10*0.6 = 48, height = 3*10*1.2=36
    // boxW=50, boxH=40 → widthFit=50/48≈1.04, heightFit=40/36≈1.11 → clamped to 1
    const scale = fitLabelScale({
      lines: ['ABCDEFGH', 'short', 'XY'],
      boxW: 50,
      boxH: 40,
      baseFont: 10,
    });
    expect(scale).toBe(1);
  });
});
