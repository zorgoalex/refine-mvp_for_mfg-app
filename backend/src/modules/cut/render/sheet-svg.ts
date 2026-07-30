import {
  BATH_METER_GUIDE_STYLE,
  applyAxisOrigin,
  bathMeterGuideLabel,
  bathMeterGuideLabelFontMm,
  bathMeterGuideLines,
  orientPieceRect,
  type CutAxisOrigin,
} from '../../../shared/cut-geometry';
import {
  parseFreecutItemId,
  type BackMappedSheet,
  type FreecutPlacement,
  type SheetPlacementsJson,
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
  /**
   * Human order name (orders.order_name) resolved for the piece. When a non-blank
   * name is present it REPLACES the numeric order id on label line 1; the numeric
   * id remains the fallback for orders whose name can't be resolved.
   */
  orderName?: string | null;
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
 * 1) order name (orders.order_name), falling back to the numeric order id when
 * the name is blank/unresolved, 2) order detail position + instance count,
 * 3) size (width x height), 4) material name — appended ONLY when `materialName`
 * is a non-blank string (mixed-material sheet). When the order can't be resolved
 * we fall back to a single line with the raw item id so the label is never empty.
 */
export function composePieceLabelLines(input: PieceLabelInput): string[] {
  const { orderId, orderName, detailId, detailNumber, widthMm, heightMm, itemId, instance, qty } = input;
  if (orderId === null || detailId === null) {
    return [formatPieceLabel(itemId, instance, qty)];
  }
  const orderLabel = orderName?.trim() || String(orderId);
  const lines = [
    orderLabel,
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
const BATH_DIMENSION_FONT_ENLARGE_MIN_SIDE_MM = 150;

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
  /** Final displayed Y origin; independent from the legacy landscape transform. */
  axisOrigin?: CutAxisOrigin;
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
  /** Overlay 800/1800 mm film-length references for a resolved vacuum bath. */
  showBathMeterGuides?: boolean;
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

function pieceDataAttributes(piece: FreecutPlacement, cx: number, cy: number): string {
  const detailId = parseFreecutItemId(piece.item_id);
  const attrs = [
    'class="cut-sheet-piece"',
    `data-item-id="${escapeXml(piece.item_id)}"`,
    `data-piece-instance="${num(piece.instance)}"`,
    `data-piece-cx="${num(cx)}"`,
    `data-piece-cy="${num(cy)}"`,
  ];
  if (detailId !== null) attrs.push(`data-detail-id="${detailId}"`);
  return attrs.join(' ');
}

function renderPieceGroup(piece: FreecutPlacement, cx: number, cy: number, body: string): string {
  return `<g ${pieceDataAttributes(piece, cx, cy)}>${body}</g>`;
}

function renderBathMeterGuideLabels(
  sheet: SheetPlacementsJson,
  landscape: boolean,
  labelFontMm = bathMeterGuideLabelFontMm(sheet.sheet_width_mm, sheet.sheet_height_mm),
): string {
  return bathMeterGuideLines(sheet.sheet_width_mm, sheet.sheet_height_mm, landscape)
    .map((line) => {
      const label = bathMeterGuideLabel(line, labelFontMm);
      return `<text class="cut-bath-meter-guide-label" data-offset-mm="${num(line.offsetMm)}" x="${num(
        label.x,
      )}" y="${num(label.y)}" fill="${BATH_METER_GUIDE_STYLE.labelFill}" font-family="Liberation Sans, sans-serif" font-size="${num(
        labelFontMm,
      )}" font-weight="${num(BATH_METER_GUIDE_STYLE.labelFontWeight)}" text-anchor="start" dominant-baseline="middle" stroke="#ffffff" stroke-width="${num(
        labelFontMm * 0.16,
      )}" paint-order="stroke" pointer-events="none" style="font-variant-numeric:tabular-nums">${label.text}</text>`;
    })
    .join('');
}

function renderBathMeterGuides(
  sheet: SheetPlacementsJson,
  landscape: boolean,
  labelFontMm = bathMeterGuideLabelFontMm(sheet.sheet_width_mm, sheet.sheet_height_mm),
): string {
  const lines = bathMeterGuideLines(sheet.sheet_width_mm, sheet.sheet_height_mm, landscape)
    .map((line) => (
      `<line class="cut-bath-meter-guide" data-offset-mm="${num(line.offsetMm)}" x1="${num(line.x1)}" y1="${num(
        line.y1,
      )}" x2="${num(line.x2)}" y2="${num(line.y2)}" stroke="${BATH_METER_GUIDE_STYLE.stroke}" stroke-opacity="${num(
        BATH_METER_GUIDE_STYLE.strokeOpacity,
      )}" stroke-width="${num(BATH_METER_GUIDE_STYLE.strokeWidthMm)}" stroke-dasharray="${num(
        BATH_METER_GUIDE_STYLE.dashMm,
      )} ${num(BATH_METER_GUIDE_STYLE.gapMm)}" pointer-events="none"/>`
    ))
    .join('');
  return `${lines}${renderBathMeterGuideLabels(sheet, landscape, labelFontMm)}`;
}

/** Adds guide overlays to an already rendered/frozen SVG, idempotently. */
export function addBathMeterGuidesToSvg(
  svg: string,
  sheet: SheetPlacementsJson,
  landscape: boolean,
): string {
  const hasLines = svg.includes('class="cut-bath-meter-guide"');
  const hasLabels = svg.includes('class="cut-bath-meter-guide-label"');
  if (hasLines && hasLabels) return svg;
  const overlay = hasLines
    ? renderBathMeterGuideLabels(sheet, landscape)
    : renderBathMeterGuides(sheet, landscape);
  if (!overlay) return svg;
  const closingTag = svg.lastIndexOf('</svg>');
  return closingTag < 0
    ? svg
    : `${svg.slice(0, closingTag)}${overlay}${svg.slice(closingTag)}`;
}

export function buildSheetSvg(input: BuildSheetSvgInput): string {
  const { sheet, labelFor, fillFor, rotate90 = false, showLabels = true, axisOrigin = 'top-left' } = input;
  const originTopLeft = sheet.coordinate_contract === 'native_portrait_v1' ? false : (input.originTopLeft ?? false);
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
      const rect = applyAxisOrigin(orientPieceRect({ x, y, w: pw, h: ph }, w, h, rotate90, originTopLeft), axisOrigin, rotate90);
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      const fill = fillFor?.(piece) ?? DEFAULT_PIECE_FILL;
      const rectEl = `<rect x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.w)}" height="${num(
        rect.h,
      )}" fill="${escapeXml(fill)}" stroke="#1f2d3d" stroke-width="2"/>`;
      if (!showLabels) {
        return renderPieceGroup(piece, cx, cy, rectEl);
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
      return renderPieceGroup(piece, cx, cy, [
        rectEl,
        `<text x="${num(cx)}" y="${num(cy)}" font-family="Liberation Sans, sans-serif" font-size="${num(
          fontMm,
        )}" fill="#1f2d3d" text-anchor="middle" dominant-baseline="middle">${tspans}</text>`,
      ].join(''));
    })
    .join('');
  const bathMeterGuides = input.showBathMeterGuides
    ? renderBathMeterGuides(sheet, rotate90, bathMeterGuideLabelFontMm(w, h, input.labelFontMm))
    : '';

  return [
    // viewBox only (no width/height attrs): the px size is chosen at raster time
    // via resvg fitTo; explicit width/height would make resvg ignore fitTo.
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(vbW)} ${num(vbH)}">`,
    `<rect x="0" y="0" width="${num(vbW)}" height="${num(vbH)}" fill="#ffffff" stroke="#9aa7b4" stroke-width="3"/>`,
    pieces,
    bathMeterGuides,
    `</svg>`,
  ].join('');
}

export function buildBathProfileSheetSvg(input: BuildSheetSvgInput): string {
  const { sheet, labelFor, fillFor, rotate90 = false, axisOrigin = 'top-left' } = input;
  const originTopLeft = sheet.coordinate_contract === 'native_portrait_v1' ? false : (input.originTopLeft ?? false);
  const w = sheet.sheet_width_mm;
  const h = sheet.sheet_height_mm;
  const fontMm = input.labelFontMm ?? Math.max(24, Math.round(Math.min(w, h) / 42));
  const detailFontMm = fontMm * 2;
  const baseSideFontMm = Math.max(18, Math.round(fontMm * 0.85));
  const { vw: vbW, vh: vbH } = orientPieceRect({ x: 0, y: 0, w, h }, w, h, rotate90, originTopLeft);

  const pieces = sheet.pieces
    .map((piece) => {
      const x = sheet.trim_mm.left + piece.x_mm;
      const y = sheet.trim_mm.top + piece.y_mm;
      const rect = applyAxisOrigin(orientPieceRect({ x, y, w: piece.width_mm, h: piece.height_mm }, w, h, rotate90, originTopLeft), axisOrigin, rotate90);
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      const fill = fillFor?.(piece) ?? DEFAULT_PIECE_FILL;
      const rectEl = `<rect x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.w)}" height="${num(
        rect.h,
      )}" fill="${escapeXml(fill)}" stroke="#1f2d3d" stroke-width="2"/>`;

      const sideTexts: string[] = [];
      let reservedTop = 0;
      let reservedLeft = 0;
      const sideFontMm = bathDimensionBaseFont(rect.w, rect.h, baseSideFontMm);
      const widthLabel = formatDimension(rect.w);
      const widthFont = fitBathSideFont(widthLabel, rect.w, rect.h, sideFontMm, 'horizontal');
      if (widthFont !== null) {
        reservedTop = widthFont * 1.55;
        sideTexts.push(
          `<text x="${num(cx)}" y="${num(rect.y + widthFont * 0.9)}" font-family="Liberation Sans, sans-serif" font-size="${num(
            widthFont,
          )}" fill="#111111" text-anchor="middle" dominant-baseline="middle">${escapeXml(widthLabel)}</text>`,
        );
      }
      const heightLabel = formatDimension(rect.h);
      const heightFont = fitBathSideFont(heightLabel, rect.h, rect.w, sideFontMm, 'vertical');
      if (heightFont !== null) {
        reservedLeft = heightFont * 1.45;
        const tx = rect.x + heightFont * 0.75;
        sideTexts.push(
          `<text x="${num(tx)}" y="${num(cy)}" transform="rotate(-90 ${num(tx)} ${num(
            cy,
          )})" font-family="Liberation Sans, sans-serif" font-size="${num(
            heightFont,
          )}" fill="#111111" text-anchor="middle" dominant-baseline="middle">${escapeXml(heightLabel)}</text>`,
        );
      }
      const labelBox = bathCenterLabelBox(rect, reservedTop, reservedLeft);
      const centerText = renderBathDetailCenterLabel({
        lines: labelFor(piece),
        cx: labelBox.cx,
        cy: labelBox.cy,
        rectW: labelBox.w,
        rectH: labelBox.h,
        baseFontMm: detailFontMm,
        compact: !shouldRenderBathCenterLabel(labelBox.w, labelBox.h, detailFontMm),
      });

      return renderPieceGroup(piece, cx, cy, [rectEl, ...sideTexts, centerText].join(''));
    })
    .join('');
  const bathMeterGuides = input.showBathMeterGuides
    ? renderBathMeterGuides(sheet, rotate90, bathMeterGuideLabelFontMm(w, h, input.labelFontMm))
    : '';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(vbW)} ${num(vbH)}">`,
    `<rect x="0" y="0" width="${num(vbW)}" height="${num(vbH)}" fill="#ffffff" stroke="#9aa7b4" stroke-width="3"/>`,
    pieces,
    bathMeterGuides,
    `</svg>`,
  ].join('');
}

function bathDimensionBaseFont(rectW: number, rectH: number, baseFontMm: number): number {
  return Math.min(rectW, rectH) <= BATH_DIMENSION_FONT_ENLARGE_MIN_SIDE_MM
    ? baseFontMm
    : baseFontMm * 2;
}

function bathCenterLabelBox(rect: { x: number; y: number; w: number; h: number }, reservedTop: number, reservedLeft: number) {
  const pad = Math.max(4, Math.min(rect.w, rect.h) * 0.04);
  const x = rect.x + reservedLeft + pad;
  const y = rect.y + reservedTop + pad;
  const w = Math.max(0, rect.w - reservedLeft - pad * 2);
  const h = Math.max(0, rect.h - reservedTop - pad * 2);
  return {
    x,
    y,
    w,
    h,
    cx: x + w / 2,
    cy: y + h / 2,
  };
}

function shouldRenderBathCenterLabel(rectW: number, rectH: number, baseFontMm: number): boolean {
  const minSide = Math.max(110, baseFontMm * 1.12);
  return rectW >= minSide && rectH >= minSide;
}

function renderBathDetailCenterLabel(input: {
  lines: string | string[];
  cx: number;
  cy: number;
  rectW: number;
  rectH: number;
  baseFontMm: number;
  compact?: boolean;
}): string {
  const lines = (Array.isArray(input.lines) ? input.lines : [input.lines]).slice(0, 2).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  if (lines.length === 1) {
    const font = fitBathLabelFont([lines[0]], input.rectW, input.rectH, input.baseFontMm, 1);
    return `<text x="${num(input.cx)}" y="${num(input.cy)}" font-family="Liberation Sans, sans-serif" font-size="${num(
      font,
    )}" fill="${BATH_ORDER_LABEL_COLOR}" font-weight="700" text-anchor="middle" dominant-baseline="middle">${escapeXml(lines[0])}</text>`;
  }

  const [orderLine, rawPositionLine] = lines;
  const positionLine = formatBathPositionLabel(rawPositionLine);
  if (input.compact) {
    return renderBathPositionLabel({
      label: positionLine,
      cx: input.cx,
      cy: input.cy,
      maxW: input.rectW,
      maxH: input.rectH,
      baseFontMm: input.baseFontMm * 0.8,
      rotate: input.rectW < input.rectH,
    });
  }
  const oneLineText = `${orderLine} ${positionLine}`;
  const shouldUseOneLine = input.rectH < input.baseFontMm * 1.65;
  if (shouldUseOneLine) {
    const font = fitBathLabelFont([oneLineText], input.rectW, input.rectH, input.baseFontMm, 1);
    const positionFont = font * 0.8;
    const orderW = estimateTextWidthMm(orderLine, font);
    const gapW = estimateTextWidthMm(' ', font);
    const positionW = estimateBathPositionWidth(positionLine, positionFont);
    const totalW = orderW + gapW + positionW;
    const left = input.cx - totalW / 2;
    return [
      `<text x="${num(left + orderW / 2)}" y="${num(input.cy)}" font-family="Liberation Sans, sans-serif" font-size="${num(
        font,
      )}" fill="${BATH_ORDER_LABEL_COLOR}" font-weight="700" text-anchor="middle" dominant-baseline="middle">${escapeXml(
        orderLine,
      )}</text>`,
      renderBathPositionLabel({
        label: positionLine,
        cx: left + orderW + gapW + positionW / 2,
        cy: input.cy,
        maxW: positionW,
        maxH: input.rectH,
        baseFontMm: positionFont,
      }),
    ].join('');
  }

  const font = fitBathLabelFont([orderLine, positionLine], input.rectW, input.rectH, input.baseFontMm, 2);
  const positionFont = font * 0.8;
  return [
    `<text x="${num(input.cx)}" y="${num(input.cy - font * 0.55)}" font-family="Liberation Sans, sans-serif" font-size="${num(
      font,
    )}" fill="${BATH_ORDER_LABEL_COLOR}" font-weight="700" text-anchor="middle" dominant-baseline="middle">${escapeXml(
      orderLine,
    )}</text>`,
    renderBathPositionLabel({
      label: positionLine,
      cx: input.cx,
      cy: input.cy + font * 0.55,
      maxW: input.rectW,
      maxH: input.rectH / 2,
      baseFontMm: positionFont,
    }),
  ].join('');
}

function formatBathPositionLabel(value: string): string {
  return value.replace(/^поз\.\s*/i, '# ');
}

function renderBathPositionLabel(input: {
  label: string;
  cx: number;
  cy: number;
  maxW: number;
  maxH: number;
  baseFontMm: number;
  rotate?: boolean;
}): string {
  const match = /^#\s*(.+)$/.exec(input.label);
  const marker = match ? '#' : '';
  const value = match ? ` ${match[1]}` : input.label;
  const availableW = input.rotate ? input.maxH : input.maxW;
  const availableH = input.rotate ? input.maxW : input.maxH;
  const font = fitBathPositionFont(marker, value, availableW, availableH, input.baseFontMm);
  if (font === null) return '';
  const hashFont = font * 0.5;
  const markerW = marker ? estimateTextWidthMm(marker, hashFont) : 0;
  const valueW = estimateTextWidthMm(value, font);
  const left = input.cx - (markerW + valueW) / 2;
  const body = [
    marker
      ? `<text x="${num(left + markerW / 2)}" y="${num(input.cy)}" font-family="Liberation Sans, sans-serif" font-size="${num(
          hashFont,
        )}" fill="${BATH_POSITION_LABEL_COLOR}" text-anchor="middle" dominant-baseline="middle">${escapeXml(marker)}</text>`
      : '',
    `<text x="${num(left + markerW + valueW / 2)}" y="${num(input.cy)}" font-family="Liberation Sans, sans-serif" font-size="${num(
      font,
    )}" fill="${BATH_POSITION_LABEL_COLOR}" text-anchor="middle" dominant-baseline="middle">${escapeXml(value)}</text>`,
  ].join('');
  return input.rotate ? `<g transform="rotate(-90 ${num(input.cx)} ${num(input.cy)})">${body}</g>` : body;
}

function estimateBathPositionWidth(label: string, fontMm: number): number {
  const match = /^#\s*(.+)$/.exec(label);
  if (!match) return estimateTextWidthMm(label, fontMm);
  return estimateTextWidthMm('#', fontMm * 0.5) + estimateTextWidthMm(` ${match[1]}`, fontMm);
}

function fitBathPositionFont(
  marker: string,
  value: string,
  maxW: number,
  maxH: number,
  baseFontMm: number,
): number | null {
  const width = (marker ? estimateTextWidthMm(marker, baseFontMm * 0.5) : 0) + estimateTextWidthMm(value, baseFontMm);
  const scale = Math.min(1, (maxW * 0.82) / Math.max(width, 1), (maxH * 0.62) / baseFontMm);
  const font = baseFontMm * scale;
  return font >= 5 ? font : null;
}

function fitBathLabelFont(lines: readonly string[], rectW: number, rectH: number, baseFontMm: number, lineCount: 1 | 2): number {
  const widestAtBase = Math.max(...lines.map((line) => estimateTextWidthMm(line, baseFontMm)), 1);
  const widthScale = (rectW * 0.86) / widestAtBase;
  const heightScale = lineCount === 1 ? (rectH * 0.72) / baseFontMm : (rectH * 0.56) / baseFontMm;
  const scale = Math.min(1, widthScale, heightScale);
  return Math.max(6, baseFontMm * scale);
}

function fitBathSideFont(
  label: string,
  lengthMm: number,
  thicknessMm: number,
  baseFontMm: number,
  orientation: 'horizontal' | 'vertical',
): number | null {
  const textAtBase = Math.max(estimateTextWidthMm(label, baseFontMm), 1);
  const widthScale = (lengthMm * 0.82) / textAtBase;
  const thicknessLimit = orientation === 'horizontal' ? 0.35 : 0.42;
  const thicknessScale = (thicknessMm * thicknessLimit) / baseFontMm;
  const font = Math.min(baseFontMm, baseFontMm * widthScale, baseFontMm * thicknessScale);
  return font >= 7 ? font : null;
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
