import { orientPieceRect } from '../../../shared/cut-geometry';
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
  /** detail_number from the source order, or null when unknown. */
  detailNumber?: number | null;
  /** resolved source detail dimensions, shown as width x height. */
  widthMm?: number | null;
  heightMm?: number | null;
  /** raw freecut item id (fallback label when order/detail are unknown). */
  itemId: string;
  instance: number;
  qty: number;
  /**
   * Sheet-material name for the 4th line. Pass a non-blank name ONLY when the
   * sheet mixes materials (splitByMaterial off); omit/null otherwise. Mirrors the
   * frontend preview overlay so print/PDF match the on-screen preview.
   */
  materialName?: string | null;
}

/**
 * Piece label lines shown inside every placed detail:
 * 1) order id (without the № prefix), 2) order detail position + instance
 * count, 3) size (width x height), 4) material name — appended ONLY when
 * `materialName` is a non-blank string (mixed-material sheet). When the
 * order can't be resolved we fall back to a single line with the raw item id so
 * the label is never empty.
 */
export function composePieceLabelLines(input: PieceLabelInput): string[] {
  const { orderId, detailId, detailNumber, widthMm, heightMm, itemId, instance, qty } = input;
  if (orderId === null || detailId === null) {
    return [formatPieceLabel(itemId, instance, qty)];
  }
  const lines = [
    String(orderId),
    formatPositionLine(detailNumber ?? detailId, instance, qty),
    formatPieceSize(widthMm, heightMm),
  ];
  const material = input.materialName?.trim();
  if (material) lines.push(material);
  return lines;
}

function formatPositionLine(position: number, instance: number, qty: number): string {
  return qty > 1 ? `поз. ${position} - ${instance}/${qty}` : `поз. ${position}`;
}

function formatPieceSize(widthMm: number | null | undefined, heightMm: number | null | undefined): string {
  if (widthMm === null || widthMm === undefined || heightMm === null || heightMm === undefined) {
    return 'размер —';
  }
  return `${formatDimension(widthMm)}X${formatDimension(heightMm)}`;
}

function formatDimension(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)));
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
const BATH_ORDER_LABEL_COLOR = '#7f1d1d';
const BATH_POSITION_LABEL_COLOR = '#14532d';

/** Deterministic, light fill color for a source order. Unknown order keeps the
 * legacy neutral fill so old/partial data remains readable. */
export function orderFillColor(orderId: number | null | undefined): string {
  if (typeof orderId !== 'number' || !Number.isFinite(orderId)) {
    return DEFAULT_PIECE_FILL;
  }
  const index = Math.abs(Math.trunc(orderId)) % ORDER_FILL_PALETTE.length;
  return ORDER_FILL_PALETTE[index];
}

/** Build a per-render color resolver from the orders present in one cut group.
 * Different source orders get different palette slots by first appearance, so
 * IDs like 11372 and 11292 do not collapse to the same `orderId % palette` color. */
export function createOrderFillResolver(orderIds: readonly number[]): (orderId: number | null | undefined) => string {
  const indexByOrder = new Map<number, number>();
  for (const orderId of orderIds) {
    if (!Number.isFinite(orderId) || indexByOrder.has(orderId)) continue;
    indexByOrder.set(orderId, indexByOrder.size);
  }
  return (orderId) => {
    if (typeof orderId !== 'number' || !Number.isFinite(orderId)) {
      return DEFAULT_PIECE_FILL;
    }
    const index = indexByOrder.get(orderId);
    return index === undefined ? DEFAULT_PIECE_FILL : ORDER_FILL_PALETTE[index % ORDER_FILL_PALETTE.length];
  };
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
  /**
   * When the layout is rotated (`rotate90=true`), choose the rotated transform:
   * `false` (default) = 90° CW (dense cluster at the view's top-right, legacy);
   * `true` = transpose so the dense cluster anchors at the view's top-left
   * (operator loads the sheet portrait from the top-left). Ignored when
   * `rotate90=false`. Passed straight to `orientPieceRect`.
   */
  originTopLeft?: boolean;
  /**
   * When false, piece label `<text>` elements are omitted entirely.
   * Piece rects, fills, and the sheet outline are always rendered.
   * Defaults to true so every existing caller keeps labels.
   *
   * Use showLabels=false for the on-screen PNG preview so the HTML overlay
   * is the sole label source (no double-label collision).
   * SVG download and PDF print always keep labels (showLabels=true).
   */
  showLabels?: boolean;
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
  const { sheet, labelFor, fillFor, rotate90 = false, originTopLeft = false, showLabels = true } = input;
  const w = sheet.sheet_width_mm;
  const h = sheet.sheet_height_mm;
  const fontMm = input.labelFontMm ?? Math.max(24, Math.round(Math.min(w, h) / 40));

  // orientPieceRect (shared/cut-geometry, Task 1 Codex R4 MAJOR #4) provides the
  // canonical portrait/landscape transform used by BOTH the SVG renderer and the
  // editor overlay — eliminating the risk of the two drifting. Derive viewBox dims
  // from a full-sheet sentinel rect so the function is called once, not per piece.
  const { vw: vbW, vh: vbH } = orientPieceRect({ x: 0, y: 0, w, h }, w, h, rotate90, originTopLeft);

  const pieces = sheet.pieces
    .map((piece) => {
      const x = sheet.trim_mm.left + piece.x_mm;
      const y = sheet.trim_mm.top + piece.y_mm;
      const pw = piece.width_mm;
      const ph = piece.height_mm;
      const rect = orientPieceRect({ x, y, w: pw, h: ph }, w, h, rotate90, originTopLeft);
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      const fill = fillFor?.(piece) ?? DEFAULT_PIECE_FILL;
      const rectEl = `<rect x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.w)}" height="${num(
        rect.h,
      )}" fill="${escapeXml(fill)}" stroke="#1f2d3d" stroke-width="2"/>`;
      if (!showLabels) {
        return rectEl;
      }
      const resolved = labelFor(piece);
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
        rectEl,
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

export function buildBathProfileSheetSvg(input: BuildSheetSvgInput): string {
  const { sheet, labelFor, fillFor, rotate90 = false, originTopLeft = false } = input;
  const w = sheet.sheet_width_mm;
  const h = sheet.sheet_height_mm;
  const fontMm = input.labelFontMm ?? Math.max(24, Math.round(Math.min(w, h) / 42));
  const detailFontMm = fontMm * 2;
  const sideFontMm = Math.max(18, Math.round(fontMm * 0.85)) * 2;
  const { vw: vbW, vh: vbH } = orientPieceRect({ x: 0, y: 0, w, h }, w, h, rotate90, originTopLeft);

  const pieces = sheet.pieces
    .map((piece) => {
      const x = sheet.trim_mm.left + piece.x_mm;
      const y = sheet.trim_mm.top + piece.y_mm;
      const rect = orientPieceRect({ x, y, w: piece.width_mm, h: piece.height_mm }, w, h, rotate90, originTopLeft);
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      const fill = fillFor?.(piece) ?? DEFAULT_PIECE_FILL;
      const rectEl = `<rect x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.w)}" height="${num(
        rect.h,
      )}" fill="${escapeXml(fill)}" stroke="#1f2d3d" stroke-width="2"/>`;

      const centerText = renderBathDetailCenterLabel({
        lines: labelFor(piece),
        cx,
        cy,
        rectW: rect.w,
        rectH: rect.h,
        baseFontMm: detailFontMm,
      });

      const sideTexts: string[] = [];
      if (rect.w >= sideFontMm * 2.5) {
        sideTexts.push(
          `<text x="${num(cx)}" y="${num(rect.y + sideFontMm * 0.9)}" font-family="Liberation Sans, sans-serif" font-size="${num(
            sideFontMm,
          )}" fill="#111111" text-anchor="middle" dominant-baseline="middle">${escapeXml(formatDimension(rect.w))}</text>`,
        );
      }
      if (rect.h >= sideFontMm * 2.5) {
        const tx = rect.x + sideFontMm * 0.75;
        sideTexts.push(
          `<text x="${num(tx)}" y="${num(cy)}" transform="rotate(-90 ${num(tx)} ${num(
            cy,
          )})" font-family="Liberation Sans, sans-serif" font-size="${num(
            sideFontMm,
          )}" fill="#111111" text-anchor="middle" dominant-baseline="middle">${escapeXml(formatDimension(rect.h))}</text>`,
        );
      }

      return [rectEl, ...sideTexts, centerText].join('');
    })
    .join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(vbW)} ${num(vbH)}">`,
    `<rect x="0" y="0" width="${num(vbW)}" height="${num(vbH)}" fill="#ffffff" stroke="#9aa7b4" stroke-width="3"/>`,
    pieces,
    `</svg>`,
  ].join('');
}

function renderBathDetailCenterLabel(input: {
  lines: string | string[];
  cx: number;
  cy: number;
  rectW: number;
  rectH: number;
  baseFontMm: number;
}): string {
  const lines = (Array.isArray(input.lines) ? input.lines : [input.lines]).slice(0, 2).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  if (lines.length === 1) {
    const font = fitBathLabelFont([lines[0]], input.rectW, input.rectH, input.baseFontMm, 1);
    return `<text x="${num(input.cx)}" y="${num(input.cy)}" font-family="Liberation Sans, sans-serif" font-size="${num(
      font,
    )}" fill="${BATH_ORDER_LABEL_COLOR}" font-weight="700" text-anchor="middle" dominant-baseline="middle">${escapeXml(lines[0])}</text>`;
  }

  const [orderLine, positionLine] = lines;
  const oneLineText = `${orderLine} ${positionLine}`;
  const shouldUseOneLine = input.rectH < input.baseFontMm * 1.65;
  if (shouldUseOneLine) {
    const font = fitBathLabelFont([oneLineText], input.rectW, input.rectH, input.baseFontMm, 1);
    return `<text x="${num(input.cx)}" y="${num(input.cy)}" font-family="Liberation Sans, sans-serif" font-size="${num(
      font,
    )}" text-anchor="middle" dominant-baseline="middle"><tspan fill="${BATH_ORDER_LABEL_COLOR}" font-weight="700">${escapeXml(
      orderLine,
    )}</tspan><tspan fill="${BATH_POSITION_LABEL_COLOR}"> ${escapeXml(positionLine)}</tspan></text>`;
  }

  const font = fitBathLabelFont([orderLine, positionLine], input.rectW, input.rectH, input.baseFontMm, 2);
  return `<text x="${num(input.cx)}" y="${num(input.cy)}" font-family="Liberation Sans, sans-serif" font-size="${num(
    font,
  )}" text-anchor="middle" dominant-baseline="middle"><tspan x="${num(input.cx)}" dy="-0.500em" fill="${BATH_ORDER_LABEL_COLOR}" font-weight="700">${escapeXml(
    orderLine,
  )}</tspan><tspan x="${num(input.cx)}" dy="1em" fill="${BATH_POSITION_LABEL_COLOR}">${escapeXml(positionLine)}</tspan></text>`;
}

function fitBathLabelFont(lines: readonly string[], rectW: number, rectH: number, baseFontMm: number, lineCount: 1 | 2): number {
  const widestAtBase = Math.max(...lines.map((line) => estimateTextWidthMm(line, baseFontMm)), 1);
  const widthScale = (rectW * 0.86) / widestAtBase;
  const heightScale = lineCount === 1 ? (rectH * 0.72) / baseFontMm : (rectH * 0.56) / baseFontMm;
  const scale = Math.min(1, widthScale, heightScale);
  return Math.max(12, baseFontMm * scale);
}

function estimateTextWidthMm(value: string, fontMm: number): number {
  let units = 0;
  for (const char of value) {
    if (char === ' ') {
      units += 0.32;
    } else if (/[0-9]/.test(char)) {
      units += 0.56;
    } else if (/[A-Za-zА-Яа-яЁё]/.test(char)) {
      units += 0.62;
    } else {
      units += 0.42;
    }
  }
  return units * fontMm;
}
