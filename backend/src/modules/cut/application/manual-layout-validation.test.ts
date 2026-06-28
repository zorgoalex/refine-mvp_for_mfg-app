import { describe, it, expect } from 'vitest';
import {
  piecesClear,
  pieceWithinUsable,
  usableExtent,
  validateSheetPlacements,
  orientPieceRect,
  rotatePiece,
  snapDraggedPiece,
} from './manual-layout-validation';
import golden from './__fixtures__/cut-layout-golden.json';

// ── Brief Step 1 verbatim tests ────────────────────────────────────────────

const sheet = {
  sheet_width_mm: 2800,
  sheet_height_mm: 2070,
  trim_mm: { left: 10, right: 10, top: 10, bottom: 10 },
};

describe('usableExtent', () => {
  it('subtracts trim from both axes', () => {
    expect(usableExtent(sheet)).toEqual({ usableW: 2780, usableH: 2050 });
  });
});

describe('piecesClear', () => {
  const a = { x: 0, y: 0, w: 100, h: 100 };
  it('clear when horizontal gap >= effective gap', () => {
    expect(piecesClear(a, { x: 103, y: 0, w: 100, h: 100 }, 3)).toBe(true);
  });
  it('not clear when gap below effective gap', () => {
    expect(piecesClear(a, { x: 102, y: 0, w: 100, h: 100 }, 3)).toBe(false);
  });
  it('not clear when overlapping on both axes', () => {
    expect(piecesClear(a, { x: 50, y: 50, w: 100, h: 100 }, 3)).toBe(false);
  });
});

describe('pieceWithinUsable', () => {
  it('true flush to usable bounds', () => {
    expect(pieceWithinUsable({ x: 0, y: 0, w: 2780, h: 2050 }, 2780, 2050)).toBe(true);
  });
  it('false past the right edge', () => {
    expect(pieceWithinUsable({ x: 2700, y: 0, w: 100, h: 100 }, 2780, 2050)).toBe(false);
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
  it('passes a legal layout (gap >= kerf+spacing)', () => {
    const v = validateSheetPlacements({
      sheetIndex: 0,
      placements: base,
      gap: { kerfMm: 2, spacingMm: 1 },
      filmTextureByItemId: new Map(),
    });
    expect(v).toEqual([]);
  });
  it('flags overlap/too-close', () => {
    const tight = { ...base, pieces: [base.pieces[0], { ...base.pieces[1], x_mm: 601 }] };
    const v = validateSheetPlacements({
      sheetIndex: 0,
      placements: tight,
      gap: { kerfMm: 2, spacingMm: 1 },
      filmTextureByItemId: new Map(),
    });
    expect(v.map((x) => x.code)).toContain('overlap');
  });
  it('flags off-sheet', () => {
    const off = { ...base, pieces: [{ ...base.pieces[0], x_mm: 2400, width_mm: 600 }] };
    const v = validateSheetPlacements({
      sheetIndex: 0,
      placements: off,
      gap: { kerfMm: 2, spacingMm: 1 },
      filmTextureByItemId: new Map(),
    });
    expect(v.map((x) => x.code)).toContain('off_sheet');
  });
  it('flags illegal rotation for grain-locked detail', () => {
    const rot = { ...base, pieces: [{ ...base.pieces[0], rotated: true }] };
    const v = validateSheetPlacements({
      sheetIndex: 0,
      placements: rot,
      gap: { kerfMm: 2, spacingMm: 1 },
      filmTextureByItemId: new Map([['det-1', true]]),
    });
    expect(v.map((x) => x.code)).toContain('grain_rotation');
  });
});

// ── orientPieceRect ────────────────────────────────────────────────────────

describe('orientPieceRect', () => {
  const r = { x: 10, y: 20, w: 100, h: 50 };
  it('portrait: identity transform, appends sheet extents as vw/vh', () => {
    expect(orientPieceRect(r, 2800, 2070, false)).toEqual({
      x: 10,
      y: 20,
      w: 100,
      h: 50,
      vw: 2800,
      vh: 2070,
    });
  });
  it('landscape: 90° CW rotation — x becomes sheetH-(y+h), y becomes x, w/h swap', () => {
    // x = 2070 - (20 + 50) = 2000, y = 10, w = 50, h = 100, vw = 2070, vh = 2800
    expect(orientPieceRect(r, 2800, 2070, true)).toEqual({
      x: 2000,
      y: 10,
      w: 50,
      h: 100,
      vw: 2070,
      vh: 2800,
    });
  });
});

// ── rotatePiece ───────────────────────────────────────────────────────────

describe('rotatePiece', () => {
  it('swaps width/height and flips rotated flag', () => {
    const piece = {
      item_id: 'det-1',
      instance: 1,
      x_mm: 0,
      y_mm: 0,
      width_mm: 600,
      height_mm: 400,
      rotated: false,
    };
    const rotated = rotatePiece(piece);
    expect(rotated).toEqual({ ...piece, width_mm: 400, height_mm: 600, rotated: true });
  });
  it('double rotation restores original values', () => {
    const piece = { width_mm: 300, height_mm: 200, rotated: true };
    expect(rotatePiece(rotatePiece(piece))).toEqual(piece);
  });
  it('preserves extra fields on the piece', () => {
    const piece = { width_mm: 100, height_mm: 200, rotated: true, label: { orderId: 1, detailNumber: 2, widthMm: 100, heightMm: 200 } };
    const result = rotatePiece(piece);
    expect(result.width_mm).toBe(200);
    expect(result.height_mm).toBe(100);
    expect(result.rotated).toBe(false);
    expect(result.label).toEqual(piece.label);
  });
});

// ── snapDraggedPiece ──────────────────────────────────────────────────────

describe('snapDraggedPiece', () => {
  const usableW = 2780;
  const usableH = 2050;

  it('snaps x to left edge when within threshold', () => {
    const result = snapDraggedPiece({
      rect: { x: 4, y: 50, w: 100, h: 100 },
      others: [],
      usableW,
      usableH,
      gapMm: 3,
      thresholdMm: 10,
    });
    expect(result).toEqual({ x: 0, y: 50 });
  });

  it('does not snap when distance exceeds threshold', () => {
    const result = snapDraggedPiece({
      rect: { x: 20, y: 20, w: 100, h: 100 },
      others: [],
      usableW,
      usableH,
      gapMm: 3,
      thresholdMm: 10,
    });
    expect(result).toEqual({ x: 20, y: 20 });
  });

  it('snaps x to neighbor right edge + gap', () => {
    const result = snapDraggedPiece({
      rect: { x: 105, y: 50, w: 100, h: 100 },
      others: [{ x: 0, y: 0, w: 100, h: 100 }],
      usableW,
      usableH,
      gapMm: 3,
      thresholdMm: 10,
    });
    expect(result.x).toBe(103);
  });

  it('snaps y to neighbor bottom edge + gap', () => {
    const result = snapDraggedPiece({
      rect: { x: 50, y: 104, w: 100, h: 100 },
      others: [{ x: 0, y: 0, w: 100, h: 100 }],
      usableW,
      usableH,
      gapMm: 3,
      thresholdMm: 10,
    });
    expect(result.y).toBe(103);
  });
});

// ── Golden fixture parity (brief Step 4b) ─────────────────────────────────

it.each(golden.filter((c) => c.kind === 'validate'))('golden BE validate: $name', (c) => {
  const v = validateSheetPlacements({
    sheetIndex: 0,
    placements: c.input.placements,
    gap: c.input.gap,
    filmTextureByItemId: new Map(Object.entries(c.input.filmTexture ?? {})),
  });
  expect(v.map((x) => x.code).sort()).toEqual([...c.expected].sort());
});

// orient cases added by Task 9 — guards the real render transform (Codex R4 #4)
it.each(golden.filter((c) => c.kind === 'orient'))('golden BE orient: $name', (c) => {
  expect(
    orientPieceRect(c.input.rect, c.input.sheetW, c.input.sheetH, c.input.landscape),
  ).toEqual(c.expected);
});
