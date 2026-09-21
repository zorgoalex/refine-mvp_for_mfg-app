import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import {
  CUT_RENDER_STYLE_VACUUM_TASK_PREVIEW,
  DEFAULT_CUT_RENDER_STYLES_SETTING,
  resolveCutRenderStyleFromSetting,
  resolveCutRenderStyle,
} from '../../../shared/cut-render-style';
import { buildSheetSvg, createOrderFillResolver } from './sheet-svg';
import { renderSheetPng } from './sheet-png';

const sheet = {
  sheet_width_mm: 2800, sheet_height_mm: 1050,
  trim_mm: { left: 0, right: 0, top: 0, bottom: 0 },
  pieces: [{ item_id: 'det-1', instance: 1, x_mm: 100, y_mm: 100, width_mm: 1900, height_mm: 500, rotated: false }],
};

describe('isolated vacuum task preview', () => {
  it('ignores saved backgrounds/palettes without mutating configured renderers', () => {
    const settings = structuredClone(DEFAULT_CUT_RENDER_STYLES_SETTING);
    settings.templates[0].profile.piece.defaultFill = '#eeeeee';
    settings.templates[0].profile.piece.orderPalette = ['#ff0000'];
    const before = JSON.stringify(settings);
    const style = resolveCutRenderStyleFromSetting(CUT_RENDER_STYLE_VACUUM_TASK_PREVIEW, settings);
    expect(style.piece.defaultFill).toBe('#ffffff');
    expect(createOrderFillResolver([10, 20], style)(10)).toBe('#123b70');
    expect(createOrderFillResolver([10, 20], style)(20)).toBe('#123b70');
    expect(resolveCutRenderStyleFromSetting('mdf_board_preview', settings).piece.defaultFill).toBe('#eeeeee');
    expect(resolveCutRenderStyle('default').piece.strokeWidthMm).toBe(2);
    expect(JSON.stringify(settings)).toBe(before);
  });

  it('keeps guide gutters opaque white', () => {
    const svg = buildSheetSvg({ sheet, labelFor: () => '', showLabels: false, showBathMeterGuides: true, renderStyle: CUT_RENDER_STYLE_VACUUM_TASK_PREVIEW });
    const png = PNG.sync.read(renderSheetPng({ svg, targetPx: 360, sheetWidthMm: 2800, sheetHeightMm: 1050 }));
    expect([...png.data.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
  });

  it.each([360, 1400])('renders white interiors and visible navy contours at %i pixels', (targetPx) => {
    const svg = buildSheetSvg({ sheet, labelFor: () => '', showLabels: false, renderStyle: CUT_RENDER_STYLE_VACUUM_TASK_PREVIEW });
    const png = PNG.sync.read(renderSheetPng({ svg, targetPx, sheetWidthMm: 2800, sheetHeightMm: 1050 }));
    const pixel = (x: number, y: number) => [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4)];
    expect(pixel(Math.round(1000 / 2800 * png.width), Math.round(300 / 1050 * png.height))).toEqual([255, 255, 255, 255]);
    expect(pixel(Math.round(2400 / 2800 * png.width), Math.round(800 / 1050 * png.height))).toEqual([255, 255, 255, 255]);
    const edgeX = Math.round(2000 / 2800 * png.width);
    const edgeY = Math.round(300 / 1050 * png.height);
    const edge = [-1, 0, 1].map((dx) => pixel(edgeX + dx, edgeY));
    expect(edge.some(([r, g, b, a]) => r < 90 && g < 120 && b > g && a === 255)).toBe(true);
  });
});
