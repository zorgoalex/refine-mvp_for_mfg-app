import { describe, expect, it } from 'vitest';
import {
  buildCutPieceTooltipRows,
  buildSheetPieceOverlays,
  displayedSheetExtents,
  formatSheetSide,
  parseCutPieceDetailId,
  parseStoredPortrait,
  parseStoredOriginTopLeft,
  parseStoredAxisOrigin,
  selectVariantSheets,
  sheetOrientationKey,
  sheetOriginKey,
  sheetAxisOriginKey,
} from './cutPreviewHelpers';
import type { CutGroupDto, CutJobItemDto, SheetPlacements } from '../../api/types/cutApi.types';

// ── Shared fixtures for selectVariantSheets ──────────────────────────────────
const makeSheet = (sheetIndex: number, pieceItemIds: string[]): { sheetIndex: number; placements: SheetPlacements } => ({
  sheetIndex,
  placements: {
    trim_mm: { left: 10, top: 10, right: 10, bottom: 10 },
    sheet_width_mm: 2800,
    sheet_height_mm: 2070,
    pieces: pieceItemIds.map((item_id) => ({
      item_id,
      instance: 1,
      x_mm: 0,
      y_mm: 0,
      width_mm: 600,
      height_mm: 400,
      rotated: false,
    })),
  },
});

/** Auto layout: piece det-1 on sheet 0, piece det-2 on sheet 1. */
const autoSheet0 = makeSheet(0, ['det-1']);
const autoSheet1 = makeSheet(1, ['det-2']);

/** Manual layout: piece det-1 moved to sheet 1, det-2 stayed on sheet 0 (different from auto). */
const manualSheet0 = makeSheet(0, ['det-2']);
const manualSheet1 = makeSheet(1, ['det-1']);

const baseGroup: CutGroupDto = {
  cutGroupId: 5,
  sheetMaterialTypeId: 9,
  filmId: null,
  status: 'ready',
  summary: null,
  sheets: [
    { cutGroupSheetId: 10, sheetIndex: 0, pngCacheKey: null, placements: autoSheet0.placements },
    { cutGroupSheetId: 11, sheetIndex: 1, pngCacheKey: null, placements: autoSheet1.placements },
  ],
};

describe('cutPreviewHelpers', () => {
  describe('formatSheetSide', () => {
    it('rounds and suffixes мм', () => {
      expect(formatSheetSide(2799.6)).toBe('2800 мм');
      expect(formatSheetSide(1050)).toBe('1050 мм');
    });
  });

  describe('displayedSheetExtents', () => {
    it('keeps extents in portrait', () => {
      expect(displayedSheetExtents(2800, 2070, false)).toEqual({ horizontalMm: 2800, verticalMm: 2070 });
    });
    it('swaps extents in landscape (height becomes horizontal)', () => {
      expect(displayedSheetExtents(1050, 2080, true)).toEqual({ horizontalMm: 2080, verticalMm: 1050 });
    });
  });

  describe('sheetOrientationKey', () => {
    it('is namespaced per user and job', () => {
      expect(sheetOrientationKey('78', 175)).toBe('cut:sheet-orientation:78:175');
    });
  });

  describe('parseStoredPortrait', () => {
    it('defaults to portrait for absent/unknown values', () => {
      expect(parseStoredPortrait(null)).toBe(true);
      expect(parseStoredPortrait('portrait')).toBe(true);
      expect(parseStoredPortrait('garbage')).toBe(true);
    });
    it('returns false only for the explicit landscape value', () => {
      expect(parseStoredPortrait('landscape')).toBe(false);
    });
  });

  describe('sheetOriginKey', () => {
    it('namespaces the origin pref per user + job (distinct from orientation key)', () => {
      expect(sheetOriginKey('78', 175)).toBe('cut:sheet-origin-tl:78:175');
      expect(sheetOriginKey('78', 175)).not.toBe(sheetOrientationKey('78', 175));
    });
  });

  describe('parseStoredOriginTopLeft', () => {
    it('defaults to top-left (true) for absent/unknown', () => {
      expect(parseStoredOriginTopLeft(null)).toBe(true);
      expect(parseStoredOriginTopLeft('tl')).toBe(true);
      expect(parseStoredOriginTopLeft('garbage')).toBe(true);
    });
    it('returns false only for the explicit raw value', () => {
      expect(parseStoredOriginTopLeft('raw')).toBe(false);
    });
  });

  describe('axis-origin preference migration', () => {
    it('uses bottom-left for new/unknown preferences', () => {
      expect(parseStoredAxisOrigin(null)).toBe('bottom-left');
      expect(parseStoredAxisOrigin('bottom-left')).toBe('bottom-left');
      expect(parseStoredAxisOrigin('garbage')).toBe('bottom-left');
    });

    it('migrates both legacy TL/RAW choices to the former top-left display axis', () => {
      expect(parseStoredAxisOrigin('tl')).toBe('top-left');
      expect(parseStoredAxisOrigin('raw')).toBe('top-left');
      expect(parseStoredAxisOrigin('top-left')).toBe('top-left');
    });

    it('uses a distinct per-user per-job key', () => {
      expect(sheetAxisOriginKey('78', 175)).toBe('cut:sheet-axis-origin:78:175');
      expect(sheetAxisOriginKey('78', 175)).not.toBe(sheetOriginKey('78', 175));
    });
  });

  describe('cut piece overlay helpers', () => {
    const placements: SheetPlacements = {
      trim_mm: { left: 10, top: 15, right: 10, bottom: 10 },
      sheet_width_mm: 2800,
      sheet_height_mm: 2070,
      pieces: [
        { item_id: 'det-42', instance: 1, x_mm: 0, y_mm: 0, width_mm: 600, height_mm: 400, rotated: false },
      ],
    };

    it('uses frozen original dimensions in native portrait labels', () => {
      const native = {
        ...placements,
        coordinate_contract: 'native_portrait_v1' as const,
        pieces: [{ ...placements.pieces[0], width_mm: 400, height_mm: 600, label: { orderId: 777, detailNumber: 3, widthMm: 600, heightMm: 400 } }],
      };
      const overlay = buildSheetPieceOverlays(native, [item], false)[0];
      expect(overlay.labelLines).toContain('600*400');
    });
    const item: CutJobItemDto = {
      cutJobItemId: 1,
      orderDetailId: 42,
      orderId: 777,
      qty: 2,
      cutGroupId: 5,
      detail: {
        detailFields: { detail_id: 42, order_id: 777, detail_name: 'Боковина', width: 600, height: 400, note: null },
        detailNumber: 3,
        detailName: 'Боковина',
        height: 400,
        width: 600,
        quantity: 2,
        area: 0.24,
        materialId: null,
        sheetMaterialTypeId: 9,
        materialName: 'МДФ 16',
        millingTypeId: null,
        millingTypeName: 'Паз',
        edgeTypeId: null,
        edgeTypeName: 'ПВХ',
        filmId: null,
        filmName: 'Белая матовая',
        priority: null,
        productionStatusId: 1,
        productionStatusName: 'Готово',
        jointOrderId: null,
        note: null,
        linkCuttingFile: null,
        linkCuttingImageFile: null,
        linkCadFile: null,
        linkPdfFile: null,
      },
    };

    it('parses freecut detail ids', () => {
      expect(parseCutPieceDetailId('det-42')).toBe(42);
      expect(parseCutPieceDetailId('bad')).toBeNull();
    });

    it('builds portrait overlay percentages from stored placements', () => {
      const overlays = buildSheetPieceOverlays(placements, [item], false);
      expect(overlays).toHaveLength(1);
      expect(overlays[0]).toMatchObject({
        key: 'det-42:1',
        orderId: 777,
        orderDetailId: 42,
        detailNumber: 3,
        leftPct: (10 / 2800) * 100,
        topPct: (15 / 2070) * 100,
        widthPct: (600 / 2800) * 100,
        heightPct: (400 / 2070) * 100,
      });
    });

    it('reflects portrait overlay vertically for a bottom-left axis', () => {
      const overlay = buildSheetPieceOverlays(placements, [item], false, true, 'bottom-left')[0];
      expect(overlay.leftPct).toBe((10 / 2800) * 100);
      expect(overlay.topPct).toBe(((2070 - 15 - 400) / 2070) * 100);
      expect(overlay.heightPct).toBe((400 / 2070) * 100);
    });

    it('single-material sheet: no 4th material line (3 label lines)', () => {
      const overlay = buildSheetPieceOverlays(placements, [item], false)[0];
      expect(overlay.labelLines).toHaveLength(3);
    });

    it('mixed-material sheet: appends the material as a 4th label line per piece', () => {
      const mixedPlacements: SheetPlacements = {
        ...placements,
        pieces: [
          ...placements.pieces,
          { item_id: 'det-43', instance: 1, x_mm: 700, y_mm: 0, width_mm: 300, height_mm: 300, rotated: false },
        ],
      };
      const item2: CutJobItemDto = {
        ...item,
        cutJobItemId: 2,
        orderDetailId: 43,
        detail: { ...item.detail!, materialName: 'ЛДСП Белый', sheetMaterialTypeId: 7 },
      };
      const overlays = buildSheetPieceOverlays(mixedPlacements, [item, item2], false);
      const byKey = Object.fromEntries(overlays.map((o) => [o.key, o]));
      expect(byKey['det-42:1'].labelLines).toHaveLength(4);
      expect(byKey['det-42:1'].labelLines[3]).toBe('МДФ 16');
      expect(byKey['det-43:1'].labelLines[3]).toBe('ЛДСП Белый');
    });

    it('mixed detection keys on material id: same name, different sheetMaterialTypeId still mixed', () => {
      const mixedPlacements: SheetPlacements = {
        ...placements,
        pieces: [
          ...placements.pieces,
          { item_id: 'det-44', instance: 1, x_mm: 700, y_mm: 0, width_mm: 300, height_mm: 300, rotated: false },
        ],
      };
      // Same display name as `item` ('МДФ 16') but a DIFFERENT sheet-material-type id.
      const item2: CutJobItemDto = {
        ...item,
        cutJobItemId: 3,
        orderDetailId: 44,
        detail: { ...item.detail!, materialName: 'МДФ 16', sheetMaterialTypeId: 12 },
      };
      const overlays = buildSheetPieceOverlays(mixedPlacements, [item, item2], false);
      // Both get a 4th line because the sheet physically mixes two materials.
      expect(overlays.every((o) => o.labelLines.length === 4)).toBe(true);
    });

    it('transposes overlay percentages for landscape preview (legacy 90° CW, origin top-right)', () => {
      const overlay = buildSheetPieceOverlays(placements, [item], true)[0];
      expect(overlay.leftPct).toBe(((2070 - (15 + 400)) / 2070) * 100);
      expect(overlay.topPct).toBe((10 / 2800) * 100);
      expect(overlay.widthPct).toBe((400 / 2070) * 100);
      expect(overlay.heightPct).toBe((600 / 2800) * 100);
    });

    it('anchors overlay at the top-left under originTopLeft (transpose, no right-edge mirror)', () => {
      const overlay = buildSheetPieceOverlays(placements, [item], true, true)[0];
      // transpose: left = (trim.top + y_mm)/sheetH, top = (trim.left + x_mm)/sheetW
      expect(overlay.leftPct).toBe((15 / 2070) * 100);
      expect(overlay.topPct).toBe((10 / 2800) * 100);
      expect(overlay.widthPct).toBe((400 / 2070) * 100);
      expect(overlay.heightPct).toBe((600 / 2800) * 100);
      // distinct from the legacy 90° CW left edge
      expect(overlay.leftPct).not.toBe(((2070 - (15 + 400)) / 2070) * 100);
    });

    it('rotates the bottom-left preview clockwise into landscape', () => {
      const overlay = buildSheetPieceOverlays(placements, [item], true, false, 'bottom-left')[0];
      expect(overlay.leftPct).toBe((15 / 2070) * 100);
      expect(overlay.topPct).toBe((10 / 2800) * 100);
    });

    it('builds tooltip rows like the order detail table with resolved names, not bare ids', () => {
      const rows = buildCutPieceTooltipRows(item, placements.pieces[0]);
      expect(rows).toContainEqual({ label: 'Заказ', value: '777' });
      expect(rows).toContainEqual({ label: 'Позиция', value: '3' });
      expect(rows).toContainEqual({ label: 'Высота', value: '400' });
      expect(rows).toContainEqual({ label: 'Ширина', value: '600' });
      expect(rows).toContainEqual({ label: 'Количество', value: '2' });
      expect(rows).toContainEqual({ label: 'Площадь', value: '0.24' });
      expect(rows).toContainEqual({ label: 'Фрезеровка', value: 'Паз' });
      expect(rows).toContainEqual({ label: 'Обкат', value: 'ПВХ' });
      expect(rows).toContainEqual({ label: 'Материал', value: 'МДФ 16' });
      expect(rows).toContainEqual({ label: 'Статус', value: 'Готово' });
      expect(rows).toContainEqual({ label: 'Примечание', value: '—' });
      expect(rows).toContainEqual({ label: 'Плёнка', value: 'Белая матовая' });
      expect(rows.some((row) => row.label.endsWith('ID') || row.label.includes('ID '))).toBe(false);
      expect(rows.some((row) => row.label === 'detail_name' || row.label === 'note' || row.label === 'film_id')).toBe(false);
    });

    it('marks deleted order references in sheet tooltip rows', () => {
      const rows = buildCutPieceTooltipRows({ ...item, orderDeleted: true }, placements.pieces[0]);
      expect(rows).toContainEqual({ label: 'Статус заказа', value: 'удалён' });
    });
  });

  describe('selectVariantSheets', () => {
    it('(a) variant "auto" always returns auto sheets regardless of manualLayout', () => {
      const group: CutGroupDto = {
        ...baseGroup,
        manualLayout: {
          groupKey: 'k1',
          sheets: [manualSheet0, manualSheet1],
          isActive: true,
          isStale: false,
          version: 1,
        },
      };
      const result = selectVariantSheets(group, 'auto');
      // Must return auto distribution: sheet 0 has det-1, sheet 1 has det-2.
      expect(result).toHaveLength(2);
      expect(result[0].sheetIndex).toBe(0);
      expect(result[0].placements.pieces.map((p) => p.item_id)).toEqual(['det-1']);
      expect(result[1].sheetIndex).toBe(1);
      expect(result[1].placements.pieces.map((p) => p.item_id)).toEqual(['det-2']);
    });

    it('(b) variant "manual" with non-stale manualLayout returns manual sheets (moved pieces differ from auto)', () => {
      const group: CutGroupDto = {
        ...baseGroup,
        manualLayout: {
          groupKey: 'k1',
          sheets: [manualSheet0, manualSheet1],
          isActive: true,
          isStale: false,
          version: 1,
        },
      };
      const result = selectVariantSheets(group, 'manual');
      // Manual distribution: sheet 0 has det-2, sheet 1 has det-1.
      expect(result).toHaveLength(2);
      expect(result[0].sheetIndex).toBe(0);
      expect(result[0].placements.pieces.map((p) => p.item_id)).toEqual(['det-2']);
      expect(result[1].sheetIndex).toBe(1);
      expect(result[1].placements.pieces.map((p) => p.item_id)).toEqual(['det-1']);
      // Counts per sheet differ from auto (1 piece each, but different pieces).
      expect(result[0].placements.pieces.length).toBe(1);
      expect(result[1].placements.pieces.length).toBe(1);
    });

    it('(c) variant "manual" but manualLayout.isStale=true falls back to auto', () => {
      const group: CutGroupDto = {
        ...baseGroup,
        manualLayout: {
          groupKey: 'k1',
          sheets: [manualSheet0, manualSheet1],
          isActive: true,
          isStale: true, // stale → must not use manual sheets
          version: 1,
        },
      };
      const result = selectVariantSheets(group, 'manual');
      // Falls back to auto: sheet 0 has det-1.
      expect(result[0].placements.pieces.map((p) => p.item_id)).toEqual(['det-1']);
    });

    it('(d) variant "manual" but manualLayout absent falls back to auto', () => {
      const group: CutGroupDto = { ...baseGroup, manualLayout: undefined };
      const result = selectVariantSheets(group, 'manual');
      expect(result[0].placements.pieces.map((p) => p.item_id)).toEqual(['det-1']);
    });

    it('variant "active" with non-stale manualLayout returns manual sheets (same as "manual")', () => {
      const group: CutGroupDto = {
        ...baseGroup,
        manualLayout: {
          groupKey: 'k1',
          sheets: [manualSheet0, manualSheet1],
          isActive: true,
          isStale: false,
          version: 1,
        },
      };
      const result = selectVariantSheets(group, 'active');
      expect(result[0].placements.pieces.map((p) => p.item_id)).toEqual(['det-2']);
    });
  });
});
