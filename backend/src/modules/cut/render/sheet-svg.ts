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

export interface PieceLabelInput {
  /** order_id resolved for the piece, or null when unknown. */
  orderId: number | null;
  /** order_detail_id parsed from the freecut item id, or null when unparseable. */
  detailId: number | null;
  /** raw freecut item id (fallback label when order/detail are unknown). */
  itemId: string;
  instance: number;
  qty: number;
}

/**
 * Two-line piece label: order on line 1 (`№<orderId>`), detail on line 2
 * (`<detailId>` plus the `N/qty` instance suffix when qty > 1). When the order
 * can't be resolved we fall back to a single line with the raw item id so the
 * label is never empty.
 */
export function composePieceLabelLines(input: PieceLabelInput): string[] {
  const { orderId, detailId, itemId, instance, qty } = input;
  if (orderId === null || detailId === null) {
    return [formatPieceLabel(itemId, instance, qty)];
  }
  return [`№${orderId}`, formatPieceLabel(String(detailId), instance, qty)];
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

const DEFAULT_PIECE_FILL = '#eef3f8';
const ORDER_FILL_PALETTE = [
  '#d7e9ff',
  '#dff3d7',
  '#ffe6b8',
  '#f7d5e8',
  '#d9f0ef',
  '#eadcff',
  '#ffe0d2',
  '#e8edc9',
  '#d5e5f2',
  '#f2ddd5',
] as const;

/** Deterministic, light fill color for a source order. Unknown order keeps the
 * legacy neutral fill so old/partial data remains readable. */
export function orderFillColor(orderId: number | null | undefined): string {
  if (typeof orderId !== 'number' || !Number.isFinite(orderId)) {
    return DEFAULT_PIECE_FILL;
  }
  const index = Math.abs(Math.trunc(orderId)) % ORDER_FILL_PALETTE.length;
  return ORDER_FILL_PALETTE[index];
}

export interface BuildSheetSvgInput {
  sheet: SheetPlacementsJson;
  /**
   * Resolves a human label for a piece. Return a string for a single line, or
   * an array of strings to render one `<tspan>` per line (e.g. order on line 1,
   * detail on line 2).
   */
  labelFor: (piece: FreecutPlacement) => string | string[];
  /** Optional per-piece fill, used to group details by source order. */
  fillFor?: (piece: FreecutPlacement) => string | null | undefined;
  /** font-size in mm for piece labels (scaled with the mm viewBox). */
  labelFontMm?: number;
  /**
   * Rotate the layout 90° clockwise (sheet's long side horizontal / landscape).
   * The GEOMETRY is transposed — not the bitmap — so piece labels stay upright
   * (horizontal) on screen and in print, regardless of orientation.
   */
  rotate90?: boolean;
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
  const { sheet, labelFor, fillFor, rotate90 = false } = input;
  const w = sheet.sheet_width_mm;
  const h = sheet.sheet_height_mm;
  const fontMm = input.labelFontMm ?? Math.max(24, Math.round(Math.min(w, h) / 40));

  // 90° CW transpose into the swapped h×w viewBox. A point (px,py) maps to
  // (h - py, px); a rect's top-left (x,y) maps to (h - (y + ph), x) with sides
  // swapped. Labels are placed at the transposed CENTRE without any rotate()
  // transform, so the text stays horizontal.
  const vbW = rotate90 ? h : w;
  const vbH = rotate90 ? w : h;

  const pieces = sheet.pieces
    .map((piece) => {
      const x = sheet.trim_mm.left + piece.x_mm;
      const y = sheet.trim_mm.top + piece.y_mm;
      const pw = piece.width_mm;
      const ph = piece.height_mm;
      const rect = rotate90
        ? { x: h - (y + ph), y: x, w: ph, h: pw }
        : { x, y, w: pw, h: ph };
      const cx0 = x + pw / 2;
      const cy0 = y + ph / 2;
      const cx = rotate90 ? h - cy0 : cx0;
      const cy = rotate90 ? cx0 : cy0;
      const resolved = labelFor(piece);
      const fill = fillFor?.(piece) ?? DEFAULT_PIECE_FILL;
      const lines = Array.isArray(resolved) ? resolved : [resolved];
      // Vertically centre N lines around cy: the first tspan lifts by
      // (N-1)/2 line-heights, each subsequent line drops one line-height. em
      // units keep the spacing proportional to font-size at any raster scale.
      const tspans = lines
        .map((line, i) => {
          const dy = i === 0 ? `${(-(lines.length - 1) / 2).toFixed(3)}em` : '1em';
          return `<tspan x="${num(cx)}" dy="${dy}">${escapeXml(line)}</tspan>`;
        })
        .join('');
      return [
        `<rect x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.w)}" height="${num(
          rect.h,
        )}" fill="${escapeXml(fill)}" stroke="#1f2d3d" stroke-width="2"/>`,
        `<text x="${num(cx)}" y="${num(cy)}" font-family="Liberation Sans, sans-serif" font-size="${num(
          fontMm,
        )}" fill="#1f2d3d" text-anchor="middle" dominant-baseline="middle">${tspans}</text>`,
      ].join('');
    })
    .join('');

  return [
    // viewBox only (no width/height attrs): the px size is chosen at raster time
    // via resvg fitTo; explicit width/height would make resvg ignore fitTo.
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(vbW)} ${num(vbH)}">`,
    `<rect x="0" y="0" width="${num(vbW)}" height="${num(vbH)}" fill="#ffffff" stroke="#9aa7b4" stroke-width="3"/>`,
    pieces,
    `</svg>`,
  ].join('');
}
