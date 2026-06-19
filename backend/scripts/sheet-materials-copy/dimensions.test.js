import { describe, it, expect } from 'vitest';
import dimensions from './dimensions.js';
const { parseSheetDimensions, DEFAULT_DIMENSIONS } = dimensions;

describe('parseSheetDimensions', () => {
  it('parses thickness, width, height from a full name', () => {
    expect(parseSheetDimensions('ЛДСП Эггер 2800x2070 16мм')).toEqual({
      thicknessMm: 16, widthMm: 2800, heightMm: 2070,
      parsed: { thickness: true, width: true, height: true },
    });
  });
  it('parses Cyrillic separator х (U+0445)', () => {
    const r = parseSheetDimensions('МДФ 2800х2070');
    expect([r.widthMm, r.heightMm]).toEqual([2800, 2070]);
    expect(r.parsed.width && r.parsed.height).toBe(true);
  });
  it('parses thickness alone, defaults the size', () => {
    expect(parseSheetDimensions('МДФ 18 мм')).toEqual({
      thicknessMm: 18, widthMm: 2800, heightMm: 2070,
      parsed: { thickness: true, width: false, height: false },
    });
  });
  it('defaults everything when nothing parses', () => {
    expect(parseSheetDimensions('ЛДСП белый глянец')).toEqual({
      ...DEFAULT_DIMENSIONS, parsed: { thickness: false, width: false, height: false },
    });
  });
  it('clamps out-of-range thickness to default', () => {
    const r = parseSheetDimensions('ЛДСП 250мм 2800x2070');
    expect(r.thicknessMm).toBe(16);
    expect(r.parsed.thickness).toBe(false);
    expect([r.widthMm, r.heightMm]).toEqual([2800, 2070]);
  });
  it('does not read the size pair as thickness', () => {
    const r = parseSheetDimensions('2800x2070');
    expect(r.thicknessMm).toBe(16);
    expect(r.parsed.thickness).toBe(false);
  });
  it('handles empty/whitespace/non-string', () => {
    expect(parseSheetDimensions('   ')).toEqual({ ...DEFAULT_DIMENSIONS, parsed: { thickness: false, width: false, height: false } });
    expect(parseSheetDimensions(null)).toEqual({ ...DEFAULT_DIMENSIONS, parsed: { thickness: false, width: false, height: false } });
  });
});
