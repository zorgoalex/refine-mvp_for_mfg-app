import { describe, expect, it } from 'vitest';
import {
  buildCutPieceTooltipRows,
  buildSheetPieceOverlays,
  displayedSheetExtents,
  formatSheetSide,
  parseCutPieceDetailId,
  parseStoredPortrait,
  sheetOrientationKey,
} from './cutPreviewHelpers';
import type { CutJobItemDto, SheetPlacements } from '../../api/types/cutApi.types';

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

  describe('cut piece overlay helpers', () => {
    const placements: SheetPlacements = {
      trim_mm: { left: 10, top: 15, right: 10, bottom: 10 },
      sheet_width_mm: 2800,
      sheet_height_mm: 2070,
      pieces: [
        { item_id: 'det-42', instance: 1, x_mm: 0, y_mm: 0, width_mm: 600, height_mm: 400, rotated: false },
      ],
    };
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

    it('transposes overlay percentages for landscape preview', () => {
      const overlay = buildSheetPieceOverlays(placements, [item], true)[0];
      expect(overlay.leftPct).toBe(((2070 - (15 + 400)) / 2070) * 100);
      expect(overlay.topPct).toBe((10 / 2800) * 100);
      expect(overlay.widthPct).toBe((400 / 2070) * 100);
      expect(overlay.heightPct).toBe((600 / 2800) * 100);
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
  });
});
