/**
 * Pure forward/inverse orientation geometry for the manual sheet editor.
 *
 * Extracted from SheetEditor.tsx so the round-trip (forward `orientedOrigin` →
 * inverse `svgToUsable`) can be unit-tested in the node test env without pulling
 * React/antd. No inline geometry literals: the forward transform is the shared
 * canonical `orientPieceRect`; the inverse mirrors it exactly here.
 */
import type { SheetPlacements, SheetPlacementPiece } from '../../api/types/cutApi.types';
import { orientPieceRect } from './cutLayoutGeometry';

/**
 * Get the oriented SVG top-left corner of a piece using the shared
 * orientPieceRect transform (Codex R4 MAJOR #4: single canonical transform).
 * Coordinates are in full-sheet space (trim already added).
 */
export function orientedOrigin(
  piece: SheetPlacementPiece,
  placements: SheetPlacements,
  landscape: boolean,
  originTopLeft = false,
): { x: number; y: number } {
  const r = orientPieceRect(
    {
      x: placements.trim_mm.left + piece.x_mm,
      y: placements.trim_mm.top + piece.y_mm,
      w: piece.width_mm,
      h: piece.height_mm,
    },
    placements.sheet_width_mm,
    placements.sheet_height_mm,
    landscape,
    originTopLeft,
  );
  return { x: r.x, y: r.y };
}

/**
 * Invert the orientPieceRect transform to recover piece usable-area coords
 * from a pointer position in the target sheet's SVG space.
 *
 * Portrait:            svgX = trim.left + x_mm,  svgY = trim.top + y_mm
 * Landscape 90° CW:    svgX = sheetH - (trim.top + y_mm + height_mm),  svgY = trim.left + x_mm
 * Landscape transpose: svgX = trim.top + y_mm,  svgY = trim.left + x_mm  (originTopLeft)
 *
 * The transpose inverse needs no height term (it is a pure axis swap), unlike the
 * 90° CW inverse. x_mm = svgY - trim.left in BOTH landscape branches; only y_mm
 * differs.
 *
 * @param pieceHeightMm  Current piece height (after any rotation), used for the 90° CW inversion.
 */
export function svgToUsable(
  svgX: number,
  svgY: number,
  svgOffsetX: number,
  svgOffsetY: number,
  pieceHeightMm: number,
  placements: SheetPlacements,
  landscape: boolean,
  originTopLeft = false,
): { x_mm: number; y_mm: number } {
  // Piece oriented top-left in SVG space = pointer position minus stored offset
  const ox = svgX - svgOffsetX;
  const oy = svgY - svgOffsetY;
  const trim = placements.trim_mm;
  if (landscape) {
    if (originTopLeft) {
      return {
        x_mm: oy - trim.left,
        y_mm: ox - trim.top,
      };
    }
    return {
      x_mm: oy - trim.left,
      y_mm: placements.sheet_height_mm - trim.top - pieceHeightMm - ox,
    };
  }
  return {
    x_mm: ox - trim.left,
    y_mm: oy - trim.top,
  };
}
