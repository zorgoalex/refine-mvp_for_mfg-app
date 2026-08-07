import { describe, expect, it } from 'vitest';
import { DEFAULT_FREECUT_PARAMS, DEFAULT_GRAIN_RULES } from './cut-config';
import { computeSelectedSheetFitWarnings } from './cut-sheet-fit-warning';

const selectedSheet = {
  sheetMaterialTypeId: 17,
  widthMm: 1000,
  heightMm: 600,
};

const item = (overrides: Partial<{
  orderDetailId: number;
  widthMm: number;
  heightMm: number;
  filmTexture: boolean | null;
}> = {}) => ({
  orderDetailId: 42,
  widthMm: 900,
  heightMm: 500,
  filmTexture: false,
  ...overrides,
});

const params = {
  ...DEFAULT_FREECUT_PARAMS,
  trim_mm: { left: 0, right: 0, top: 0, bottom: 0 },
};

describe('computeSelectedSheetFitWarnings', () => {
  it('returns no warnings without a selected per-job sheet override', () => {
    expect(computeSelectedSheetFitWarnings({
      selectedSheet: null,
      items: [item({ widthMm: 2000 })],
      params,
      grainRules: DEFAULT_GRAIN_RULES,
      nativePortrait: true,
    })).toEqual([]);
  });

  it('accepts a detail that fits in its current orientation', () => {
    expect(computeSelectedSheetFitWarnings({
      selectedSheet,
      items: [item()],
      params,
      grainRules: DEFAULT_GRAIN_RULES,
      nativePortrait: true,
    })).toEqual([]);
  });

  it('accepts a plain detail that fits after an allowed 90 degree turn', () => {
    expect(computeSelectedSheetFitWarnings({
      selectedSheet,
      items: [item({ widthMm: 500, heightMm: 900 })],
      params,
      grainRules: DEFAULT_GRAIN_RULES,
      nativePortrait: true,
    })).toEqual([]);
  });

  it('reports orientation when a textured detail fits only after a forbidden turn', () => {
    expect(computeSelectedSheetFitWarnings({
      selectedSheet,
      items: [item({ widthMm: 500, heightMm: 900, filmTexture: true })],
      params,
      grainRules: DEFAULT_GRAIN_RULES,
      nativePortrait: true,
    })).toEqual([
      expect.objectContaining({
        orderDetailId: 42,
        reason: 'orientation',
        rotationForbidden: true,
        usableWidthMm: 1000,
        usableHeightMm: 600,
      }),
    ]);
  });

  it('reports dimensions when the detail cannot fit in either orientation', () => {
    expect(computeSelectedSheetFitWarnings({
      selectedSheet,
      items: [item({ widthMm: 1100, heightMm: 700 })],
      params,
      grainRules: DEFAULT_GRAIN_RULES,
      nativePortrait: true,
    })).toEqual([
      expect.objectContaining({
        orderDetailId: 42,
        reason: 'dimensions',
        rotationForbidden: false,
      }),
    ]);
  });

  it('keeps warning identity stable across a mixed list of fitting and oversized details', () => {
    expect(computeSelectedSheetFitWarnings({
      selectedSheet,
      items: [
        item({ orderDetailId: 41 }),
        item({ orderDetailId: 73, widthMm: 1200, heightMm: 700 }),
      ],
      params,
      grainRules: DEFAULT_GRAIN_RULES,
      nativePortrait: true,
    })).toEqual([
      expect.objectContaining({ orderDetailId: 73, reason: 'dimensions' }),
    ]);
  });

  it('uses the usable sheet area after trim', () => {
    expect(computeSelectedSheetFitWarnings({
      selectedSheet,
      items: [item({ widthMm: 990, heightMm: 590 })],
      params: {
        ...params,
        trim_mm: { left: 10, right: 10, top: 10, bottom: 10 },
      },
      grainRules: DEFAULT_GRAIN_RULES,
      nativePortrait: true,
    })).toEqual([
      expect.objectContaining({
        reason: 'dimensions',
        usableWidthMm: 980,
        usableHeightMm: 580,
      }),
    ]);
  });

  it('matches vacuum auto: textured details may rotate', () => {
    expect(computeSelectedSheetFitWarnings({
      selectedSheet,
      items: [item({ widthMm: 500, heightMm: 900, filmTexture: true })],
      params: {
        ...params,
        layout_mode: 'vacuum_table',
        vacuum: { direction: 'optimal' },
      },
      grainRules: DEFAULT_GRAIN_RULES,
      nativePortrait: true,
    })).toEqual([]);
  });
});
