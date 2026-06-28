/**
 * Pure helpers for 3-line piece label rendering.
 * Used by both the SVG editor (SheetEditor) and the HTML preview overlay
 * (SheetPreview). No React / DOM dependency — safe to unit-test under node.
 */

export interface PieceLabelInput {
  orderId: number | null;
  detailNumber: number | null;
  /** This piece's copy ordinal among the position's qty copies. */
  instance: number;
  /** Total copies of this position in the job (null when unavailable). */
  qty: number | null;
  widthMm: number;
  heightMm: number;
}

/** Proportional average character width relative to font-size. */
const CHAR_W = 0.6;
/** Line height multiplier (em units). */
const LINE_H = 1.2;

/** Format a mm dimension: integer → no decimal; float → 1 decimal place. */
function fmtDim(mm: number): string {
  if (!isFinite(mm)) return '0';
  return Number.isInteger(mm) ? String(mm) : mm.toFixed(1);
}

/**
 * Build three label lines for a cut piece.
 *
 * Line 1: `Заказ {orderId}`
 * Line 2: `Поз. {detailNumber} · {instance}/{qty}` (or without `/qty` when qty unknown)
 * Line 3: `{widthMm}×{heightMm}` (integer dims have no decimal; floats 1 decimal)
 *
 * Always returns exactly 3 non-empty strings.
 */
export function buildPieceLabelLines(p: PieceLabelInput): string[] {
  // Line 1: order identifier
  const line1 = p.orderId !== null ? `Заказ ${p.orderId}` : 'Заказ —';

  // Line 2: position + copy ordinal
  const pos = p.detailNumber !== null ? `Поз. ${p.detailNumber}` : 'Поз. —';
  const line2 =
    p.qty !== null
      ? `${pos} · ${p.instance}/${p.qty}`
      : `${pos} · ${p.instance}`;

  // Line 3: rendered dimensions
  const line3 = `${fmtDim(p.widthMm)}×${fmtDim(p.heightMm)}`;

  return [line1, line2, line3];
}

/**
 * Compute a font scale factor so that `lines` fit inside a box of `boxW × boxH`
 * (any consistent unit — mm for SVG, px for HTML).
 *
 * Returns a value in `[minScale, 1]`:
 *   - 1 when everything fits at base font.
 *   - Between minScale and 1 when partial shrink is needed.
 *   - Exactly minScale when even that is too large (clipping acceptable).
 */
export function fitLabelScale(args: {
  lines: string[];
  boxW: number;
  boxH: number;
  baseFont: number;
  minScale?: number;
}): number {
  const { lines, boxW, boxH, baseFont, minScale = 0.3 } = args;

  if (baseFont <= 0 || boxW <= 0 || boxH <= 0) return minScale;

  const maxChars = Math.max(...lines.map((l) => l.length), 1);
  const longestLineWidth = maxChars * baseFont * CHAR_W;
  const blockHeight = 3 * baseFont * LINE_H;

  const widthFit = boxW / longestLineWidth;
  const heightFit = boxH / blockHeight;

  const scale = Math.min(widthFit, heightFit, 1);
  return Math.max(minScale, Math.min(1, scale));
}
