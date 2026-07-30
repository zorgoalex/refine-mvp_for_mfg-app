/**
 * Unit tests for shared/cut-geometry — run by the backend Vitest project.
 * Imports directly from the shared module (no re-export indirection).
 * Pure; no DOM, no NestJS, no React.
 */
import { describe, it, expect } from 'vitest';
import {
  BATH_FILM_USAGE_ZONES,
  BATH_METER_GUIDE_OFFSETS_MM,
  BATH_METER_GUIDE_STYLE,
  bathMeterGuideLabel,
  bathMeterGuideLabelFontMm,
  bathMeterGuideLines,
  calculateBathSheetFilmUsage,
  usableExtent,
  piecesClear,
  pieceWithinUsable,
  validateSheetPlacements,
  orientPieceRect,
  applyAxisOrigin,
  shouldShowBathMeterGuides,
  undoAxisOriginY,
  rotatePiece,
  snapDraggedPiece,
  moveAllowed,
  validateSheetGroupInvariant,
} from './index';

describe('bath meter guides', () => {
  it('enables guides only for a vacuum-table Ванна material with catalog long side 2800 mm', () => {
    expect(shouldShowBathMeterGuides({
      engineUsed: 'vacuum_table',
      materialName: 'Ванна 1400',
      materialHeightMm: 2800,
    })).toBe(true);
    expect(shouldShowBathMeterGuides({
      layoutMode: 'vacuum_table',
      materialName: '  ванна 2100',
      materialHeightMm: 2800,
    })).toBe(true);
    expect(shouldShowBathMeterGuides({
      engineUsed: 'vacuum_table',
      materialName: 'Ванна 2080x1050',
      materialWidthMm: 2800,
      materialHeightMm: 1050,
    })).toBe(true);

    expect(shouldShowBathMeterGuides({
      engineUsed: 'ga',
      materialName: 'Ванна 1400',
      materialHeightMm: 2800,
    })).toBe(false);
    expect(shouldShowBathMeterGuides({
      engineUsed: 'vacuum_table',
      materialName: 'МДФ 16 мм',
      materialHeightMm: 2800,
    })).toBe(false);
    expect(shouldShowBathMeterGuides({
      engineUsed: 'vacuum_table',
      materialName: 'Ванна 1400',
      materialHeightMm: 2799,
    })).toBe(false);
    expect(shouldShowBathMeterGuides({
      engineUsed: 'vacuum_table',
      materialName: 'Ванна 1400',
      materialHeightMm: Symbol('invalid'),
    })).toBe(false);
  });

  it('places portrait guides across the width at 800 and 1800 mm from the top edge', () => {
    expect(bathMeterGuideLines(1400, 2800, false)).toEqual([
      { offsetMm: 800, x1: 0, y1: 800, x2: 1400, y2: 800 },
      { offsetMm: 1800, x1: 0, y1: 1800, x2: 1400, y2: 1800 },
    ]);
  });

  it('places landscape guides across the short side at 800 and 1800 mm from the left edge', () => {
    expect(bathMeterGuideLines(1400, 2800, true)).toEqual([
      { offsetMm: 800, x1: 800, y1: 0, x2: 800, y2: 1400 },
      { offsetMm: 1800, x1: 1800, y1: 0, x2: 1800, y2: 1400 },
    ]);
    expect(BATH_METER_GUIDE_OFFSETS_MM).toEqual([800, 1800]);
  });

  it('keeps guides on the displayed long side when the native long side is width', () => {
    expect(bathMeterGuideLines(2800, 1050, false)).toEqual([
      { offsetMm: 800, x1: 800, y1: 0, x2: 800, y2: 1050 },
      { offsetMm: 1800, x1: 1800, y1: 0, x2: 1800, y2: 1050 },
    ]);
    expect(bathMeterGuideLines(2800, 1050, true)).toEqual([
      { offsetMm: 800, x1: 0, y1: 800, x2: 1050, y2: 800 },
      { offsetMm: 1800, x1: 0, y1: 1800, x2: 1050, y2: 1800 },
    ]);
  });

  it('labels each guide in bright orange at the bath dimension font size', () => {
    const fontSizeMm = bathMeterGuideLabelFontMm(1400, 2800);
    const [portraitLine] = bathMeterGuideLines(1400, 2800, false);
    const [landscapeLine] = bathMeterGuideLines(1400, 2800, true);

    expect(fontSizeMm).toBe(28);
    expect(BATH_METER_GUIDE_STYLE.labelFill).toBe('#ff6a00');
    expect(BATH_METER_GUIDE_STYLE.labelFontRatio).toBe(1);
    const portraitLabel = bathMeterGuideLabel(portraitLine, fontSizeMm);
    const landscapeLabel = bathMeterGuideLabel(landscapeLine, fontSizeMm);
    expect(portraitLabel.text).toBe('800мм');
    expect(portraitLabel.x).toBeCloseTo(19.6);
    expect(portraitLabel.y).toBeCloseTo(780.4);
    expect(landscapeLabel.text).toBe('800мм');
    expect(landscapeLabel.x).toBeCloseTo(819.6);
    expect(landscapeLabel.y).toBe(28);
  });
});

describe('bath film usage', () => {
  const base = {
    sheet_width_mm: 1050,
    sheet_height_mm: 2800,
    trim_mm: { left: 0, right: 0, top: 0, bottom: 0 },
  };

  it('uses the zone that contains the farthest occupied point on the long side', () => {
    expect(calculateBathSheetFilmUsage({
      ...base,
      pieces: [{ item_id: 'det-1', instance: 1, x_mm: 0, y_mm: 0, width_mm: 100, height_mm: 800, rotated: false }],
    })?.linearMeters).toBe(1.1);
    expect(calculateBathSheetFilmUsage({
      ...base,
      pieces: [{ item_id: 'det-1', instance: 1, x_mm: 0, y_mm: 750, width_mm: 100, height_mm: 51, rotated: false }],
    })?.linearMeters).toBe(2.1);
    expect(calculateBathSheetFilmUsage({
      ...base,
      pieces: [{ item_id: 'det-1', instance: 1, x_mm: 0, y_mm: 1799, width_mm: 100, height_mm: 2, rotated: false }],
    })?.linearMeters).toBe(3.1);
  });

  it('measures along width when the bath long side is native X', () => {
    expect(calculateBathSheetFilmUsage({
      sheet_width_mm: 2800,
      sheet_height_mm: 1050,
      trim_mm: { left: 10, right: 0, top: 0, bottom: 0 },
      pieces: [{ item_id: 'det-1', instance: 1, x_mm: 1700, y_mm: 0, width_mm: 80, height_mm: 100, rotated: false }],
    })).toEqual({
      linearMeters: 2.1,
      occupiedToMm: 1790,
      zoneToMm: 1800,
      longSideAxis: 'x',
    });
  });

  it('returns null for empty or non-2800 sheets', () => {
    expect(calculateBathSheetFilmUsage({ ...base, pieces: [] })).toBeNull();
    expect(calculateBathSheetFilmUsage({
      sheet_width_mm: 1050,
      sheet_height_mm: 2600,
      trim_mm: base.trim_mm,
      pieces: [{ item_id: 'det-1', instance: 1, x_mm: 0, y_mm: 0, width_mm: 100, height_mm: 100, rotated: false }],
    })).toBeNull();
    expect(BATH_FILM_USAGE_ZONES.map((zone) => zone.linearMeters)).toEqual([1.1, 2.1, 3.1]);
  });
});

describe('display axis origin', () => {
  it.each([
    ['portrait', false, false],
    ['landscape legacy CW', true, false],
    ['landscape transpose', true, true],
  ] as const)('%s reflects after orientation and is self-inverse', (_name, landscape, originTopLeft) => {
    const oriented = orientPieceRect({ x: 17, y: 31, w: 140, h: 90 }, 1000, 800, landscape, originTopLeft);
    const bottom = applyAxisOrigin(oriented, 'bottom-left', landscape);
    expect(bottom.x).toBe(landscape ? oriented.vw - oriented.x - oriented.w : oriented.x);
    expect(bottom.w).toBe(oriented.w);
    expect(bottom.h).toBe(oriented.h);
    expect(bottom.y).toBe(landscape ? oriented.y : oriented.vh - oriented.y - oriented.h);
    expect(undoAxisOriginY(bottom.y, bottom.h, bottom.vh, 'bottom-left', landscape)).toBe(oriented.y);
  });

  it('keeps top-left byte-compatible and does not mutate the input', () => {
    const rect = orientPieceRect({ x: 10, y: 20, w: 30, h: 40 }, 300, 200, false);
    expect(applyAxisOrigin(rect, 'top-left')).toBe(rect);
    expect(rect.y).toBe(20);
  });
});

describe('validateSheetGroupInvariant', () => {
  const placements = { sheet_width_mm: 2070, sheet_height_mm: 2800, coordinate_contract: 'native_portrait_v1' as const };
  it('accepts homogeneous groups', () => {
    expect(validateSheetGroupInvariant([{ placements }, { placements: { ...placements } }])).toBeNull();
  });
  it('rejects mixed dimensions and contracts', () => {
    expect(validateSheetGroupInvariant([{ placements }, { placements: { ...placements, sheet_width_mm: 2000 } }])).toBe('mixed_dimensions');
    expect(validateSheetGroupInvariant([{ placements }, { placements: { ...placements, coordinate_contract: undefined } }])).toBe('mixed_coordinate_contract');
  });
});

const sheet = {
  sheet_width_mm: 2800,
  sheet_height_mm: 2070,
  trim_mm: { left: 10, right: 10, top: 10, bottom: 10 },
};

describe('usableExtent', () => {
  it('subtracts all four trim margins', () => {
    expect(usableExtent(sheet)).toEqual({ usableW: 2780, usableH: 2050 });
  });

  it('handles asymmetric trim', () => {
    const asymmetric = {
      sheet_width_mm: 1000,
      sheet_height_mm: 800,
      trim_mm: { left: 5, right: 15, top: 20, bottom: 10 },
    };
    expect(usableExtent(asymmetric)).toEqual({ usableW: 980, usableH: 770 });
  });
});

describe('piecesClear', () => {
  const a = { x: 0, y: 0, w: 100, h: 100 };

  it('clear: pieces separated on x axis by exactly gapMm', () => {
    expect(piecesClear(a, { x: 103, y: 0, w: 100, h: 100 }, 3)).toBe(true);
  });
  it('not clear: x gap one mm below required', () => {
    expect(piecesClear(a, { x: 102, y: 0, w: 100, h: 100 }, 3)).toBe(false);
  });
  it('not clear: overlapping on both axes', () => {
    expect(piecesClear(a, { x: 50, y: 50, w: 100, h: 100 }, 3)).toBe(false);
  });
  it('clear: pieces separated on y axis even though x overlaps', () => {
    // x overlaps: a=[0,100] b=[50,150] — gapX=-50 < 3
    // y clear: a=[0,100] b=[110,210] — gapY=10 >= 3 → true
    expect(piecesClear(a, { x: 50, y: 110, w: 100, h: 100 }, 3)).toBe(true);
  });
  it('clear: purely diagonal pieces whose corner distance >= gap', () => {
    // Neither axis is separated by the full gap (gapX=gapY=8 < 10), but the
    // true corner-to-corner clearance is sqrt(8^2+8^2)=11.31 >= 10, so the
    // pieces do not actually collide and there is room for the tool. A
    // one-axis check would wrongly flag this as an overlap.
    expect(piecesClear(a, { x: 108, y: 108, w: 100, h: 100 }, 10)).toBe(true);
  });
  it('not clear: diagonal pieces whose corner distance is below gap', () => {
    // gapX=gapY=5 → corner distance sqrt(50)=7.07 < 10 → genuine sub-kerf.
    expect(piecesClear(a, { x: 105, y: 105, w: 100, h: 100 }, 10)).toBe(false);
  });
});

describe('pieceWithinUsable', () => {
  it('true for piece exactly filling usable area', () => {
    expect(pieceWithinUsable({ x: 0, y: 0, w: 2780, h: 2050 }, 2780, 2050)).toBe(true);
  });
  it('false when right edge exceeds usable width', () => {
    expect(pieceWithinUsable({ x: 2700, y: 0, w: 100, h: 100 }, 2780, 2050)).toBe(false);
  });
  it('false when top-left corner is negative', () => {
    expect(pieceWithinUsable({ x: -1, y: 0, w: 100, h: 100 }, 2780, 2050)).toBe(false);
  });
});

describe('validateSheetPlacements', () => {
  const base = {
    ...sheet,
    pieces: [
      { item_id: 'det-1', instance: 1, x_mm: 0, y_mm: 0, width_mm: 600, height_mm: 400, rotated: false },
      { item_id: 'det-2', instance: 1, x_mm: 603, y_mm: 0, width_mm: 600, height_mm: 400, rotated: false },
    ],
  };

  it('returns no violations for a legal layout', () => {
    expect(validateSheetPlacements({ sheetIndex: 0, placements: base, gap: { kerfMm: 2, spacingMm: 1 }, filmTextureByItemId: new Map() })).toEqual([]);
  });

  it('can stop after the first violation for bounded legacy read checks', () => {
    const repeated = Array.from({ length: 100 }, (_, instance) => ({
      item_id: 'det-1', instance: instance + 1, x_mm: 0, y_mm: 0,
      width_mm: 100, height_mm: 100, rotated: false,
    }));
    const violations = validateSheetPlacements({
      sheetIndex: 0,
      placements: { ...sheet, pieces: repeated },
      gap: { kerfMm: 6.5, spacingMm: 0 },
      filmTextureByItemId: new Map(),
      stopAfterFirst: true,
    });
    expect(violations).toHaveLength(1);
  });

  it('handles a maximum-size valid row through the X sweep', () => {
    const pieces = Array.from({ length: 5000 }, (_, instance) => ({
      item_id: 'det-1', instance: instance + 1, x_mm: instance * 11, y_mm: 0,
      width_mm: 10, height_mm: 10, rotated: false,
    }));
    expect(validateSheetPlacements({
      sheetIndex: 0,
      placements: {
        trim_mm: { left: 0, right: 0, top: 0, bottom: 0 },
        sheet_width_mm: 55_000,
        sheet_height_mm: 10,
        pieces,
      },
      gap: { kerfMm: 1, spacingMm: 0 },
      filmTextureByItemId: new Map(),
      stopAfterFirst: true,
    })).toEqual([]);
  });

  it('handles a maximum-size valid column through the adaptive Y sweep', () => {
    const pieces = Array.from({ length: 5000 }, (_, instance) => ({
      item_id: 'det-1', instance: instance + 1, x_mm: 0, y_mm: instance * 11,
      width_mm: 10, height_mm: 10, rotated: false,
    }));
    expect(validateSheetPlacements({
      sheetIndex: 0,
      placements: {
        trim_mm: { left: 0, right: 0, top: 0, bottom: 0 },
        sheet_width_mm: 10,
        sheet_height_mm: 55_000,
        pieces,
      },
      gap: { kerfMm: 1, spacingMm: 0 },
      filmTextureByItemId: new Map(),
      stopAfterFirst: true,
    })).toEqual([]);
  });

  it('returns overlap violation when gap is insufficient', () => {
    const tight = { ...base, pieces: [base.pieces[0], { ...base.pieces[1], x_mm: 601 }] };
    const codes = validateSheetPlacements({ sheetIndex: 0, placements: tight, gap: { kerfMm: 2, spacingMm: 1 }, filmTextureByItemId: new Map() }).map((v) => v.code);
    expect(codes).toContain('overlap');
  });

  it('returns off_sheet violation when piece extends past usable area', () => {
    const off = { ...base, pieces: [{ ...base.pieces[0], x_mm: 2400, width_mm: 600 }] };
    const codes = validateSheetPlacements({ sheetIndex: 0, placements: off, gap: { kerfMm: 2, spacingMm: 1 }, filmTextureByItemId: new Map() }).map((v) => v.code);
    expect(codes).toContain('off_sheet');
  });

  it('returns grain_rotation violation for film-textured rotated detail', () => {
    const rot = { ...base, pieces: [{ ...base.pieces[0], rotated: true }] };
    const codes = validateSheetPlacements({ sheetIndex: 0, placements: rot, gap: { kerfMm: 2, spacingMm: 1 }, filmTextureByItemId: new Map([['det-1', true]]) }).map((v) => v.code);
    expect(codes).toContain('grain_rotation');
  });

  it('does not flag grain_rotation when detail has no film texture', () => {
    const rot = { ...base, pieces: [{ ...base.pieces[0], rotated: true }] };
    const violations = validateSheetPlacements({ sheetIndex: 0, placements: rot, gap: { kerfMm: 2, spacingMm: 1 }, filmTextureByItemId: new Map() });
    expect(violations.map((v) => v.code)).not.toContain('grain_rotation');
  });
});

describe('orientPieceRect', () => {
  const r = { x: 10, y: 20, w: 100, h: 50 };

  it('portrait: identity transform with sheet viewport extents', () => {
    expect(orientPieceRect(r, 2800, 2070, false)).toEqual({ x: 10, y: 20, w: 100, h: 50, vw: 2800, vh: 2070 });
  });

  it('landscape: 90° CW rotation', () => {
    // x' = sheetH - (y + h) = 2070 - 70 = 2000
    // y' = x = 10, w' = h = 50, h' = w = 100
    expect(orientPieceRect(r, 2800, 2070, true)).toEqual({ x: 2000, y: 10, w: 50, h: 100, vw: 2070, vh: 2800 });
  });

  it('landscape originTopLeft=false keeps the legacy 90° CW (explicit default)', () => {
    expect(orientPieceRect(r, 2800, 2070, true, false)).toEqual({ x: 2000, y: 10, w: 50, h: 100, vw: 2070, vh: 2800 });
  });

  it('landscape originTopLeft=true: transpose (axis swap), same viewBox dims as 90° CW', () => {
    // x' = y = 20, y' = x = 10, w' = h = 50, h' = w = 100; vw/vh unchanged (sheetH×sheetW)
    expect(orientPieceRect(r, 2800, 2070, true, true)).toEqual({ x: 20, y: 10, w: 50, h: 100, vw: 2070, vh: 2800 });
  });

  it('transpose maps the dense (0,0) corner to the view top-left (0,0)', () => {
    const corner = { x: 0, y: 0, w: 600, h: 300 };
    const t = orientPieceRect(corner, 2800, 2070, true, true);
    expect(t.x).toBe(0);
    expect(t.y).toBe(0);
  });

  it('legacy 90° CW sends the (0,0) corner toward the top-right (x near sheetH)', () => {
    const corner = { x: 0, y: 0, w: 600, h: 300 };
    const cw = orientPieceRect(corner, 2800, 2070, true, false);
    // x' = sheetH - (0 + 300) = 1770 — right half of the 2070-wide rotated view
    expect(cw.x).toBe(1770);
  });

  it('originTopLeft is ignored when not rotated (portrait identity unchanged)', () => {
    expect(orientPieceRect(r, 2800, 2070, false, true)).toEqual({ x: 10, y: 20, w: 100, h: 50, vw: 2800, vh: 2070 });
  });
});

describe('rotatePiece', () => {
  it('swaps width/height and inverts rotated flag', () => {
    const p = { width_mm: 600, height_mm: 400, rotated: false };
    expect(rotatePiece(p)).toEqual({ width_mm: 400, height_mm: 600, rotated: true });
  });

  it('double rotation is identity', () => {
    const p = { width_mm: 300, height_mm: 200, rotated: true };
    expect(rotatePiece(rotatePiece(p))).toEqual(p);
  });

  it('preserves unrelated fields', () => {
    const p = { width_mm: 100, height_mm: 200, rotated: false, item_id: 'x', instance: 2 };
    const r = rotatePiece(p);
    expect(r.item_id).toBe('x');
    expect(r.instance).toBe(2);
  });
});

describe('snapDraggedPiece', () => {
  const common = { usableW: 2780, usableH: 2050, gapMm: 3, thresholdMm: 10 };

  it('snaps x to left edge when within threshold', () => {
    const r = snapDraggedPiece({ rect: { x: 4, y: 50, w: 100, h: 100 }, others: [], ...common });
    expect(r).toEqual({ x: 0, y: 50, guideX: 0, guideY: null });
  });

  it('does not snap when beyond threshold', () => {
    const r = snapDraggedPiece({ rect: { x: 20, y: 20, w: 100, h: 100 }, others: [], ...common });
    expect(r).toEqual({ x: 20, y: 20, guideX: null, guideY: null });
  });

  it('snaps x to neighbor right edge + gap', () => {
    const r = snapDraggedPiece({
      rect: { x: 105, y: 200, w: 100, h: 100 },
      others: [{ x: 0, y: 0, w: 100, h: 100 }],
      ...common,
    });
    expect(r.x).toBe(103);
    expect(r.guideX).toBe(103);
  });

  it('snaps x to align left edges with a neighbour', () => {
    // neighbour left edge at x=500; dragged left edge near it (502) → align to 500
    const r = snapDraggedPiece({
      rect: { x: 502, y: 400, w: 100, h: 100 },
      others: [{ x: 500, y: 0, w: 200, h: 100 }],
      ...common,
    });
    expect(r.x).toBe(500);
    expect(r.guideX).toBe(500);
  });

  it('snaps x to align right edges with a neighbour', () => {
    // neighbour right edge at x=700; dragged right edge near it → dragged x = 600, guide at 700
    const r = snapDraggedPiece({
      rect: { x: 603, y: 400, w: 100, h: 100 },
      others: [{ x: 500, y: 0, w: 200, h: 100 }],
      ...common,
    });
    expect(r.x).toBe(600);
    expect(r.guideX).toBe(700);
  });

  it('snaps both axes to a neighbour corner (corner-to-corner)', () => {
    // neighbour occupies [0,100]x[0,100]; dragged near its bottom-right contact corner
    const r = snapDraggedPiece({
      rect: { x: 101, y: 101, w: 100, h: 100 },
      others: [{ x: 0, y: 0, w: 100, h: 100 }],
      ...common,
    });
    expect(r.x).toBe(103); // contact right of neighbour
    expect(r.y).toBe(103);
    expect(r.guideX).toBe(103);
    expect(r.guideY).toBe(103);
  });
});

describe('moveAllowed', () => {
  const base = {
    pieceMaterialTypeId: 1, pieceFilmId: 10,
    targetMaterialTypeId: 1, targetFilmId: 10,
    splitByMaterial: true, combineFilms: false,
  };

  it('allows matching material and film', () => {
    expect(moveAllowed(base)).toEqual({ ok: true });
  });
  it('blocks different material when splitByMaterial', () => {
    expect(moveAllowed({ ...base, targetMaterialTypeId: 2 })).toEqual({ ok: false, reason: 'material' });
  });
  it('ignores material mismatch when splitByMaterial is false', () => {
    expect(moveAllowed({ ...base, targetMaterialTypeId: 2, splitByMaterial: false })).toEqual({ ok: true });
  });
  it('ignores film mismatch when splitByMaterial is false because the all-details group has null film', () => {
    expect(moveAllowed({ ...base, targetMaterialTypeId: null, targetFilmId: null, splitByMaterial: false })).toEqual({ ok: true });
  });
  it('blocks different film when combineFilms is false', () => {
    expect(moveAllowed({ ...base, targetFilmId: 20 })).toEqual({ ok: false, reason: 'film' });
  });
  it('ignores film mismatch when combineFilms is true', () => {
    expect(moveAllowed({ ...base, targetFilmId: 20, combineFilms: true })).toEqual({ ok: true });
  });
  it('reports material first when both mismatch', () => {
    expect(moveAllowed({ ...base, targetMaterialTypeId: 2, targetFilmId: 20 })).toEqual({ ok: false, reason: 'material' });
  });
});
