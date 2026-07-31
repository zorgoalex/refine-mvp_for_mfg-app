import { describe, expect, it } from 'vitest';
import {
  addBathMeterGuidesToSvg,
  buildBathProfileSheetSvg,
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

  it('shows the order name on line 1 when provided, replacing the numeric id', () => {
    expect(
      composePieceLabelLines({
        orderId: 12,
        orderName: 'Кухня Иванов',
        detailId: 45,
        detailNumber: 7,
        widthMm: 600,
        heightMm: 400,
        itemId: 'det-45',
        instance: 1,
        qty: 1,
      }),
    ).toEqual(['Кухня Иванов', 'поз. 7', '600X400']);
  });

  it('falls back to the numeric order id when orderName is blank/absent', () => {
    const base = { orderId: 12, detailId: 45, detailNumber: 7, widthMm: 600, heightMm: 400, itemId: 'det-45', instance: 1, qty: 1 };
    expect(composePieceLabelLines({ ...base, orderName: '   ' })).toEqual(['12', 'поз. 7', '600X400']);
    expect(composePieceLabelLines({ ...base, orderName: null })).toEqual(['12', 'поз. 7', '600X400']);
    expect(composePieceLabelLines(base)).toEqual(['12', 'поз. 7', '600X400']);
  });

  it('falls back to a single line when the order is unknown', () => {
    expect(
      composePieceLabelLines({ orderId: null, detailId: null, itemId: 'weird', instance: 1, qty: 1 }),
    ).toEqual(['weird']);
  });

  it('appends a 4th material line when materialName is a non-blank string', () => {
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
        materialName: 'ЛДСП Белый',
      }),
    ).toEqual(['12', 'поз. 7', '600X400', 'ЛДСП Белый']);
  });

  it('omits the material line when materialName is null/blank', () => {
    const base = { orderId: 12, detailId: 45, detailNumber: 7, widthMm: 600, heightMm: 400, itemId: 'det-45', instance: 1, qty: 1 };
    expect(composePieceLabelLines({ ...base, materialName: null })).toEqual(['12', 'поз. 7', '600X400']);
    expect(composePieceLabelLines({ ...base, materialName: '  ' })).toEqual(['12', 'поз. 7', '600X400']);
  });

  it('does not add a material line to the unknown-order fallback', () => {
    expect(
      composePieceLabelLines({ orderId: null, detailId: null, itemId: 'weird', instance: 1, qty: 1, materialName: 'ЛДСП' }),
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

  it('adds piece metadata for interactive sheet previews', () => {
    const svg = buildSheetSvg({ sheet, labelFor: () => 'X' });

    expect(svg).toContain('class="cut-sheet-piece"');
    expect(svg).toContain('data-item-id="det-999"');
    expect(svg).toContain('data-detail-id="999"');
    expect(svg).toContain('data-piece-instance="1"');
    expect(svg).toContain('data-piece-cx="310"');
    expect(svg).toContain('data-piece-cy="215"');
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

describe('buildBathProfileSheetSvg (PDF-only labels)', () => {
  it('prints only edge and milling values bottom-right at half the dimension font size', () => {
    const svg = buildBathProfileSheetSvg({
      sheet,
      labelFor: () => ['11300', 'поз. 5', '600X400'],
      bathDetailInfoFor: () => ({ edgeTypeName: 'ПВХ 2мм', millingTypeName: 'Модерн' }),
    });

    const dimensionFont = /<text x="310" y="[^"]*"[^>]*font-size="([^"]+)"[^>]*>600<\/text>/.exec(svg)?.[1];
    const metadataFont = /class="cut-bath-detail-meta"[^>]*font-size="([^"]+)"/.exec(svg)?.[1];
    expect(dimensionFont).toBeTruthy();
    expect(metadataFont).toBeTruthy();
    expect(svg).toContain('class="cut-bath-detail-meta"');
    expect(svg).toContain('>ПВХ 2мм</tspan>');
    expect(svg).toContain('>Модерн</tspan>');
    expect(svg).not.toContain('Обкат:');
    expect(svg).not.toContain('Фрезеровка:');
    expect(Number(metadataFont)).toBeCloseTo(Number(dimensionFont) / 2, 5);
    expect(svg).toMatch(/text-anchor="end"[^>]*data-corner="bottom-right"/);
  });

  it('renders missing edge and milling values as dashes for every piece', () => {
    const svg = buildBathProfileSheetSvg({
      sheet,
      labelFor: () => ['11300', 'поз. 5', '600X400'],
      bathDetailInfoFor: () => ({ edgeTypeName: null, millingTypeName: null }),
    });

    expect(svg.match(/>—<\/tspan>/g)).toHaveLength(4);
    expect(svg).not.toContain('Обкат:');
    expect(svg).not.toContain('Фрезеровка:');
  });

  it('puts enlarged dimensions along sides and keeps only order/position in the centre', () => {
    const svg = buildBathProfileSheetSvg({ sheet, labelFor: () => ['11300', 'поз. 5', '600X400'] });

    expect(svg).toContain('data-detail-id="999"');
    expect(svg).toMatch(/fill="#7f1d1d"[^>]*font-weight="900"[^>]*>11300<\/text>/);
    expect(svg).toMatch(/font-size="[^"]+"[^>]*fill="#14532d"[^>]*>#<\/text>/);
    expect(svg).toMatch(/font-size="[^"]+"[^>]*fill="#14532d"[^>]*> 5<\/text>/);
    expect(svg).not.toContain('>поз. 5</text>');
    expect(svg).not.toContain('600X400');
    expect(svg).toMatch(/<text x="310" y="[^"]*"[^>]*font-size="84"[^>]*>600<\/text>/);
    expect(svg).toMatch(/transform="rotate\(-90 [^"]+\)"[^>]*font-size="84"[^>]*>400<\/text>/);
  });

  it('does not change the standard SVG renderer output', () => {
    const svg = buildSheetSvg({ sheet, labelFor: () => ['11300', 'поз. 5', '600X400'] });

    expect(svg).toContain('600X400');
    expect(svg).not.toContain('rotate(-90');
  });

  it('doubles bath PDF detail font when the piece has enough space', () => {
    const roomySheet: SheetPlacementsJson = {
      ...sheet,
      pieces: [{ item_id: 'det-1', instance: 1, x_mm: 0, y_mm: 0, width_mm: 1000, height_mm: 600, rotated: false }],
    };
    const svg = buildBathProfileSheetSvg({ sheet: roomySheet, labelFor: () => ['11300', 'поз. 5', '1000X600'] });

    expect(svg).toMatch(/font-size="98"[^>]*fill="#7f1d1d"[^>]*font-weight="900"[^>]*>11300<\/text>/);
    expect(svg).toMatch(/font-size="39.2"[^>]*fill="#14532d"[^>]*>#<\/text>/);
    expect(svg).toMatch(/font-size="78.4"[^>]*fill="#14532d"[^>]*> 5<\/text>/);
  });

  it('keeps a compact position label for short pieces that cannot hold full labels', () => {
    const shortSheet: SheetPlacementsJson = {
      ...sheet,
      pieces: [{ item_id: 'det-1', instance: 1, x_mm: 0, y_mm: 0, width_mm: 1000, height_mm: 80, rotated: false }],
    };
    const svg = buildBathProfileSheetSvg({ sheet: shortSheet, labelFor: () => ['11300', 'поз. 5', '1000X80'] });

    expect(svg).not.toContain('>11300</text>');
    expect(svg).not.toContain('>поз. 5</text>');
    expect(svg).toContain('>#</text>');
    expect(svg).toContain('> 5</text>');
    expect(svg).toMatch(/font-size="28"[^>]*>1000<\/text>/);
  });

  it('keeps the old small dimension font when either side is 150 mm or less', () => {
    const thresholdSheet: SheetPlacementsJson = {
      ...sheet,
      pieces: [{ item_id: 'det-1', instance: 1, x_mm: 0, y_mm: 0, width_mm: 1000, height_mm: 150, rotated: false }],
    };
    const svg = buildBathProfileSheetSvg({ sheet: thresholdSheet, labelFor: () => ['11300', 'поз. 5', '1000X150'] });

    expect(svg).toMatch(/font-size="42"[^>]*>1000<\/text>/);
    expect(svg).toMatch(/font-size="42"[^>]*>150<\/text>/);
  });

  it('styles bath PDF center detail labels by semantic part', () => {
    const svg = buildBathProfileSheetSvg({ sheet, labelFor: () => ['11300', 'поз. 5', '600X400'] });

    expect(svg).toContain('fill="#7f1d1d" font-weight="900"');
    expect(svg).toMatch(/fill="#7f1d1d" font-weight="900" stroke="#7f1d1d" stroke-width="[^"]+" paint-order="stroke"/);
    expect(svg).toContain('>11300</text>');
    expect(svg).toContain('fill="#14532d"');
    expect(svg).toContain('>#</text>');
    expect(svg).toContain('> 5</text>');
    expect(svg).not.toContain('>поз. 5</text>');
    expect(svg).not.toContain('<tspan fill="#7f1d1d"');
  });

  it('shrinks side dimensions and keeps compact position labels for narrow strip details', () => {
    const lowSheet: SheetPlacementsJson = {
      ...sheet,
      pieces: [{ item_id: 'det-1', instance: 1, x_mm: 0, y_mm: 0, width_mm: 2702, height_mm: 40, rotated: false }],
    };
    const svg = buildBathProfileSheetSvg({ sheet: lowSheet, labelFor: () => ['113001', 'поз. 33', '2702X40'] });

    expect(svg).not.toContain('>113001</text>');
    expect(svg).not.toContain('>поз. 33</text>');
    expect(svg).toContain('>#</text>');
    expect(svg).toContain('> 33</text>');
    const match = /font-size="([0-9.]+)"[^>]*>2702<\/text>/.exec(svg);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeLessThan(18);
  });

  it('moves bath center labels into the safe area below and right of side dimensions', () => {
    const svg = buildBathProfileSheetSvg({ sheet, labelFor: () => ['11300', 'поз. 5', '600X400'] });

    expect(svg).toMatch(/<text x="370.9" y="226.2"[^>]*>11300<\/text>/);
    expect(svg).not.toMatch(/<text x="310" y="215"[^>]*>11300<\/text>/);
  });
});

describe('vacuum bath meter guides', () => {
  const bathSheet: SheetPlacementsJson = {
    ...sheet,
    sheet_width_mm: 1400,
    sheet_height_mm: 2800,
  };

  it('renders two subtle dashed guides at portrait y=800/1800 in normal and bath-profile SVGs', () => {
    const normal = buildSheetSvg({
      sheet: bathSheet,
      labelFor: () => 'X',
      showBathMeterGuides: true,
    });
    const bath = buildBathProfileSheetSvg({
      sheet: bathSheet,
      labelFor: () => 'X',
      showBathMeterGuides: true,
    });

    for (const svg of [normal, bath]) {
      expect(svg.match(/class="cut-bath-meter-guide"/g)).toHaveLength(2);
      expect(svg.match(/class="cut-bath-meter-guide-label"/g)).toHaveLength(2);
      expect(svg).toContain('data-offset-mm="800" x1="0" y1="800" x2="1400" y2="800"');
      expect(svg).toContain('data-offset-mm="1800" x1="0" y1="1800" x2="1400" y2="1800"');
      expect(svg).toContain('stroke-dasharray="18 14"');
      expect(svg).toContain('stroke-opacity="0.28"');
      expect(svg).toContain('class="cut-bath-meter-guide-label" data-offset-mm="800" x="19.6" y="780.4" fill="#ff6a00"');
      expect(svg).toContain('font-size="28" font-weight="700"');
      expect(svg).toContain('>800мм</text>');
      expect(svg).toContain('>1800мм</text>');
    }
  });

  it('renders landscape guides at x=800/1800 from the displayed left edge', () => {
    const svg = buildSheetSvg({
      sheet: bathSheet,
      labelFor: () => 'X',
      rotate90: true,
      showBathMeterGuides: true,
    });

    expect(svg).toContain('data-offset-mm="800" x1="800" y1="0" x2="800" y2="1400"');
    expect(svg).toContain('data-offset-mm="1800" x1="1800" y1="0" x2="1800" y2="1400"');
    expect(svg).toContain('class="cut-bath-meter-guide-label" data-offset-mm="800" x="819.6" y="28" fill="#ff6a00"');
  });

  it('keeps ordinary sheet SVG byte-compatible when guides are disabled', () => {
    expect(buildSheetSvg({ sheet: bathSheet, labelFor: () => 'X', showBathMeterGuides: false }))
      .toBe(buildSheetSvg({ sheet: bathSheet, labelFor: () => 'X' }));
  });

  it('adds guides idempotently to frozen SVG views used by history and MDF bath cards', () => {
    const frozen = buildSheetSvg({ sheet: bathSheet, labelFor: () => 'X' });
    const once = addBathMeterGuidesToSvg(frozen, bathSheet, false);
    const twice = addBathMeterGuidesToSvg(once, bathSheet, false);

    expect(once.match(/class="cut-bath-meter-guide"/g)).toHaveLength(2);
    expect(once.match(/class="cut-bath-meter-guide-label"/g)).toHaveLength(2);
    expect(twice).toBe(once);
  });

  it('backfills labels without duplicating lines in SVGs rendered by the previous guide version', () => {
    const current = buildSheetSvg({
      sheet: bathSheet,
      labelFor: () => 'X',
      showBathMeterGuides: true,
    });
    const previousVersion = current.replace(/<text class="cut-bath-meter-guide-label"[^>]*>.*?<\/text>/g, '');
    const upgraded = addBathMeterGuidesToSvg(previousVersion, bathSheet, false);

    expect(previousVersion.match(/class="cut-bath-meter-guide"/g)).toHaveLength(2);
    expect(previousVersion).not.toContain('class="cut-bath-meter-guide-label"');
    expect(upgraded.match(/class="cut-bath-meter-guide"/g)).toHaveLength(2);
    expect(upgraded.match(/class="cut-bath-meter-guide-label"/g)).toHaveLength(2);
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

  it('originTopLeft=false (default) keeps the legacy 90° CW transpose-right layout', () => {
    expect(buildSheetSvg({ sheet, labelFor: () => 'X', rotate90: true, originTopLeft: false })).toBe(
      buildSheetSvg({ sheet, labelFor: () => 'X', rotate90: true }),
    );
  });
});

describe('buildSheetSvg rotate90 + originTopLeft (transpose, dense cluster top-left)', () => {
  it('ignores the legacy origin preference for explicitly native sheets', () => {
    const native = { ...sheet, coordinate_contract: 'native_portrait_v1' as const };
    expect(buildSheetSvg({ sheet: native, labelFor: () => 'X', rotate90: true, originTopLeft: true }))
      .toBe(buildSheetSvg({ sheet: native, labelFor: () => 'X', rotate90: true, originTopLeft: false }));
    expect(buildSheetSvg({ sheet, labelFor: () => 'X', rotate90: true, originTopLeft: true }))
      .not.toBe(buildSheetSvg({ sheet, labelFor: () => 'X', rotate90: true, originTopLeft: false }));
  });
  it('keeps the same h×w viewBox as the 90° CW path', () => {
    const svg = buildSheetSvg({ sheet, labelFor: () => 'X', rotate90: true, originTopLeft: true });
    expect(svg).toContain('viewBox="0 0 2070 2800"');
    expect(svg).toMatch(/<rect x="0" y="0" width="2070" height="2800"/);
  });

  it('transposes each piece rect (x,y,w,h) -> (trim.top+y, trim.left+x, h, w) — no right-edge mirror', () => {
    // piece 1 full rect x=10,y=15,w=600,h=400 -> transpose (15, 10, 400, 600).
    // Contrast with the 90° CW result x=1655 (right edge): transpose anchors top-left.
    const svg = buildSheetSvg({ sheet, labelFor: () => 'X', rotate90: true, originTopLeft: true });
    expect(svg).toMatch(/<rect x="15" y="10" width="400" height="600"/);
    expect(svg).not.toMatch(/<rect x="1655"/);
  });

  it('keeps labels upright at the transposed centre', () => {
    // piece 1 transposed rect (15,10,400,600) -> centre (215, 310)
    const svg = buildSheetSvg({ sheet, labelFor: () => 'X', rotate90: true, originTopLeft: true });
    expect(svg).toMatch(/<text x="215" y="310"[^>]*>/);
    expect(svg).not.toMatch(/rotate\(/);
  });
});

describe('bottom-left display axis', () => {
  it('keeps absent/top-left output byte-identical', () => {
    expect(buildSheetSvg({ sheet, labelFor: () => 'X', axisOrigin: 'top-left' }))
      .toBe(buildSheetSvg({ sheet, labelFor: () => 'X' }));
  });

  it('reflects Y after portrait orientation', () => {
    const svg = buildSheetSvg({ sheet, labelFor: () => 'X', axisOrigin: 'bottom-left' });
    expect(svg).toMatch(/<rect x="10" y="1655" width="600" height="400"/);
    expect(svg).toMatch(/<text x="310" y="1855"/);
  });

  it('rotates right when switching a bottom-left sheet to landscape', () => {
    const svg = buildSheetSvg({
      sheet, labelFor: () => 'X', rotate90: true, originTopLeft: false, axisOrigin: 'bottom-left',
    });
    // Portrait bottom-left piece starts at the lower-left. Clockwise rotation
    // places it at landscape upper-left: (x,y) = (15,10), not lower-right.
    expect(svg).toMatch(/<rect x="15" y="10" width="400" height="600"/);
  });

  it('uses the same reflected geometry in the bath PDF SVG', () => {
    const svg = buildBathProfileSheetSvg({ sheet, labelFor: () => ['1', 'поз. 1', '600X400'], axisOrigin: 'bottom-left' });
    expect(svg).toMatch(/<rect x="10" y="1655" width="600" height="400"/);
    expect(svg).toContain('>600</text>');
  });
});

describe('buildSheetSvg showLabels=false (on-screen PNG preview — no baked labels)', () => {
  it('omits all piece <text> elements when showLabels=false', () => {
    const svg = buildSheetSvg({ sheet, labelFor: () => ['11301', 'поз. 1', '2647X565'], showLabels: false });
    // No <text> elements for any piece label string
    expect(svg).not.toContain('<text');
    expect(svg).not.toContain('11301');
    expect(svg).not.toContain('поз. 1');
    expect(svg).not.toContain('2647X565');
  });

  it('still renders piece <rect> elements and the sheet outline when showLabels=false', () => {
    const svg = buildSheetSvg({ sheet, labelFor: () => ['11301', 'поз. 1', '2647X565'], showLabels: false });
    // Sheet outline rect
    expect(svg).toMatch(/<rect x="0" y="0" width="2800" height="2070"/);
    // Piece rects are present (trim offset: x=10, y=15)
    expect(svg).toMatch(/<rect[^>]*x="10"[^>]*y="15"/);
    expect(svg).toMatch(/<rect[^>]*x="620"[^>]*y="15"/);
  });

  it('renders labels when showLabels=true (default)', () => {
    const svg = buildSheetSvg({ sheet, labelFor: () => ['11301', 'поз. 1', '2647X565'] });
    expect(svg).toContain('<text');
    expect(svg).toContain('11301');
    expect(svg).toContain('поз. 1');
    expect(svg).toContain('2647X565');
  });

  it('showLabels=false is equivalent to showLabels=false with explicit false value', () => {
    const a = buildSheetSvg({ sheet, labelFor: () => 'X', showLabels: false });
    const b = buildSheetSvg({ sheet, labelFor: () => 'X', showLabels: false });
    expect(a).toBe(b);
    expect(a).not.toContain('<text');
    // Rects still present
    expect(a).toContain('<rect');
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
