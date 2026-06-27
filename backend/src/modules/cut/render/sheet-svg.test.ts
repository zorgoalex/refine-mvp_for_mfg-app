import { describe, expect, it } from 'vitest';
import {
  buildSheetSvg,
  composePieceLabelLines,
  computeGroupItemQuantities,
  createOrderFillResolver,
  formatPieceLabel,
  orderFillColor,
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

describe('composePieceLabelLines (cut preview piece label)', () => {
  it('puts order, position, and size on the first three lines', () => {
    expect(
      composePieceLabelLines({
        orderId: 12,
        detailId: 45,
        detailNumber: 7,
        widthMm: 600,
        heightMm: 400,
        itemId: 'det-45',
        instance: 1,
        qty: 1,
      }),
    ).toEqual(['12', 'поз. 7', '600X400']);
  });

  it('adds instance count as its own line when qty > 1', () => {
    expect(
      composePieceLabelLines({
        orderId: 12,
        detailId: 45,
        detailNumber: 7,
        widthMm: 600,
        heightMm: 400,
        itemId: 'det-45',
        instance: 2,
        qty: 3,
      }),
    ).toEqual(['12', 'поз. 7 - 2/3', '600X400']);
  });

  it('falls back to a single line when the order is unknown', () => {
    expect(
      composePieceLabelLines({ orderId: null, detailId: null, itemId: 'weird', instance: 1, qty: 1 }),
    ).toEqual(['weird']);
  });
});

describe('buildSheetSvg multi-line labels', () => {
  it('renders each label line as its own <tspan> sharing the piece centre x', () => {
    const svg = buildSheetSvg({ sheet, labelFor: () => ['5', 'поз. 9', '600X400'] });
    // first piece centre: x=10+600/2=310, y=15+400/2=215
    expect(svg).toMatch(/<tspan x="310"[^>]*>5<\/tspan>/);
    expect(svg).toMatch(/<tspan x="310"[^>]*>поз\. 9<\/tspan>/);
    expect(svg).toMatch(/<tspan x="310"[^>]*>600X400<\/tspan>/);
  });

  it('still accepts a plain string label (single line)', () => {
    const svg = buildSheetSvg({ sheet, labelFor: () => 'X' });
    expect(svg).toContain('>X</tspan>');
  });

  it('uses deterministic per-order fills when provided', () => {
    const svg = buildSheetSvg({
      sheet,
      labelFor: () => 'X',
      fillFor: (piece) => (piece.instance === 1 ? orderFillColor(12) : orderFillColor(13)),
    });

    expect(svg).toContain(`fill="${orderFillColor(12)}"`);
    expect(svg).toContain(`fill="${orderFillColor(13)}"`);
    expect(orderFillColor(12)).not.toBe(orderFillColor(13));
    expect(orderFillColor(12)).toBe(orderFillColor(12));
  });

  it('assigns different colors to different orders even when ids share a modulo palette slot', () => {
    const fill = createOrderFillResolver([11372, 11292]);

    expect(fill(11372)).not.toBe(fill(11292));
    expect(fill(11372)).toBe(fill(11372));
  });

  it('keeps the legacy piece fill when no order color is resolved', () => {
    const svg = buildSheetSvg({ sheet, labelFor: () => 'X', fillFor: () => null });
    expect(svg).toContain('fill="#eef3f8"');
  });
});

describe('buildSheetSvg rotate90 (landscape, upright labels)', () => {
  it('swaps the viewBox and sheet rect to h×w', () => {
    const svg = buildSheetSvg({ sheet, labelFor: () => 'X', rotate90: true });
    expect(svg).toContain('viewBox="0 0 2070 2800"');
    expect(svg).toMatch(/<rect x="0" y="0" width="2070" height="2800"/);
  });

  it('transposes each piece rect 90° (x,y,w,h) -> (h-(y+ph), x, ph, pw)', () => {
    // piece 1 drawn at x=10,y=15,w=600,h=400 -> (2070-415, 10, 400, 600)
    const svg = buildSheetSvg({ sheet, labelFor: () => 'X', rotate90: true });
    expect(svg).toMatch(/<rect x="1655" y="10" width="400" height="600"/);
  });

  it('keeps labels upright: tspan x = transposed centre (h-cy), text y = cx', () => {
    // piece 1 centre (310,215) -> (2070-215, 310) = (1855, 310); text NOT rotated
    const svg = buildSheetSvg({ sheet, labelFor: () => 'X', rotate90: true });
    expect(svg).toMatch(/<tspan x="1855"[^>]*>X<\/tspan>/);
    expect(svg).toMatch(/<text x="1855" y="310"[^>]*>/);
    expect(svg).not.toMatch(/rotate\(/); // no rotation transform → text stays horizontal
  });

  it('renders unrotated identically when rotate90 is false/absent', () => {
    expect(buildSheetSvg({ sheet, labelFor: () => 'X', rotate90: false })).toBe(
      buildSheetSvg({ sheet, labelFor: () => 'X' }),
    );
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
