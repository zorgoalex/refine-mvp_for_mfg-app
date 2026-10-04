// Schematic sheet preview for the NewLine sheet tiles: the sheet lying on its long side with the
// pieces as filled rectangles — drawn from the layout itself, not from the rendered sheet image.
import type { SheetPlacements } from '../../api/types/cutApi.types';

export interface SheetMiniRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SheetMiniMap {
  widthMm: number;
  heightMm: number;
  rects: SheetMiniRect[];
}

/** Sheet and pieces in millimetres; a portrait sheet is laid on its long side (transposed). */
export function buildSheetMiniMap(placements: SheetPlacements): SheetMiniMap {
  const sheetW = placements.sheet_width_mm;
  const sheetH = placements.sheet_height_mm;
  const transpose = sheetH > sheetW;
  const rects = placements.pieces.map((piece) => {
    const x = placements.trim_mm.left + piece.x_mm;
    const y = placements.trim_mm.top + piece.y_mm;
    return transpose
      ? { x: y, y: x, w: piece.height_mm, h: piece.width_mm }
      : { x, y, w: piece.width_mm, h: piece.height_mm };
  });
  return transpose
    ? { widthMm: sheetH, heightMm: sheetW, rects }
    : { widthMm: sheetW, heightMm: sheetH, rects };
}

// Calm decor-like fills; the same name always gets the same colour.
const SHEET_MINI_COLORS = ['#eadfc4', '#c9d3cd', '#d9c7b4', '#cfd6e4', '#e3cfc9', '#c8d8c0', '#d8d2e6', '#e6dcb2'] as const;

/** Stable fill colour for a film or material name. */
export function sheetMiniColor(name: string | null | undefined): string {
  const text = (name ?? '').trim().toLowerCase();
  if (!text) return SHEET_MINI_COLORS[1];
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  return SHEET_MINI_COLORS[hash % SHEET_MINI_COLORS.length];
}
