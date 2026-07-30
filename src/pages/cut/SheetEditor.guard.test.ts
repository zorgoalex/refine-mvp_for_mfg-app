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
  it('renders per-sheet material (always) and film (gated by showFilm) in the header', () => {
    expect(src).toMatch(/sheetMaterialFilmNames/);
    expect(src).toMatch(/pieceSheetInfoByItemId/);
    expect(src).toMatch(/showFilm/);
    expect(src).toMatch(/Материал/);
    expect(src).toMatch(/Плёнк/);
    expect(src).toMatch(/calculateBathSheetFilmUsage/);
    expect(src).toMatch(/Потребность плёнки/);
  });
  it('renders shared low-contrast 800/1800 mm vacuum-bath guides above piece fills', () => {
    expect(src).toMatch(/showBathMeterGuides/);
    expect(src).toMatch(/displayBathLandscape\s*=\s*landscape\s*!==\s*swapsViewAxes/);
    expect(src).toMatch(/className="cut-bath-meter-guide-overlay"/);
    expect(src).toMatch(/bathMeterGuideLines\(W,\s*H,\s*displayBathLandscape\)/);
    expect(src).toMatch(/className="cut-bath-meter-guide"/);
    expect(src).toMatch(/BATH_METER_GUIDE_STYLE\.strokeOpacity/);
    expect(src).toMatch(/pointerEvents:\s*'none'/);
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
  it('auto-scrolls the editor/page while dragging near a vertical edge', () => {
    expect(src).toMatch(/DRAG_SCROLL_ZONE_PX/);
    expect(src).toMatch(/DRAG_SCROLL_MAX_PX_PER_FRAME/);
    expect(src).toMatch(/lastPointerRef/);
    expect(src).toMatch(/performDragAutoScroll/);
    expect(src).toMatch(/scrollableParents\(editorRootRef\.current\)/);
    expect(src).toMatch(/updateDragFromClient\(pointer\.clientX,\s*pointer\.clientY\)/);
  });
  it('accepts sticky-toolbar group zoom and supports per-sheet 360-degree view rotation', () => {
    expect(src).toMatch(/viewZoom\?: number/);
    expect(src).toMatch(/viewZoom = 1/);
    expect(src).toMatch(/RotateLeftOutlined/);
    expect(src).toMatch(/RotateRightOutlined/);
    expect(src).toMatch(/% 360 \+ 360\) % 360/);
    expect(src).toMatch(/svgMmPerScreenPx/);
    expect(src).toMatch(/Math\.hypot\(ctm\.a, ctm\.b\)/);
  });
  it('supports horizontal and vertical sheet mirroring with a milling warning', () => {
    expect(src).toMatch(/sheetMirrors/);
    expect(src).toMatch(/SwapOutlined/);
    expect(src).toMatch(/ColumnHeightOutlined/);
    expect(src).toMatch(/scaleX\(\$\{viewMirror\.horizontal \? -1 : 1\}\)/);
    expect(src).toMatch(/scaleY\(\$\{viewMirror\.vertical \? -1 : 1\}\)/);
    expect(src).toContain('Зеркальное отражение может исказить рисунок фрезеровки');
    expect(src).toMatch(/aria-pressed=\{viewMirror\.horizontal\}/);
    expect(src).toMatch(/aria-pressed=\{viewMirror\.vertical\}/);
  });
  it('counter-transforms detail labels so rotation and mirroring never affect text readability', () => {
    expect(src).toMatch(/counterViewMatrix/);
    expect(src).toMatch(/transform=\{`matrix\(\$\{labelMatrix\.join\(' '\)\}\)`\}/);
    expect(src).toMatch(/swapsViewAxes \? r\.h : r\.w/);
    expect(src).toMatch(/swapsViewAxes \? r\.w : r\.h/);
  });
  it('clips SVG labels to the oriented piece rect and allows strong shrink for long order names', () => {
    expect(src).toMatch(/SVG_LABEL_MIN_SCALE\s*=\s*0\.05/);
    expect(src).toMatch(/clipPathUnits="userSpaceOnUse"/);
    expect(src).toMatch(/clipPath=\{`url\(#\$\{labelClipId\}\)`\}/);
    expect(src).toMatch(/boxW:\s*labelBoxW/);
    expect(src).toMatch(/boxH:\s*labelBoxH/);
    expect(src).toMatch(/minScale:\s*SVG_LABEL_MIN_SCALE/);
  });
});
