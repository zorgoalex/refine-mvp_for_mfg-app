import {
  BATH_METER_GUIDE_OUTSIDE_LEFT_GUTTER_RATIO,
  BATH_METER_GUIDE_OUTSIDE_TOP_GUTTER_RATIO,
  BATH_METER_GUIDE_STYLE,
  applyAxisOrigin,
  bathMeterGuideLabel,
  bathMeterGuideLabelFontMm,
  bathMeterGuideLines,
  orientPieceRect,
  type CutAxisOrigin,
} from '../../../shared/cut-geometry';
import {
  CUT_RENDER_STYLE_DEFAULT,
  cutRenderLabelFontWeight,
  cutRenderLabelLetterSpacingRatio,
  cutRenderLabelFillForBackground,
  cutRenderLabelLineSpecs,
  cutRenderNormalizeLabelLines,
  cutRenderPieceSizeLine,
  cutRenderLabelStrokeForBackground,
  cutRenderOrderFillPalette,
  cutRenderPositionLine,
  cutRenderSourceSvgCss,
  resolveCutRenderStyle,
  type CutRenderStyleRef,
} from '../../../shared/cut-render-style';
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
  /** Legacy input kept for compatibility. Copy ordinal is no longer printed in the piece label. */
  instance: number;
  /** Legacy input kept for compatibility. Quantity is no longer printed in the piece label. */
  qty: number;
  /** Legacy input kept for compatibility. Material is no longer printed in the piece label. */
  materialName?: string | null;
}

export interface BathPieceDetailInfo {
  edgeTypeName?: string | null;
  millingTypeName?: string | null;
  doweling?: boolean | null;
}

/**
 * Piece label lines shown inside every placed detail:
 * 1) order name (orders.order_name), falling back to the numeric order id when
 * the name is blank/unresolved, 2) order detail position,
 * 3) size (width x height). Material type/name is intentionally omitted.
 */
export function composePieceLabelLines(input: PieceLabelInput): string[] {
  const { orderId, orderName, detailId, detailNumber, widthMm, heightMm, itemId } = input;
  const orderLabel = orderName?.trim() || (orderId === null ? itemId : String(orderId));
  const position = detailNumber ?? detailId;
  const positionLabel = position === null
    ? '# —'
    : formatPositionLine(position);
  return [
    orderLabel,
    positionLabel,
    formatPieceSize(widthMm, heightMm),
  ];
}

function formatPositionLine(position: number): string {
  return cutRenderPositionLine(position);
}

function formatPieceSize(widthMm: number | null | undefined, heightMm: number | null | undefined): string {
  return cutRenderPieceSizeLine(widthMm, heightMm);
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

const DEFAULT_PIECE_STROKE = '#1f2d3d';
const BATH_ORDER_LABEL_COLOR = '#7f1d1d';
const BATH_POSITION_LABEL_COLOR = '#14532d';
const BATH_DIMENSION_FONT_ENLARGE_MIN_SIDE_MM = 150;
const BATH_DIMENSION_FONT_SCALE = 1.25;
const BATH_ORDER_FONT_SCALE = 4;
const BATH_DETAIL_META_FONT_SCALE = 2;
const BATH_DIMENSION_EDGE_INSET_RATIO = 0.55;
const BATH_DIMENSION_RESERVED_RATIO = 1.05;
const BATH_DETAIL_META_LINE_SPACING = 0.9;
const BATH_DETAIL_META_GLYPH_HEIGHT_RATIO = 0.75;
const BATH_CENTER_PREVIOUS_BASELINE_DISTANCE_RATIO = 1.1;
const BATH_CENTER_BASELINE_DISTANCE_SCALE = 0.8;
const BATH_ORDER_LABEL_WEIGHT = 900;
const BATH_ORDER_LABEL_STROKE_RATIO = 0.04;
const SOURCE_SVG_FRAGMENT_UNSAFE_RE = /<\s*(?:script|foreignObject)\b|\bon[a-z]+\s*=|\b(?:href|xlink:href)\s*=|(?:javascript:|data:|https?:|file:)/i;

/** Deterministic contour color for a source order. The historical function
 * name remains API-compatible with frozen render call sites. */
export function orderFillColor(orderId: number | null | undefined): string {
  if (typeof orderId !== 'number' || !Number.isFinite(orderId)) {
    return DEFAULT_PIECE_STROKE;
  }
  const palette = cutRenderOrderFillPalette(CUT_RENDER_STYLE_DEFAULT);
  const index = Math.abs(Math.trunc(orderId)) % palette.length;
  return palette[index] ?? DEFAULT_PIECE_STROKE;
}

/** Build a per-render color resolver from the orders present in one cut group.
 * Different source orders get different palette slots by first appearance, so
 * IDs like 11372 and 11292 do not collapse to the same `orderId % palette` color. */
export function createOrderFillResolver(
  orderIds: readonly number[],
  renderStyle: CutRenderStyleRef = CUT_RENDER_STYLE_DEFAULT,
): (orderId: number | null | undefined) => string {
  const indexByOrder = new Map<number, number>();
  const style = resolveCutRenderStyle(renderStyle);
  const palette = style.piece.orderPalette;
  for (const orderId of orderIds) {
    if (!Number.isFinite(orderId) || indexByOrder.has(orderId)) continue;
    indexByOrder.set(orderId, indexByOrder.size);
  }
  return (orderId) => {
    if (typeof orderId !== 'number' || !Number.isFinite(orderId)) {
      return style.piece.stroke;
    }
    const index = indexByOrder.get(orderId);
    return index === undefined ? style.piece.stroke : palette[index % palette.length] ?? style.piece.stroke;
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
  /** Extra labels printed only in the bath PDF miniature, at each piece's bottom-right. */
  bathDetailInfoFor?: (piece: FreecutPlacement) => BathPieceDetailInfo;
  /**
   * Optional per-piece order color. Kept as `fillFor` for frozen render API
   * compatibility; renderers apply it to contours, never to piece backgrounds.
   */
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
  /** Named visual rule for screen/Telegram-oriented renders. Defaults to print-safe legacy style. */
  renderStyle?: CutRenderStyleRef;
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
      )}" font-weight="${num(BATH_METER_GUIDE_STYLE.labelFontWeight)}" text-anchor="${label.textAnchor}" dominant-baseline="middle" pointer-events="none" style="font-variant-numeric:tabular-nums">${label.text}</text>`;
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

function bathMeterGuideViewBox(
  sheet: SheetPlacementsJson,
  landscape: boolean,
  labelFontMm: number,
): string {
  const { vw, vh } = orientPieceRect(
    { x: 0, y: 0, w: sheet.sheet_width_mm, h: sheet.sheet_height_mm },
    sheet.sheet_width_mm,
    sheet.sheet_height_mm,
    landscape,
  );
  const firstGuide = bathMeterGuideLines(
    sheet.sheet_width_mm,
    sheet.sheet_height_mm,
    landscape,
  )[0];
  if (!firstGuide) return `0 0 ${num(vw)} ${num(vh)}`;
  const labelsAbove = firstGuide.x1 === firstGuide.x2;
  const gutterMm = labelFontMm * (
    labelsAbove
      ? BATH_METER_GUIDE_OUTSIDE_TOP_GUTTER_RATIO
      : BATH_METER_GUIDE_OUTSIDE_LEFT_GUTTER_RATIO
  );
  return labelsAbove
    ? `0 ${num(-gutterMm)} ${num(vw)} ${num(vh + gutterMm)}`
    : `${num(-gutterMm)} 0 ${num(vw + gutterMm)} ${num(vh)}`;
}

function removeBathMeterGuideElements(svg: string): string {
  return svg
    .replace(/<text\b[^>]*class="cut-bath-meter-guide-label"[^>]*>[\s\S]*?<\/text>/g, '')
    .replace(/<line\b[^>]*class="cut-bath-meter-guide"[^>]*\/?\s*>/g, '');
}

function replaceSvgViewBox(svg: string, viewBox: string): string {
  return svg.replace(
    /(<svg\b[^>]*\bviewBox=)(["'])[^"']*\2/,
    (_match, prefix: string, quote: string) => `${prefix}${quote}${viewBox}${quote}`,
  );
}

/**
 * Adds the visible cut-job number above a rendered sheet. This decorates both
 * current and frozen SVGs, so every screen/Telegram consumer gets the same
 * heading without changing the PDF sheet renderer or persisted snapshots.
 */
export function addCutJobHeadingToSvg(
  svg: string,
  cutJobDisplayNumber: string | number | null | undefined,
): string {
  const displayNumber = cutJobDisplayNumber === null || cutJobDisplayNumber === undefined
    ? ''
    : String(cutJobDisplayNumber).trim();
  if (!displayNumber || svg.includes('class="cut-sheet-job-heading"')) return svg;

  const viewBoxMatch = svg.match(/<svg\b[^>]*\bviewBox=(["'])([^"']+)\1[^>]*>/);
  const values = viewBoxMatch?.[2]?.trim().split(/[\s,]+/).map(Number) ?? [];
  const [viewX, viewY, viewWidth, viewHeight] = values;
  if (
    values.length !== 4 ||
    ![viewX, viewY, viewWidth, viewHeight].every((value) => Number.isFinite(value)) ||
    viewWidth <= 0 ||
    viewHeight <= 0
  ) {
    return svg;
  }

  const pieceLabelFontMm = [...svg.matchAll(/<tspan\b[^>]*\bfont-size="([^"]+)"/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0)
    .reduce((largest, value) => Math.max(largest, value), 0);
  const declaredOrderFontMm = Number(svg.match(/\bdata-cut-order-label-font-mm="([^"]+)"/)?.[1]);
  const sheetBackground = svg.match(/<rect\b[^>]*\bfill="([^"]+)"/)?.[1] ?? '#ffffff';
  const minimumHeadingFontMm = Math.max(
    24,
    Math.round(Math.min(viewWidth, viewHeight) / 40),
    pieceLabelFontMm,
    Number.isFinite(declaredOrderFontMm) ? declaredOrderFontMm : 0,
  );
  const headingFontMm = Math.round(minimumHeadingFontMm * 1.15);
  const headingHeightMm = headingFontMm * 1.9;
  const headingViewY = viewY - headingHeightMm;
  const headingCenterY = viewY - headingHeightMm / 2;
  const headingCenterX = viewX + viewWidth / 2;
  const escapedDisplayNumber = escapeXml(displayNumber);
  const decoratedViewBox = `${num(viewX)} ${num(headingViewY)} ${num(viewWidth)} ${num(viewHeight + headingHeightMm)}`;
  const decorated = replaceSvgViewBox(svg, decoratedViewBox);
  const heading = [
    `<rect class="cut-sheet-job-heading-background" x="${num(viewX)}" y="${num(headingViewY)}" width="${num(viewWidth)}" height="${num(headingHeightMm)}" fill="${sheetBackground}"/>`,
    `<text class="cut-sheet-job-heading" data-cut-job-heading="${escapedDisplayNumber}" x="${num(headingCenterX)}" y="${num(headingCenterY)}" font-family="Liberation Sans, sans-serif" font-size="${num(headingFontMm)}" font-weight="400" fill="#111827" text-anchor="middle" dominant-baseline="middle">Раскрой №${escapedDisplayNumber}</text>`,
  ].join('');
  return decorated.replace(/(<svg\b[^>]*>)/, `$1${heading}`);
}

/** Adds guide overlays to an already rendered/frozen SVG, idempotently. */
export function addBathMeterGuidesToSvg(
  svg: string,
  sheet: SheetPlacementsJson,
  landscape: boolean,
): string {
  const labelFontMm = bathMeterGuideLabelFontMm(sheet.sheet_width_mm, sheet.sheet_height_mm);
  const overlay = renderBathMeterGuides(sheet, landscape, labelFontMm);
  if (!overlay) return svg;
  const upgraded = replaceSvgViewBox(
    removeBathMeterGuideElements(svg),
    bathMeterGuideViewBox(sheet, landscape, labelFontMm),
  );
  const closingTag = upgraded.lastIndexOf('</svg>');
  return closingTag < 0
    ? upgraded
    : `${upgraded.slice(0, closingTag)}${overlay}${upgraded.slice(closingTag)}`;
}

export function buildSheetSvg(input: BuildSheetSvgInput): string {
  const { sheet, labelFor, fillFor, rotate90 = false, showLabels = true, axisOrigin = 'top-left' } = input;
  const renderStyle = resolveCutRenderStyle(input.renderStyle);
  const originTopLeft = sheet.coordinate_contract === 'native_portrait_v1' ? false : (input.originTopLeft ?? false);
  const w = sheet.sheet_width_mm;
  const h = sheet.sheet_height_mm;
  const fontMm = input.labelFontMm ?? Math.max(24, Math.round(Math.min(w, h) / 40));
  const orderLabelFontMm = fontMm * renderStyle.label.orderFontRatio;

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
      const fill = renderStyle.piece.defaultFill;
      const stroke = fillFor?.(piece) ?? renderStyle.piece.stroke;
      const rectEl = `<rect x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.w)}" height="${num(
        rect.h,
      )}" fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="${num(renderStyle.piece.strokeWidthMm)}"/>`;
      const sourceSvgEl = renderPieceSourceSvgFragment(piece, rect, renderStyle, fill, stroke);
      if (!showLabels) {
        return renderPieceGroup(piece, cx, cy, [rectEl, sourceSvgEl].join(''));
      }
      const resolved = labelFor(piece);
      const lines = Array.isArray(resolved) ? resolved : [resolved];
      const labelFill = cutRenderLabelFillForBackground(fill, renderStyle);
      const labelStroke = cutRenderLabelStrokeForBackground(fill, fontMm, renderStyle);
      const labelStrokeAttrs = labelStroke
        ? ` stroke="${labelStroke.stroke}" stroke-width="${num(labelStroke.strokeWidthMm)}" paint-order="stroke"`
        : '';
      return renderPieceGroup(piece, cx, cy, [
        rectEl,
        sourceSvgEl,
        renderPieceLabelText({
          lines,
          cx,
          cy,
          fontMm,
          renderStyle,
          fontWeight: cutRenderLabelFontWeight(renderStyle),
          letterSpacingRatio: cutRenderLabelLetterSpacingRatio(renderStyle),
          fill: labelFill,
          strokeAttrs: labelStrokeAttrs,
        }),
      ].join(''));
    })
    .join('');
  const guideLabelFontMm = bathMeterGuideLabelFontMm(w, h, input.labelFontMm);
  const bathMeterGuides = input.showBathMeterGuides
    ? renderBathMeterGuides(sheet, rotate90, guideLabelFontMm)
    : '';
  const viewBox = input.showBathMeterGuides
    ? bathMeterGuideViewBox(sheet, rotate90, guideLabelFontMm)
    : `0 0 ${num(vbW)} ${num(vbH)}`;

  return [
    // viewBox only (no width/height attrs): the px size is chosen at raster time
    // via resvg fitTo; explicit width/height would make resvg ignore fitTo.
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" data-cut-order-label-font-mm="${num(orderLabelFontMm)}">`,
    `<rect x="0" y="0" width="${num(vbW)}" height="${num(vbH)}" fill="${escapeXml(renderStyle.piece.defaultFill)}" stroke="${escapeXml(renderStyle.piece.stroke)}" stroke-width="${num(renderStyle.piece.strokeWidthMm)}"/>`,
    pieces,
    bathMeterGuides,
    `</svg>`,
  ].join('');
}

function renderPieceLabelText(input: {
  lines: readonly string[];
  cx: number;
  cy: number;
  fontMm: number;
  renderStyle: CutRenderStyleRef;
  fontWeight: number;
  letterSpacingRatio: number;
  fill: string;
  strokeAttrs: string;
}): string {
  const specs = cutRenderLabelLineSpecs(input.lines, input.renderStyle);
  if (specs.length === 0) return '';
  const lineHeights = specs.map((spec) => input.fontMm * spec.fontRatio * 0.82);
  const gaps = specs.map((spec, index) => index < specs.length - 1 ? input.fontMm * spec.gapAfterRatio : 0);
  const totalHeight = lineHeights.reduce((sum, height, index) => sum + height + (gaps[index] ?? 0), 0);
  let top = input.cy - totalHeight / 2;
  const tspans = specs.map((spec, index) => {
    const fontSize = input.fontMm * spec.fontRatio;
    const lineHeight = lineHeights[index] ?? fontSize * 0.82;
    const y = top + lineHeight / 2;
    top += lineHeight + (gaps[index] ?? 0);
    return `<tspan x="${num(input.cx)}" y="${num(y)}" font-size="${num(fontSize)}">${escapeXml(spec.text)}</tspan>`;
  }).join('');
  const letterSpacing = input.fontMm * input.letterSpacingRatio;
  const letterSpacingAttr = letterSpacing === 0 ? '' : ` letter-spacing="${num(letterSpacing)}"`;
  return `<text x="${num(input.cx)}" y="${num(input.cy)}" font-family="Liberation Sans, sans-serif" font-size="${num(
    input.fontMm,
  )}" font-weight="${num(input.fontWeight)}"${letterSpacingAttr} fill="${input.fill}"${input.strokeAttrs} text-anchor="middle" dominant-baseline="middle">${tspans}</text>`;
}

function renderPieceSourceSvgFragment(
  piece: FreecutPlacement,
  rect: { x: number; y: number; w: number; h: number },
  renderStyle: CutRenderStyleRef = CUT_RENDER_STYLE_DEFAULT,
  pieceFill?: string | null,
  orderContour?: string | null,
): string {
  const source = (piece as {
    source_svg?: {
      viewBox?: {
        width_mm?: number | null;
        height_mm?: number | null;
      } | null;
      body?: string | null;
    } | null;
  }).source_svg;
  const width = source?.viewBox?.width_mm;
  const height = source?.viewBox?.height_mm;
  const body = source?.body?.trim();
  if (
    !body ||
    SOURCE_SVG_FRAGMENT_UNSAFE_RE.test(body) ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return '';
  }
  const css = cutRenderSourceSvgCss(renderStyle, pieceFill, orderContour);
  return [
    `<svg class="cut-sheet-piece-source-svg" x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.w)}" height="${num(rect.h)}" viewBox="0 0 ${num(width)} ${num(height)}" preserveAspectRatio="none" overflow="hidden">`,
    css ? `<style>${css}</style>` : '',
    body,
    '</svg>',
  ].join('');
}

export function buildBathProfileSheetSvg(input: BuildSheetSvgInput): string {
  const { sheet, labelFor, fillFor, rotate90 = false, axisOrigin = 'top-left' } = input;
  const renderStyle = resolveCutRenderStyle(input.renderStyle);
  const originTopLeft = sheet.coordinate_contract === 'native_portrait_v1' ? false : (input.originTopLeft ?? false);
  const w = sheet.sheet_width_mm;
  const h = sheet.sheet_height_mm;
  const fontMm = input.labelFontMm ?? Math.max(24, Math.round(Math.min(w, h) / 42));
  const detailFontMm = fontMm * BATH_ORDER_FONT_SCALE;
  const detailMetaFontMm = fontMm * BATH_DETAIL_META_FONT_SCALE;
  const baseSideFontMm = Math.max(18, Math.round(fontMm * 0.85));
  const { vw: vbW, vh: vbH } = orientPieceRect({ x: 0, y: 0, w, h }, w, h, rotate90, originTopLeft);

  const pieces = sheet.pieces
    .map((piece, pieceIndex) => {
      const x = sheet.trim_mm.left + piece.x_mm;
      const y = sheet.trim_mm.top + piece.y_mm;
      const rect = applyAxisOrigin(orientPieceRect({ x, y, w: piece.width_mm, h: piece.height_mm }, w, h, rotate90, originTopLeft), axisOrigin, rotate90);
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      const stroke = fillFor?.(piece) ?? renderStyle.piece.stroke;
      const rectEl = `<rect x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.w)}" height="${num(
        rect.h,
      )}" fill="${escapeXml(renderStyle.piece.defaultFill)}" stroke="${escapeXml(stroke)}" stroke-width="${num(renderStyle.piece.strokeWidthMm)}"/>`;

      const sideTexts: string[] = [];
      let reservedTop = 0;
      let reservedLeft = 0;
      const sideFontMm = bathDimensionBaseFont(rect.w, rect.h, baseSideFontMm) * BATH_DIMENSION_FONT_SCALE;
      const widthLabel = formatDimension(rect.w);
      const widthFont = fitBathSideFont(widthLabel, rect.w, rect.h, sideFontMm, 'horizontal');
      if (widthFont !== null) {
        reservedTop = widthFont * BATH_DIMENSION_RESERVED_RATIO;
        sideTexts.push(
          `<text x="${num(cx)}" y="${num(rect.y + widthFont * BATH_DIMENSION_EDGE_INSET_RATIO)}" font-family="Liberation Sans, sans-serif" font-size="${num(
            widthFont,
          )}" fill="#111111" text-anchor="middle" dominant-baseline="middle">${escapeXml(widthLabel)}</text>`,
        );
      }
      const heightLabel = formatDimension(rect.h);
      const heightFont = fitBathSideFont(heightLabel, rect.h, rect.w, sideFontMm, 'vertical');
      if (heightFont !== null) {
        reservedLeft = heightFont * BATH_DIMENSION_RESERVED_RATIO;
        const tx = rect.x + heightFont * BATH_DIMENSION_EDGE_INSET_RATIO;
        sideTexts.push(
          `<text x="${num(tx)}" y="${num(cy)}" transform="rotate(-90 ${num(tx)} ${num(
            cy,
          )})" font-family="Liberation Sans, sans-serif" font-size="${num(
            heightFont,
          )}" fill="#111111" text-anchor="middle" dominant-baseline="middle">${escapeXml(heightLabel)}</text>`,
        );
      }
      const labelBox = bathCenterLabelBox(rect, reservedTop, reservedLeft);
      const centerLabel = renderBathDetailCenterLabel({
        lines: labelFor(piece),
        cx: labelBox.cx,
        cy: labelBox.cy,
        rectW: labelBox.w,
        rectH: labelBox.h,
        baseFontMm: detailFontMm,
        compact: !shouldRenderBathCenterLabel(labelBox.w, labelBox.h),
      });
      const bathDetailInfo = input.bathDetailInfoFor?.(piece);
      const detailMeta = bathDetailInfo
        ? renderBathDetailMeta({
            info: bathDetailInfo,
            rect,
            fontMm: detailMetaFontMm,
            parallelToSheetShortSideMm: vbW <= vbH ? rect.w : rect.h,
            clipId: `cut-bath-detail-meta-${pieceIndex}`,
          })
        : '';

      return renderPieceGroup(piece, cx, cy, [rectEl, ...sideTexts, centerLabel.svg, detailMeta].join(''));
    })
    .join('');
  const guideLabelFontMm = bathMeterGuideLabelFontMm(w, h, input.labelFontMm);
  const bathMeterGuides = input.showBathMeterGuides
    ? renderBathMeterGuides(sheet, rotate90, guideLabelFontMm)
    : '';
  const viewBox = input.showBathMeterGuides
    ? bathMeterGuideViewBox(sheet, rotate90, guideLabelFontMm)
    : `0 0 ${num(vbW)} ${num(vbH)}`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">`,
    `<rect x="0" y="0" width="${num(vbW)}" height="${num(vbH)}" fill="${escapeXml(renderStyle.piece.defaultFill)}" stroke="${escapeXml(renderStyle.piece.stroke)}" stroke-width="${num(renderStyle.piece.strokeWidthMm)}"/>`,
    pieces,
    bathMeterGuides,
    `</svg>`,
  ].join('');
}

function renderBathDetailMeta(input: {
  info: BathPieceDetailInfo;
  rect: { x: number; y: number; w: number; h: number };
  fontMm: number;
  parallelToSheetShortSideMm: number;
  clipId: string;
}): string {
  const edge = input.info.edgeTypeName?.trim() || '—';
  const milling = input.info.millingTypeName?.trim() || '—';
  const lines = [edge, milling, ...(input.info.doweling === true ? ['присадка'] : [])];
  const fontMm = fitBathDetailMetaFont(
    lines,
    input.rect.w,
    input.rect.h,
    input.parallelToSheetShortSideMm,
    input.fontMm,
  );
  const padding = Math.max(3, fontMm * 0.16);
  const x = input.rect.x + input.rect.w - padding;
  const bottom = input.rect.y + input.rect.h - padding;
  return [
    `<clipPath id="${input.clipId}"><rect x="${num(input.rect.x)}" y="${num(input.rect.y)}" width="${num(input.rect.w)}" height="${num(input.rect.h)}"/></clipPath>`,
    `<text class="cut-bath-detail-meta" font-family="Liberation Sans, sans-serif" font-size="${num(fontMm)}" fill="#111111" text-anchor="end" data-corner="bottom-right" clip-path="url(#${input.clipId})">`,
    ...lines.map((line, index) => {
      const linesBelow = lines.length - index - 1;
      return `<tspan x="${num(x)}" y="${num(bottom - fontMm * BATH_DETAIL_META_LINE_SPACING * linesBelow)}">${escapeXml(line)}</tspan>`;
    }),
    '</text>',
  ].join('');
}

function fitBathDetailMetaFont(
  lines: readonly string[],
  rectW: number,
  rectH: number,
  parallelToSheetShortSideMm: number,
  requestedFontMm: number,
): number {
  const widestAtUnit = Math.max(...lines.map((line) => estimateTextWidthMm(line, 1)), 1);
  const widthFit = (rectW * 0.92) / widestAtUnit;
  const lineBlockUnits = Math.max(
    BATH_DETAIL_META_GLYPH_HEIGHT_RATIO,
    (lines.length - 1) * BATH_DETAIL_META_LINE_SPACING + BATH_DETAIL_META_GLYPH_HEIGHT_RATIO,
  );
  const heightFit = (rectH * 0.92) / lineBlockUnits;
  const occupiesHalfCrosswiseSide = requestedFontMm * lineBlockUnits
    >= parallelToSheetShortSideMm / 2 - 1e-6;
  const adaptiveStandard = occupiesHalfCrosswiseSide ? requestedFontMm / 2 : requestedFontMm;
  return Math.max(1, Math.min(adaptiveStandard, widthFit, heightFit));
}

function bathOrderLabelStyle(fontMm: number): string {
  return `fill="${BATH_ORDER_LABEL_COLOR}" font-weight="${BATH_ORDER_LABEL_WEIGHT}" stroke="${BATH_ORDER_LABEL_COLOR}" stroke-width="${num(
    fontMm * BATH_ORDER_LABEL_STROKE_RATIO,
  )}" paint-order="stroke"`;
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

function shouldRenderBathCenterLabel(rectW: number, rectH: number): boolean {
  return rectW >= 36 && rectH >= 18;
}

interface BathDetailCenterLabelRender {
  svg: string;
  orderFontMm: number | null;
}

function renderBathDetailCenterLabel(input: {
  lines: string | string[];
  cx: number;
  cy: number;
  rectW: number;
  rectH: number;
  baseFontMm: number;
  compact?: boolean;
}): BathDetailCenterLabelRender {
  const lines = (Array.isArray(input.lines) ? input.lines : [input.lines]).slice(0, 2).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return { svg: '', orderFontMm: null };
  if (lines.length === 1) {
    const font = fitBathLabelFont([lines[0]], input.rectW, input.rectH, input.baseFontMm, 1);
    return {
      svg: `<text x="${num(input.cx)}" y="${num(input.cy)}" font-family="Liberation Sans, sans-serif" font-size="${num(
        font,
      )}" ${bathOrderLabelStyle(font)} text-anchor="middle" dominant-baseline="middle">${escapeXml(lines[0])}</text>`,
      orderFontMm: font,
    };
  }

  const [orderLine, rawPositionLine] = lines;
  const positionLine = formatBathPositionLabel(rawPositionLine);
  if (input.compact) {
    return {
      svg: renderBathPositionLabel({
        label: positionLine,
        cx: input.cx,
        cy: input.cy,
        maxW: input.rectW,
        maxH: input.rectH,
        baseFontMm: input.baseFontMm * 0.8,
        rotate: input.rectW < input.rectH,
      }),
      orderFontMm: null,
    };
  }
  const font = fitBathLabelFont([orderLine, positionLine], input.rectW, input.rectH, input.baseFontMm, 2);
  const positionFont = font * 0.8;
  const fittedPositionFont = resolveBathPositionFont({
    label: positionLine,
    maxW: input.rectW,
    maxH: input.rectH / 2,
    baseFontMm: positionFont,
  }) ?? positionFont;
  const occupiedHalfHeights = (font + fittedPositionFont) / 2;
  const previousVisualGap = Math.max(
    0,
    font * BATH_CENTER_PREVIOUS_BASELINE_DISTANCE_RATIO - occupiedHalfHeights,
  );
  // Liberation Sans glyphs occupy less than the CSS font box. A 20% baseline
  // reduction halves the visible whitespace without overlapping both rows.
  const lineOffset = (
    (occupiedHalfHeights + previousVisualGap / 4)
    * BATH_CENTER_BASELINE_DISTANCE_SCALE
  ) / 2;
  return {
    svg: [
      `<text x="${num(input.cx)}" y="${num(input.cy - lineOffset)}" font-family="Liberation Sans, sans-serif" font-size="${num(
        font,
      )}" ${bathOrderLabelStyle(font)} text-anchor="middle" dominant-baseline="middle">${escapeXml(
        orderLine,
      )}</text>`,
      renderBathPositionLabel({
        label: positionLine,
        cx: input.cx,
        cy: input.cy + lineOffset,
        maxW: input.rectW,
        maxH: input.rectH / 2,
        baseFontMm: positionFont,
      }),
    ].join(''),
    orderFontMm: font,
  };
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
  const { marker, value } = bathPositionParts(input.label);
  const font = resolveBathPositionFont(input);
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

function bathPositionParts(label: string): { marker: string; value: string } {
  const match = /^#\s*(.+)$/.exec(label);
  return match ? { marker: '#', value: ` ${match[1]}` } : { marker: '', value: label };
}

function resolveBathPositionFont(input: {
  label: string;
  maxW: number;
  maxH: number;
  baseFontMm: number;
  rotate?: boolean;
}): number | null {
  const { marker, value } = bathPositionParts(input.label);
  const availableW = input.rotate ? input.maxH : input.maxW;
  const availableH = input.rotate ? input.maxW : input.maxH;
  return fitBathPositionFont(marker, value, availableW, availableH, input.baseFontMm);
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
