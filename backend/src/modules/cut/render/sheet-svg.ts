import type {
  BackMappedSheet,
  FreecutPlacement,
  SheetPlacementsJson,
} from '../application/cut-freecut-mapping';

/**
 * Backend renders its OWN per-sheet SVG from normalized placements (plan §7),
 * NOT by slicing freecut's glued SVG: fixes tiny-label legibility, decouples
 * from freecut cosmetics, and is per-sheet natively.
 *
 * Coordinate system (MAJOR-8): placement x_mm/y_mm are relative to the USABLE
 * area (after trim). We draw the full sheet at sheet_width_mm x sheet_height_mm
 * and offset every piece by trim_mm.{left,top}. viewBox is in mm; px is chosen
 * at raster time via resvg fitTo.
 */

/** Render label rule (§3): include `instance N/qty` only when qty > 1. */
export function formatPieceLabel(baseLabel: string, instance: number, qty: number): string {
  return qty > 1 ? `${baseLabel} ${instance}/${qty}` : baseLabel;
}

/** Total placed instances per freecut item id across all sheets of a group. */
export function computeGroupItemQuantities(sheets: readonly BackMappedSheet[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const sheet of sheets) {
    for (const piece of sheet.placements.pieces) {
      counts.set(piece.item_id, (counts.get(piece.item_id) ?? 0) + 1);
    }
  }
  return counts;
}

export interface BuildSheetSvgInput {
  sheet: SheetPlacementsJson;
  /** resolves a human label for a piece (detail/order + instance N/qty). */
  labelFor: (piece: FreecutPlacement) => string;
  /** font-size in mm for piece labels (scaled with the mm viewBox). */
  labelFontMm?: number;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function num(value: number): string {
  // compact, deterministic numbers (no scientific notation, trim trailing zeros)
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

export function buildSheetSvg(input: BuildSheetSvgInput): string {
  const { sheet, labelFor } = input;
  const w = sheet.sheet_width_mm;
  const h = sheet.sheet_height_mm;
  const fontMm = input.labelFontMm ?? Math.max(24, Math.round(Math.min(w, h) / 40));

  const pieces = sheet.pieces
    .map((piece) => {
      const x = sheet.trim_mm.left + piece.x_mm;
      const y = sheet.trim_mm.top + piece.y_mm;
      const cx = x + piece.width_mm / 2;
      const cy = y + piece.height_mm / 2;
      const label = escapeXml(labelFor(piece));
      return [
        `<rect x="${num(x)}" y="${num(y)}" width="${num(piece.width_mm)}" height="${num(
          piece.height_mm,
        )}" fill="#eef3f8" stroke="#1f2d3d" stroke-width="2"/>`,
        `<text x="${num(cx)}" y="${num(cy)}" font-family="Liberation Sans, sans-serif" font-size="${num(
          fontMm,
        )}" fill="#1f2d3d" text-anchor="middle" dominant-baseline="middle">${label}</text>`,
      ].join('');
    })
    .join('');

  return [
    // viewBox only (no width/height attrs): the px size is chosen at raster time
    // via resvg fitTo; explicit width/height would make resvg ignore fitTo.
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(w)} ${num(h)}">`,
    `<rect x="0" y="0" width="${num(w)}" height="${num(h)}" fill="#ffffff" stroke="#9aa7b4" stroke-width="3"/>`,
    pieces,
    `</svg>`,
  ].join('');
}
