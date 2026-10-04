import { describe, expect, it } from 'vitest';
import type { SheetPlacements } from '../../api/types/cutApi.types';
import { buildSheetMiniMap, sheetMiniColor } from './cutSheetMiniMap';

const placements = (width: number, height: number): SheetPlacements => ({
  trim_mm: { left: 10, right: 10, top: 20, bottom: 20 },
  sheet_width_mm: width,
  sheet_height_mm: height,
  pieces: [{ item_id: 'det-1', instance: 1, x_mm: 100, y_mm: 200, width_mm: 300, height_mm: 400, rotated: false }],
});

describe('cut sheet mini map', () => {
  it('keeps a landscape sheet as is, with the trim added', () => {
    expect(buildSheetMiniMap(placements(2800, 2070))).toEqual({
      widthMm: 2800,
      heightMm: 2070,
      rects: [{ x: 110, y: 220, w: 300, h: 400 }],
    });
  });

  it('lays a portrait sheet on its long side', () => {
    expect(buildSheetMiniMap(placements(2070, 2800))).toEqual({
      widthMm: 2800,
      heightMm: 2070,
      rects: [{ x: 220, y: 110, w: 400, h: 300 }],
    });
  });

  it('gives a name one stable colour', () => {
    expect(sheetMiniColor('Крем брюле')).toBe(sheetMiniColor(' крем БРЮЛЕ '));
    expect(sheetMiniColor(null)).toMatch(/^#[0-9a-f]{6}$/);
  });
});
