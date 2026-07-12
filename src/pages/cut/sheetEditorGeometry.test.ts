import { describe, it, expect } from 'vitest';
import type { SheetPlacements, SheetPlacementPiece } from '../../api/types/cutApi.types';
import { orientedOrigin, svgToUsable } from './sheetEditorGeometry';

/**
 * Manual-editor forward/inverse round-trip. A piece grabbed at its own oriented
 * top-left corner (svgOffset = 0, pointer exactly on the corner) must invert back
 * to the SAME usable-area x_mm/y_mm under every orientation. Covers:
 *   - portrait (identity),
 *   - landscape 90° CW (originTopLeft=false) — the path the editor rotate
 *     realignment newly activates by default (Codex R2-round2 finding #1),
 *   - landscape transpose (originTopLeft=true) — the new top-left origin,
 *   - cross-sheet drop onto a sheet with different trim/dims.
 */
function sheet(overrides: Partial<SheetPlacements> = {}): SheetPlacements {
  return {
    trim_mm: { left: 10, top: 10, right: 10, bottom: 10 },
    sheet_width_mm: 2800,
    sheet_height_mm: 2070,
    pieces: [],
    ...overrides,
  } as SheetPlacements;
}

function piece(x_mm: number, y_mm: number, width_mm: number, height_mm: number): SheetPlacementPiece {
  return { item_id: 'det-1', instance: 1, x_mm, y_mm, width_mm, height_mm, rotated: false } as SheetPlacementPiece;
}

function roundTrip(
  p: SheetPlacementPiece,
  placements: SheetPlacements,
  landscape: boolean,
  originTopLeft: boolean,
  axisOrigin: 'top-left' | 'bottom-left' = 'top-left',
): { x_mm: number; y_mm: number } {
  // Forward: oriented SVG top-left of the piece.
  const o = orientedOrigin(p, placements, landscape, originTopLeft, axisOrigin);
  // Pointer grabs the piece exactly at its top-left → svgOffset = 0.
  return svgToUsable(o.x, o.y, 0, 0, p.height_mm, placements, landscape, originTopLeft, axisOrigin, p.width_mm);
}

describe('sheetEditorGeometry round-trip (forward orientedOrigin ↔ inverse svgToUsable)', () => {
  const p = piece(120, 240, 600, 300);
  const placements = sheet();

  it('portrait (identity) recovers the original usable coords', () => {
    expect(roundTrip(p, placements, false, false)).toEqual({ x_mm: 120, y_mm: 240 });
  });

  it('landscape 90° CW (originTopLeft=false) recovers the original coords on a wide sheet', () => {
    // R2-round2 finding #1: this branch is newly the editor default after the
    // rotate realignment; it must round-trip exactly.
    const r = roundTrip(p, placements, true, false);
    expect(r.x_mm).toBeCloseTo(120, 6);
    expect(r.y_mm).toBeCloseTo(240, 6);
  });

  it('landscape transpose (originTopLeft=true) recovers the original coords', () => {
    const r = roundTrip(p, placements, true, true);
    expect(r.x_mm).toBeCloseTo(120, 6);
    expect(r.y_mm).toBeCloseTo(240, 6);
  });

  it.each([
    ['portrait', false, false],
    ['landscape legacy CW', true, false],
    ['landscape transpose', true, true],
  ] as const)('bottom-left %s round-trips with asymmetric trims', (_name, landscape, originTopLeft) => {
    const asymmetric = sheet({
      trim_mm: { left: 7, top: 19, right: 23, bottom: 31 },
      sheet_width_mm: 2440,
      sheet_height_mm: 1220,
    });
    const rotatedPiece = { ...piece(213, 147, 275, 615), rotated: true };
    const result = roundTrip(rotatedPiece, asymmetric, landscape, originTopLeft, 'bottom-left');
    expect(result.x_mm).toBeCloseTo(rotatedPiece.x_mm, 6);
    expect(result.y_mm).toBeCloseTo(rotatedPiece.y_mm, 6);
  });

  it('transpose anchors the dense (0,0) corner at the view top-left', () => {
    const corner = piece(0, 0, 600, 300);
    const o = orientedOrigin(corner, placements, true, true);
    // trim is added, so the usable-area (0,0) corner maps to (trim.top, trim.left)
    // — the TOP-LEFT region of the rotated view, not the right edge.
    expect(o.x).toBeCloseTo(placements.trim_mm.top, 6);
    expect(o.y).toBeCloseTo(placements.trim_mm.left, 6);
  });

  it('legacy 90° CW anchors the dense (0,0) corner toward the view top-right', () => {
    const corner = piece(0, 0, 600, 300);
    const o = orientedOrigin(corner, placements, true, false);
    // 90° CW sends the usable (0,0) corner toward the right edge (x near sheetH).
    expect(o.x).toBeGreaterThan(placements.sheet_height_mm / 2);
  });

  it('cross-sheet: round-trips on a target sheet with different trim and dims (transpose)', () => {
    const target = sheet({ trim_mm: { left: 5, top: 25, right: 5, bottom: 25 }, sheet_width_mm: 2440, sheet_height_mm: 1220 });
    const moved = piece(300, 100, 400, 200);
    const r = roundTrip(moved, target, true, true);
    expect(r.x_mm).toBeCloseTo(300, 6);
    expect(r.y_mm).toBeCloseTo(100, 6);
  });

  it('cross-sheet: round-trips on a different sheet under legacy 90° CW too', () => {
    const target = sheet({ trim_mm: { left: 5, top: 25, right: 5, bottom: 25 }, sheet_width_mm: 2440, sheet_height_mm: 1220 });
    const moved = piece(300, 100, 400, 200);
    const r = roundTrip(moved, target, true, false);
    expect(r.x_mm).toBeCloseTo(300, 6);
    expect(r.y_mm).toBeCloseTo(100, 6);
  });

  // Cursor-tracking across a cross-sheet drag with a NON-ZERO grab offset.
  // handleMove keeps the ORIGINAL svgOffset when the pointer crosses onto a new
  // sheet, so the piece must stay under the cursor at the same grab point on the
  // target sheet — it must NOT teleport to its old (source) usable coords.
  describe('cross-sheet cursor tracking (constant grab offset)', () => {
    const target = sheet();
    const pieceH = 300;

    for (const [name, landscape, otl] of [
      ['portrait', false, false],
      ['landscape 90° CW', true, false],
      ['landscape transpose', true, true],
    ] as const) {
      it(`${name}: dropped piece sits under the cursor, not at source coords`, () => {
        // Operator grabbed a piece somewhere off its own corner → non-zero offset.
        const svgOffsetX = 40;
        const svgOffsetY = 25;
        // Pointer released at an arbitrary point on the TARGET sheet's SVG.
        const pointerSvgX = 1200;
        const pointerSvgY = 800;

        const coords = svgToUsable(
          pointerSvgX,
          pointerSvgY,
          svgOffsetX,
          svgOffsetY,
          pieceH,
          target,
          landscape,
          otl,
        );
        // The piece placed at those coords must render with its oriented top-left
        // exactly at (pointer − offset): the cursor keeps the same grab point.
        const origin = orientedOrigin(
          piece(coords.x_mm, coords.y_mm, 600, pieceH),
          target,
          landscape,
          otl,
        );
        expect(origin.x).toBeCloseTo(pointerSvgX - svgOffsetX, 6);
        expect(origin.y).toBeCloseTo(pointerSvgY - svgOffsetY, 6);
      });
    }
  });
});
