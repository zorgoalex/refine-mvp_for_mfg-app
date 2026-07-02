/**
 * Pure helpers for 3-line piece label rendering.
 * Used by both the SVG editor (SheetEditor) and the HTML preview overlay
 * (SheetPreview). No React / DOM dependency — safe to unit-test under node.
 */

export interface PieceLabelInput {
  /** Order name from orders.order_name. Fallback to "Заказ {orderId}" when null/empty. */
  orderName: string | null;
  orderId: number | null;
  detailNumber: number | null;
  /** This piece's copy ordinal among the position's qty copies. */
  instance: number;
  /** Total copies of this position in the job (null when unavailable). */
  qty: number | null;
  widthMm: number;
  heightMm: number;
  /**
   * Sheet-material name for the 4th label line. Pass a non-blank name ONLY when the
   * sheet mixes materials (splitByMaterial off) so the operator can tell which
   * detail is which material; omit/null on single-material sheets (redundant).
   */
  materialName?: string | null;
}

/** Proportional average character width relative to font-size. */
const CHAR_W = 0.6;
/** Line height multiplier (em units). */
const LINE_H = 1.2;

/**
 * Scale factor applied to line 1 (order name) relative to the base font.
 * Export so SheetEditor and SheetPreview use the exact same multiplier.
 */
export const LINE1_SCALE = 1.7;

/** Format a mm dimension: integer → no decimal; float → 1 decimal place. */
function fmtDim(mm: number): string {
  if (!isFinite(mm)) return '0';
  return Number.isInteger(mm) ? String(mm) : mm.toFixed(1);
}

/**
 * Split a dims line of the form "{w}*{h}" into its parts.
 * Returns { w, h } when the asterisk separator is present, or null otherwise.
 * Pure and testable; used by SheetEditor (SVG tspan) and SheetPreview (span).
 */
export function splitDimsLine(line: string): { w: string; h: string } | null {
  const idx = line.indexOf('*');
  if (idx < 0) return null;
  return { w: line.slice(0, idx), h: line.slice(idx + 1) };
}

/**
 * Build three label lines for a cut piece.
 *
 * Line 1: order name (large/bold) — `orders.order_name`, or `Заказ {orderId}` fallback.
 * Line 2: `# {detailNumber} · {instance}/{qty}` (base font). `# —` when detailNumber null.
 * Line 3: `{widthMm}*{heightMm}` — asterisk separator; integer dims have no decimal, floats 1 dp.
 * Line 4 (optional): sheet-material name — appended ONLY when `materialName` is a
 *   non-blank string (mixed-material sheet). Omitted otherwise.
 *
 * Returns 3 non-empty strings, or 4 when a material line is appended.
 */
export function buildPieceLabelLines(p: PieceLabelInput): string[] {
  // Line 1: order name or fallback
  const nm = p.orderName?.trim();
  const line1 = nm || (p.orderId !== null ? `Заказ ${p.orderId}` : 'Заказ —');

  // Line 2: position + copy ordinal (# prefix, not Поз.)
  const pos = p.detailNumber !== null ? `# ${p.detailNumber}` : '# —';
  const line2 =
    p.qty !== null
      ? `${pos} · ${p.instance}/${p.qty}`
      : `${pos} · ${p.instance}`;

  // Line 3: rendered dimensions with asterisk separator (not ×)
  const line3 = `${fmtDim(p.widthMm)}*${fmtDim(p.heightMm)}`;

  // Line 4 (optional): material — only for mixed-material sheets.
  const material = p.materialName?.trim();
  return material ? [line1, line2, line3, material] : [line1, line2, line3];
}

/**
 * Compute a font scale factor so that `lines` fit inside a box of `boxW × boxH`
 * (any consistent unit — mm for SVG, px for HTML).
 *
 * @param line1Scale  Optional scale multiplier for line 0 (the large order-name line).
 *   Default 1 (all lines same size — backward-compatible). Pass `LINE1_SCALE` (1.7)
 *   for the 3-line label with a large first line. Affects both width and height fit:
 *   - Width:  line 0 width = chars × baseFont × CHAR_W × line1Scale.
 *   - Height: block height = Σ (baseFont × scale_i × LINE_H) for i in lines.
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
  line1Scale?: number;
}): number {
  const { lines, boxW, boxH, baseFont, minScale = 0.3, line1Scale = 1 } = args;

  if (baseFont <= 0 || boxW <= 0 || boxH <= 0) return minScale;

  // Per-line scale: line 0 uses line1Scale, all others use 1.
  const lineScales = lines.map((_, i) => (i === 0 ? line1Scale : 1));

  // Widest effective line width (baseFont at scale 1 is the reference unit).
  const longestLineWidth = Math.max(
    ...lines.map((l, i) => l.length * baseFont * CHAR_W * lineScales[i]),
    1,
  );

  // Block height: sum of per-line heights.
  const blockHeight = lineScales.reduce((acc, s) => acc + baseFont * s * LINE_H, 0);

  const widthFit = boxW / longestLineWidth;
  const heightFit = boxH / blockHeight;

  const scale = Math.min(widthFit, heightFit, 1);
  return Math.max(minScale, Math.min(1, scale));
}
