import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import {
  RENDER_PRESETS,
  assertFontAvailable,
  renderRawSvgPng,
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

describe('renderRawSvgPng generated screenshot contrast', () => {
  it('darkens pale SVG geometry against a white sheet', () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">',
      '<rect width="20" height="20" fill="#fff"/>',
      '<rect x="4" y="4" width="12" height="12" fill="#eeeeee"/>',
      '</svg>',
    ].join('');
    const baseline = PNG.sync.read(renderRawSvgPng({
      svg,
      targetPx: 100,
      sheetWidthMm: 20,
      sheetHeightMm: 20,
      contrast: 1,
    }));
    const enhanced = PNG.sync.read(renderRawSvgPng({
      svg,
      targetPx: 100,
      sheetWidthMm: 20,
      sheetHeightMm: 20,
      contrast: 2,
    }));
    const baselineIndex = (50 * baseline.width + 50) * 4;
    const enhancedIndex = (50 * enhanced.width + 50) * 4;

    expect(pngChannel(enhanced, enhancedIndex)).toBeLessThan(pngChannel(baseline, baselineIndex));
    expect(pngChannel(enhanced, enhancedIndex + 1)).toBeLessThan(pngChannel(baseline, baselineIndex + 1));
    expect(pngChannel(enhanced, enhancedIndex + 2)).toBeLessThan(pngChannel(baseline, baselineIndex + 2));
  });

  it('honors 600% contrast for generated screenshots', () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">',
      '<rect width="20" height="20" fill="#fff"/>',
      '<rect x="4" y="4" width="12" height="12" fill="#eeeeee"/>',
      '</svg>',
    ].join('');
    const contrast300 = PNG.sync.read(renderRawSvgPng({
      svg,
      targetPx: 100,
      sheetWidthMm: 20,
      sheetHeightMm: 20,
      contrast: 3,
    }));
    const contrast600 = PNG.sync.read(renderRawSvgPng({
      svg,
      targetPx: 100,
      sheetWidthMm: 20,
      sheetHeightMm: 20,
      contrast: 6,
    }));
    const index = (50 * contrast300.width + 50) * 4;

    expect(pngChannel(contrast600, index)).toBeLessThan(pngChannel(contrast300, index));
    expect(pngChannel(contrast600, index + 1)).toBeLessThan(pngChannel(contrast300, index + 1));
    expect(pngChannel(contrast600, index + 2)).toBeLessThan(pngChannel(contrast300, index + 2));
  });
});

function pngChannel(image: PNG, index: number): number {
  return image.data[index] ?? 255;
}
