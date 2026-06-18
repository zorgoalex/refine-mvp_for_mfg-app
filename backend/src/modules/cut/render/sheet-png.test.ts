import { describe, expect, it } from 'vitest';
import {
  RENDER_PRESETS,
  assertFontAvailable,
  renderSheetPng,
  resolveFontPath,
} from './sheet-png';
import { buildSheetSvg } from './sheet-svg';
import type { SheetPlacementsJson } from '../application/cut-freecut-mapping';

const sheet: SheetPlacementsJson = {
  trim_mm: { left: 10, top: 10, right: 10, bottom: 10 },
  sheet_width_mm: 2800,
  sheet_height_mm: 2070,
  pieces: [
    { item_id: 'det-1', instance: 1, x_mm: 0, y_mm: 0, width_mm: 600, height_mm: 400, rotated: false },
  ],
};

const PNG_MAGIC = '89504e47';

describe('render presets (§7)', () => {
  it('exposes thumb/screen/print longest-side caps', () => {
    expect(RENDER_PRESETS.thumb).toBeLessThan(RENDER_PRESETS.screen);
    expect(RENDER_PRESETS.screen).toBeLessThan(RENDER_PRESETS.print);
    expect(RENDER_PRESETS).toMatchObject({ thumb: 360, screen: 1400, print: 3500 });
  });
});

describe('bundled font (MINOR-16 container contract)', () => {
  it('resolves the committed TTF path', () => {
    expect(resolveFontPath()).not.toBeNull();
  });

  it('startup assert passes when the font is present (fail-fast otherwise)', () => {
    expect(() => assertFontAvailable()).not.toThrow();
  });
});

describe('renderSheetPng (resvg)', () => {
  it('renders a non-empty PNG at the screen preset', () => {
    const svg = buildSheetSvg({ sheet, labelFor: () => 'д1' });
    const png = renderSheetPng({
      svg,
      targetPx: RENDER_PRESETS.screen,
      sheetWidthMm: sheet.sheet_width_mm,
      sheetHeightMm: sheet.sheet_height_mm,
    });
    expect(png.length).toBeGreaterThan(0);
    expect(png.subarray(0, 4).toString('hex')).toBe(PNG_MAGIC);
  });

  it('caps the longest side to the preset for a landscape sheet', () => {
    const svg = buildSheetSvg({ sheet, labelFor: () => 'д1' });
    const png = renderSheetPng({
      svg,
      targetPx: RENDER_PRESETS.thumb,
      sheetWidthMm: sheet.sheet_width_mm,
      sheetHeightMm: sheet.sheet_height_mm,
    });
    // sanity: thumb produces a smaller buffer than screen
    const big = renderSheetPng({
      svg,
      targetPx: RENDER_PRESETS.screen,
      sheetWidthMm: sheet.sheet_width_mm,
      sheetHeightMm: sheet.sheet_height_mm,
    });
    expect(png.length).toBeLessThan(big.length);
  });
});
