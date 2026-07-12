/**
 * FE adapter for the shared pure geometry module.
 *
 * Re-exports all geometry functions and types from @shared/cut-geometry so
 * that Tasks 10/11 (SheetEditor, CutPage) import from one place — and never
 * duplicate math (Codex R16 BLOCKER #2).
 *
 * The only code defined here is movesFromSheets, a FE-only adapter that maps
 * the working SheetPlacements state to the SaveManualLayoutRequest.placements
 * wire format (CutManualMove[]).
 */

// ── Re-exports from the shared module (no geometry literals here) ─────────────

export {
  usableExtent,
  piecesClear,
  pieceWithinUsable,
  validateSheetPlacements,
  orientPieceRect,
  applyAxisOrigin,
  undoAxisOriginY,
  snapDraggedPiece,
  rotatePiece,
  moveAllowed,
  validateSheetGroupInvariant,
} from '@shared/cut-geometry';

export type {
  GeomPiece,
  GeomSheet,
  PieceRect,
  ManualViolation,
  CutAxisOrigin,
  GapParams,
  PieceLabelSnapshot,
  SnapResult,
  MoveBlockReason,
} from '@shared/cut-geometry';

// ── FE-only: movesFromSheets ──────────────────────────────────────────────────

import type { SheetPlacements, CutManualMove } from '../../api/types/cutApi.types';

/**
 * Derives the CutManualMove[] payload from the working editor placements.
 * Called by SheetEditor before sending PATCH /manual-layout so the backend
 * receives moves, not raw geometry.
 */
export function movesFromSheets(
  sheets: { sheetIndex: number; placements: SheetPlacements }[],
): CutManualMove[] {
  return sheets.flatMap(({ sheetIndex, placements }) =>
    placements.pieces.map((piece) => ({
      itemId: piece.item_id,
      instance: piece.instance,
      sheetIndex,
      xMm: piece.x_mm,
      yMm: piece.y_mm,
      rotated: piece.rotated,
    })),
  );
}
