import { describe, expect, it } from 'vitest';
import {
  buildSheetSvg,
  computeGroupItemQuantities,
  formatPieceLabel,
} from './sheet-svg';
import type { BackMappedSheet, SheetPlacementsJson } from '../application/cut-freecut-mapping';

const sheet: SheetPlacementsJson = {
  trim_mm: { left: 10, top: 15, right: 10, bottom: 10 },
  sheet_width_mm: 2800,
  sheet_height_mm: 2070,
  pieces: [
    { item_id: 'det-999', instance: 1, x_mm: 0, y_mm: 0, width_mm: 600, height_mm: 400, rotated: false },
    { item_id: 'det-999', instance: 2, x_mm: 610, y_mm: 0, width_mm: 600, height_mm: 400, rotated: false },
  ],
};

describe('formatPieceLabel (§3 instance labels)', () => {
  it('appends instance N/qty only when qty > 1', () => {
    expect(formatPieceLabel('Заказ 5 / деталь 999', 2, 3)).toBe('Заказ 5 / деталь 999 2/3');
    expect(formatPieceLabel('Заказ 5 / деталь 999', 1, 1)).toBe('Заказ 5 / деталь 999');
  });
});

describe('computeGroupItemQuantities', () => {
  it('counts total placed instances per item across all sheets (qty=3 over 2 sheets)', () => {
    const sheets: BackMappedSheet[] = [
      { sheetIndex: 0, placements: sheet },
      {
        sheetIndex: 1,
        placements: {
          ...sheet,
          pieces: [
            { item_id: 'det-999', instance: 3, x_mm: 0, y_mm: 0, width_mm: 600, height_mm: 400, rotated: false },
          ],
        },
      },
    ];
    expect(computeGroupItemQuantities(sheets).get('det-999')).toBe(3);
  });
});

describe('buildSheetSvg (§7 trim offset + labels)', () => {
  it('uses a mm viewBox of the FULL sheet', () => {
    const svg = buildSheetSvg({ sheet, labelFor: () => 'X' });
    expect(svg).toContain('viewBox="0 0 2800 2070"');
    expect(svg).toMatch(/<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  });

  it('offsets every piece by trim_mm.{left,top} (MAJOR-8 non-zero trim)', () => {
    const svg = buildSheetSvg({ sheet, labelFor: () => 'X' });
    // first piece x_mm=0 -> rendered at trim.left=10; second x_mm=610 -> 620
    expect(svg).toMatch(/<rect[^>]*x="10"[^>]*y="15"/);
    expect(svg).toMatch(/<rect[^>]*x="620"[^>]*y="15"/);
  });

  it('renders the resolved label per piece', () => {
    const qty = computeGroupItemQuantities([{ sheetIndex: 0, placements: sheet }]);
    const svg = buildSheetSvg({
      sheet,
      labelFor: (piece) => formatPieceLabel('д999', piece.instance, qty.get(piece.item_id) ?? 1),
    });
    expect(svg).toContain('д999 1/2');
    expect(svg).toContain('д999 2/2');
  });

  it('has a white sheet background', () => {
    const svg = buildSheetSvg({ sheet, labelFor: () => 'X' });
    expect(svg).toMatch(/fill="#ffffff"|fill="white"/i);
  });
});
