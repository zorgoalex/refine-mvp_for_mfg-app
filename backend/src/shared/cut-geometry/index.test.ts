/**
 * Unit tests for shared/cut-geometry — run by the backend Vitest project.
 * Imports directly from the shared module (no re-export indirection).
 * Pure; no DOM, no NestJS, no React.
 */
import { describe, it, expect } from 'vitest';
import {
  usableExtent,
  piecesClear,
  pieceWithinUsable,
  validateSheetPlacements,
  orientPieceRect,
  rotatePiece,
  snapDraggedPiece,
} from './index';

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
    expect(r).toEqual({ x: 0, y: 50 });
  });

  it('does not snap when beyond threshold', () => {
    const r = snapDraggedPiece({ rect: { x: 20, y: 20, w: 100, h: 100 }, others: [], ...common });
    expect(r).toEqual({ x: 20, y: 20 });
  });

  it('snaps x to neighbor right edge + gap', () => {
    const r = snapDraggedPiece({
      rect: { x: 105, y: 200, w: 100, h: 100 },
      others: [{ x: 0, y: 0, w: 100, h: 100 }],
      ...common,
    });
    expect(r.x).toBe(103);
  });
});
