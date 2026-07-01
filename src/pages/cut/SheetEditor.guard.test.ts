import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('./SheetEditor.tsx', import.meta.url), 'utf8');
describe('SheetEditor source contract', () => {
  it('exports SheetEditor and uses the geometry module for snap/rotate/orient', () => {
    expect(src).toMatch(/export function SheetEditor/);
    expect(src).toMatch(/snapDraggedPiece/);
    expect(src).toMatch(/rotatePiece/);
    expect(src).toMatch(/orientPieceRect/);
  });
  it('does not import testing-library or jsdom', () => {
    expect(src).not.toMatch(/@testing-library|jsdom/);
  });
  it('renders an svg and calls onChange', () => {
    expect(src).toMatch(/<svg/);
    expect(src).toMatch(/onChange\(/);
  });
  it('uses scale-aware snap threshold (SNAP_THRESHOLD_PX) and captures guide lines (guideXmm)', () => {
    expect(src).toMatch(/SNAP_THRESHOLD_PX/);
    expect(src).toMatch(/guideXmm/);
  });
  it('has right-click context menu with onContextMenu, Поворот label, and createPortal', () => {
    expect(src).toMatch(/onContextMenu/);
    expect(src).toMatch(/Поворот/);
    expect(src).toMatch(/createPortal/);
  });
  it('imports moveAllowed from cutLayoutGeometry for cross-sheet guard', () => {
    expect(src).toMatch(/moveAllowed/);
  });
  it('accepts pieceMetaByItemId prop for per-piece material/film lookup', () => {
    expect(src).toMatch(/pieceMetaByItemId/);
  });
  it('shows live per-sheet detail count in the editor sheet header', () => {
    // "дет." label must appear adjacent to placements.pieces.length in the header.
    expect(src).toMatch(/дет\./);
    expect(src).toMatch(/placements\.pieces\.length/);
  });
  it('disables native text selection / drag so grabbing a piece cannot drag the label layer', () => {
    // Phantom-text bug: without userSelect:none + a prevented dragstart, pressing on
    // a piece let the browser start a text selection over the SVG <text> labels and
    // drag that translucent layer with the cursor while the real piece stayed put.
    expect(src).toMatch(/userSelect:\s*'none'/);
    expect(src).toMatch(/onDragStart=\{\(e\)\s*=>\s*e\.preventDefault\(\)\}/);
    // The piece pointer-down must also preventDefault to stop selection initiation.
    expect(src).toMatch(/native text selection[\s\S]{0,120}e\.preventDefault\(\)/);
  });
  it('numbers editor sheets by display position, not the (possibly sparse) sheetIndex', () => {
    // A group's manual layout may omit an emptied sheet, leaving a gap in sheetIndex.
    // The "Лист N" header must use the dense render position so numbering stays 1..N.
    expect(src).toMatch(/Лист \{sheetPos \+ 1\}/);
  });
  it('keeps the original grab offset when crossing sheets (no teleport to old coords)', () => {
    // Regression: crossing to a new sheet must NOT re-anchor the piece to its old
    // usable coords (d.currentX_mm/d.currentY_mm). Re-anchoring teleported the piece
    // to its source position (typically the sheet's top-left) instead of following
    // the cursor, so it dropped in the corner. The svgOffset is in viewBox mm and is
    // invariant across a group's sheets (shared dimensions, trim and orientation) —
    // keep it stable.
    expect(src).not.toMatch(/x_mm:\s*d\.currentX_mm/);
    expect(src).not.toMatch(/y_mm:\s*d\.currentY_mm/);
  });
});
