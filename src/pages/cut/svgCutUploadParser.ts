import type {
  CncTelegramCutLayout,
  CncTelegramManualSvgUploadRequest,
} from '../../api/types/cncTelegramApi.types';

const VISUAL_SIZE_RE = /(?<width>\d+(?:[.,]\d+)?)\s*[xхХX*×]\s*(?<height>\d+(?:[.,]\d+)?)/;
const VISUAL_ORDER_RE = /\b(?<order>\d{4,})\b/;
const VISUAL_DETAIL_RE = /(?:поз\.?|позиция|дет\.?|деталь|#)?\s*(?<detail>\d{1,5})/i;
const NUMBER_RE = /-?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?/g;
const TRANSFORM_NUMBER_TOKEN_RE = /^\s*,?\s*(-?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?)/;
const PATH_TOKEN_RE = /[MmLlHhVvCcSsQqTtAaZz]|-?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?/g;
const TRANSFORM_RE = /([a-zA-Z]+)\(([^)]*)\)/g;
const GEOMETRY_TAGS = new Set(['rect', 'polygon', 'polyline', 'path']);
const LAYOUT_BOUNDS_TOLERANCE_MM = 2;
const DETAIL_SIZE_TOLERANCE_MM = 8;
const SHEET_OUTLINE_TOLERANCE_MM = 3;

export type SvgMatrix = [number, number, number, number, number, number];
export type SvgPoint = [number, number];
type Point = SvgPoint;
type Bbox = [number, number, number, number];

export interface PartContourGeometry {
  elementId: string;
  xMm: number;
  yMm: number;
  placedWidthMm: number;
  placedHeightMm: number;
}

interface VisualTextLine {
  text: string;
  xMm: number;
  yMm: number;
}

export interface VisualDetailLabel {
  key: string;
  orderName: string;
  detailNumber: number;
  widthMm: number | null;
  heightMm: number | null;
  hasExplicitSize: boolean;
  cxMm: number;
  cyMm: number;
  linePointsMm: SvgPoint[];
  rawLines: string[];
}

export interface ParsedSvgUpload {
  fileName: string;
  svgContentHash: string;
  cutLayout: CncTelegramCutLayout;
  items: CncTelegramManualSvgUploadRequest['items'];
}

export interface SvgCutUploadParseOptions {
  allowGeometryFallbackItems?: boolean;
  includeVisualLabelOnlyItems?: boolean;
  fallbackOrderName?: string | null;
  sheetWidthMm?: number | null;
  sheetHeightMm?: number | null;
}

export async function parseSvgCutUploadFile(
  file: File,
  options: SvgCutUploadParseOptions = {},
): Promise<ParsedSvgUpload> {
  const text = await file.text();
  const parsed = parseSvgCutUploadText(text, file.name, options);
  return {
    ...parsed,
    svgContentHash: await sha256Hex(text),
  };
}

export function parseSvgCutUploadText(
  text: string,
  fileName = 'upload.svg',
  options: SvgCutUploadParseOptions = {},
): Omit<ParsedSvgUpload, 'svgContentHash'> {
  const invalid = (reasons: string[], sheet: CncTelegramCutLayout['sheet'] = null): Omit<ParsedSvgUpload, 'svgContentHash'> => ({
    fileName,
    cutLayout: {
      status: 'invalid',
      reasons,
      sheet,
      rawCommentCount: 0,
      partContourCount: 0,
      acceptedItemCount: 0,
      items: [],
    },
    items: [],
  });

  if (!fileName.toLowerCase().endsWith('.svg')) {
    return invalid(['Файл должен быть SVG']);
  }
  if (typeof DOMParser === 'undefined') {
    return invalid(['Браузер не может разобрать SVG']);
  }

  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    return invalid([`Ошибка XML в SVG: ${parseError.textContent?.trim() || 'некорректный XML'}`]);
  }
  const root = doc.documentElement;
  if (!root || localName(root) !== 'svg') {
    return invalid(['В SVG нет корневого элемента <svg>']);
  }

  const sheetWidth = parseMm(root.getAttribute('width'));
  const sheetHeight = parseMm(root.getAttribute('height'));
  const viewBox = parseViewBox(root.getAttribute('viewBox'));
  const partialSheet = sheetWidth && sheetHeight ? { widthMm: sheetWidth, heightMm: sheetHeight } : null;
  if (!sheetWidth || !sheetHeight || !viewBox) {
    return invalid(['В SVG нет width/height в мм или viewBox'], partialSheet);
  }

  const [vbMinX, vbMinY, vbWidth, vbHeight] = viewBox;
  if (sheetWidth <= 0 || sheetHeight <= 0 || vbWidth <= 0 || vbHeight <= 0) {
    return invalid(['Некорректные размеры SVG или viewBox'], partialSheet);
  }
  const scaleX = vbWidth / sheetWidth;
  const scaleY = vbHeight / sheetHeight;

  const partContours: PartContourGeometry[] = [];
  const genericContours: PartContourGeometry[] = [];
  const rejectedPartContours = new Set<string>();
  const rejectedGenericContours = new Set<string>();
  const visualLabels = extractVisualDetailLabels(root, vbMinX, vbMinY, scaleX, scaleY);
  const rawCommentCount = visualLabels.length;
  const allowGenericGeometry = options.allowGeometryFallbackItems === true;

  for (const { element, matrix, transformError } of traverse(root)) {
    if (!GEOMETRY_TAGS.has(localName(element))) continue;
    if (hasIgnoredGeometryAncestor(element)) continue;
    const elementId = element.getAttribute('id') ?? '';
    const isPartContour = elementId.includes('PartContour');
    if (!isPartContour && !allowGenericGeometry) continue;
    const rejected = isPartContour ? rejectedPartContours : rejectedGenericContours;
    if (transformError) {
      rejected.add(transformError);
      continue;
    }

    const points = elementPoints(element).map((point) => applyMatrix(point, matrix));
    const bbox = pointsBbox(points);
    if (!bbox) {
      if (visualLabels.length > 0 || options.allowGeometryFallbackItems === true) {
        rejected.add(isPartContour ? 'Контуры деталей PartContour без геометрии' : 'Контуры деталей без геометрии');
      }
      continue;
    }

    const xMm = (bbox[0] - vbMinX) / scaleX;
    const yMm = (bbox[1] - vbMinY) / scaleY;
    const placedWidthMm = Math.abs(bbox[2] - bbox[0]) / scaleX;
    const placedHeightMm = Math.abs(bbox[3] - bbox[1]) / scaleY;
    const contour = {
      elementId: elementId || `${localName(element)}-${partContours.length + 1}`,
      xMm,
      yMm,
      placedWidthMm,
      placedHeightMm,
    };
    if (!isPartContour && !svgUploadGeometryIsInformationalDetailContour(
      contour,
      sheetWidth,
      sheetHeight,
      elementId,
      element.getAttribute('class') ?? '',
    )) {
      continue;
    }

    const insideSheet =
      xMm >= -LAYOUT_BOUNDS_TOLERANCE_MM &&
      yMm >= -LAYOUT_BOUNDS_TOLERANCE_MM &&
      xMm + placedWidthMm <= sheetWidth + LAYOUT_BOUNDS_TOLERANCE_MM &&
      yMm + placedHeightMm <= sheetHeight + LAYOUT_BOUNDS_TOLERANCE_MM;
    if (!insideSheet) {
      rejected.add(isPartContour ? 'Контуры деталей PartContour выходят за границы листа' : 'Контуры деталей выходят за границы листа');
      continue;
    }

    if (isPartContour) partContours.push(contour);
    else genericContours.push(contour);
  }

  const selectedContours = partContours.length > 0 || !allowGenericGeometry ? partContours : genericContours;
  const builtLayout = buildSvgUploadLayoutItemsFromContours(selectedContours, visualLabels, {
    ...options,
    sheetWidthMm,
    sheetHeightMm,
  });
  const rejected = new Set<string>();
  if (!allowGenericGeometry || selectedContours.length === 0) {
    for (const reason of rejectedPartContours) rejected.add(reason);
    if (allowGenericGeometry) {
      for (const reason of rejectedGenericContours) rejected.add(reason);
    }
  }
  for (const reason of builtLayout.rejected) rejected.add(reason);

  const reasons: string[] = [];
  if (visualLabels.length === 0 && options.allowGeometryFallbackItems !== true) {
    reasons.push('Не найдены читаемые верхние подписи деталей: заказ / позиция / размер');
  }
  if (visualLabels.length > 0 && builtLayout.layoutItems.length === 0) {
    reasons.push(allowGenericGeometry
      ? 'Верхние подписи деталей найдены, но ни одна не сопоставилась с контуром детали'
      : 'Верхние подписи деталей найдены, но ни одна не сопоставилась с контуром PartContour');
  }
  const reportContourCount = selectedContours.length;
  if (reportContourCount === 0) {
    reasons.push(allowGenericGeometry
      ? 'В SVG нет контуров деталей: нужны PartContour или обычные rect/path/polygon/polyline с геометрией'
      : 'В SVG нет контуров деталей PartContour');
  }
  reasons.push(...Array.from(rejected).sort());
  if (reportContourCount > 0 && builtLayout.layoutItems.length === 0) {
    reasons.push(allowGenericGeometry
      ? 'Контуры деталей есть, но ни одна деталь не прошла проверку геометрии'
      : 'Контуры PartContour есть, но ни одна деталь не прошла проверку геометрии');
  }

  const status = builtLayout.layoutItems.length > 0 && reasons.length === 0 ? 'valid' : 'invalid';
  const cutLayout: CncTelegramCutLayout = {
    status,
    reasons,
    sheet: { widthMm: round2(sheetWidth), heightMm: round2(sheetHeight) },
    rawCommentCount,
    partContourCount: reportContourCount,
    acceptedItemCount: builtLayout.layoutItems.length,
    items: builtLayout.layoutItems,
  };
  return {
    fileName,
    cutLayout,
    items: layoutItemsToRequestItems(cutLayout),
  };
}

export function buildSvgUploadLayoutItemsFromContours(
  contours: PartContourGeometry[],
  visualLabels: VisualDetailLabel[],
  options: SvgCutUploadParseOptions = {},
): { layoutItems: CncTelegramCutLayout['items']; rejected: string[] } {
  const layoutItems: CncTelegramCutLayout['items'] = [];
  const rejected = new Set<string>();
  const seenGeometry = new Set<string>();
  const visualMatches = visualLabels.length > 0
    ? matchVisualLabelsToPartContours(contours, visualLabels)
    : new Map<PartContourGeometry, VisualDetailLabel>();
  const usedVisualLabels = new Set<VisualDetailLabel>();

  for (const [index, contour] of contours.entries()) {
    const parsed = visualMatches.get(contour);
    if (!parsed) {
      if (options.allowGeometryFallbackItems === true) {
        const fallback = fallbackLayoutItemFromContour(contour, index, options.fallbackOrderName);
        const key = [
          fallback.orderName,
          fallback.detailNumber,
          fallback.widthMm,
          fallback.heightMm,
          fallback.sourceElementId ?? index,
        ].join('|');
        if (seenGeometry.has(key)) continue;
        seenGeometry.add(key);
        layoutItems.push(fallback);
      } else if (visualLabels.length > 0) {
        rejected.add('Для контура детали PartContour не найдена верхняя подпись с заказом/позицией');
      }
      continue;
    }
    usedVisualLabels.add(parsed);
    const resolvedSize = resolveVisualLabelSize(parsed, contour);
    const key = [
      parsed.orderName,
      parsed.detailNumber,
      resolvedSize.widthMm,
      resolvedSize.heightMm,
      contour.elementId,
    ].join('|');
    if (seenGeometry.has(key)) continue;
    seenGeometry.add(key);
    layoutItems.push({
      orderName: parsed.orderName,
      detailNumber: parsed.detailNumber,
      widthMm: resolvedSize.widthMm,
      heightMm: resolvedSize.heightMm,
      quantity: 1,
      confidence: parsed.hasExplicitSize ? 0.99 : 0.82,
      sourceElementId: contour.elementId,
      xMm: round2(contour.xMm),
      yMm: round2(contour.yMm),
      placedWidthMm: round2(contour.placedWidthMm),
      placedHeightMm: round2(contour.placedHeightMm),
      rotated: Math.round(contour.placedWidthMm) === Math.round(resolvedSize.heightMm) &&
        Math.round(contour.placedHeightMm) === Math.round(resolvedSize.widthMm),
    });
  }

  if (options.includeVisualLabelOnlyItems === true) {
    const labelOnlyItems = buildVisualLabelOnlyLayoutItems(
      visualLabels.filter((label) => !usedVisualLabels.has(label)),
      layoutItems.length,
      options,
    );
    for (const item of labelOnlyItems.layoutItems) {
      const key = [
        item.orderName,
        item.detailNumber,
        item.widthMm,
        item.heightMm,
        item.sourceElementId ?? layoutItems.length,
      ].join('|');
      if (seenGeometry.has(key)) continue;
      seenGeometry.add(key);
      layoutItems.push(item);
    }
    for (const reason of labelOnlyItems.rejected) rejected.add(reason);
  }

  return { layoutItems, rejected: Array.from(rejected).sort() };
}

function buildVisualLabelOnlyLayoutItems(
  labels: VisualDetailLabel[],
  startIndex: number,
  options: SvgCutUploadParseOptions,
): { layoutItems: CncTelegramCutLayout['items']; rejected: string[] } {
  const layoutItems: CncTelegramCutLayout['items'] = [];
  const rejected = new Set<string>();
  for (const [offset, label] of labels.entries()) {
    if (!label.hasExplicitSize || label.widthMm === null || label.heightMm === null) {
      rejected.add(`Для верхней подписи ${label.orderName} #${label.detailNumber} не найден контур детали и нет размера`);
      continue;
    }
    const index = startIndex + offset;
    const placedWidthMm = round2(label.widthMm);
    const placedHeightMm = round2(label.heightMm);
    const xMm = labelOnlyCoordinate(label.cxMm - placedWidthMm / 2, placedWidthMm, options.sheetWidthMm);
    const yMm = labelOnlyCoordinate(label.cyMm - placedHeightMm / 2, placedHeightMm, options.sheetHeightMm);
    layoutItems.push({
      orderName: label.orderName,
      detailNumber: label.detailNumber,
      widthMm: placedWidthMm,
      heightMm: placedHeightMm,
      quantity: 1,
      confidence: 0.88,
      sourceElementId: `visual-label-${index + 1}-${sanitizeSourceElementId(label.key)}`,
      xMm,
      yMm,
      placedWidthMm,
      placedHeightMm,
      rotated: false,
    });
    rejected.add(`Для верхней подписи ${label.orderName} #${label.detailNumber} не найден контур детали; деталь создана по подписи`);
  }
  return { layoutItems, rejected: Array.from(rejected).sort() };
}

function labelOnlyCoordinate(value: number, sizeMm: number, sheetSizeMm: number | null | undefined): number {
  if (!Number.isFinite(value)) return 0;
  if (!sheetSizeMm || sheetSizeMm <= 0) return round2(Math.max(0, value));
  return round2(Math.min(Math.max(0, value), Math.max(0, sheetSizeMm - sizeMm)));
}

function sanitizeSourceElementId(value: string): string {
  return value.replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 180);
}

export function svgUploadGeometryIsInformationalDetailContour(
  contour: PartContourGeometry,
  sheetWidthMm: number,
  sheetHeightMm: number,
  elementId = '',
  className = '',
): boolean {
  if (
    contour.placedWidthMm <= 0 ||
    contour.placedHeightMm <= 0 ||
    !Number.isFinite(contour.xMm) ||
    !Number.isFinite(contour.yMm) ||
    !Number.isFinite(contour.placedWidthMm) ||
    !Number.isFinite(contour.placedHeightMm)
  ) {
    return false;
  }
  const coversSheet =
    Math.abs(contour.xMm) <= SHEET_OUTLINE_TOLERANCE_MM &&
    Math.abs(contour.yMm) <= SHEET_OUTLINE_TOLERANCE_MM &&
    Math.abs(contour.placedWidthMm - sheetWidthMm) <= SHEET_OUTLINE_TOLERANCE_MM * 2 &&
    Math.abs(contour.placedHeightMm - sheetHeightMm) <= SHEET_OUTLINE_TOLERANCE_MM * 2;
  if (!coversSheet) return true;

  const marker = `${elementId} ${className}`.toLowerCase();
  return Boolean(elementId.trim()) && !/(sheet|border|ramka|лист|str0)/i.test(marker);
}

function fallbackLayoutItemFromContour(
  contour: PartContourGeometry,
  index: number,
  fallbackOrderName: string | null | undefined,
): CncTelegramCutLayout['items'][number] {
  const orderName = normalizeFallbackOrderName(fallbackOrderName);
  return {
    orderName,
    detailNumber: index + 1,
    widthMm: round2(contour.placedWidthMm),
    heightMm: round2(contour.placedHeightMm),
    quantity: 1,
    confidence: 0.72,
    sourceElementId: contour.elementId || `PartContour-${index + 1}`,
    xMm: round2(contour.xMm),
    yMm: round2(contour.yMm),
    placedWidthMm: round2(contour.placedWidthMm),
    placedHeightMm: round2(contour.placedHeightMm),
    rotated: false,
  };
}

function normalizeFallbackOrderName(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 64) : 'SVG';
}

function layoutItemsToRequestItems(layout: CncTelegramCutLayout): CncTelegramManualSvgUploadRequest['items'] {
  return layout.items.map((item, index) => ({
    sourceItemKey: [
      item.orderName,
      item.detailNumber,
      item.widthMm,
      item.heightMm,
      item.sourceElementId ?? index,
    ].join(':'),
    orderName: item.orderName,
    detailNumber: item.detailNumber,
    widthMm: item.widthMm,
    heightMm: item.heightMm,
    quantity: item.quantity,
    source: 'vector',
    confidence: item.confidence ?? 0.99,
  }));
}

function extractVisualDetailLabels(
  root: Element,
  vbMinX: number,
  vbMinY: number,
  scaleX: number,
  scaleY: number,
): VisualDetailLabel[] {
  return groupVisualDetailLabels(collectVisualTextLines(root, vbMinX, vbMinY, scaleX, scaleY));
}

function collectVisualTextLines(
  root: Element,
  vbMinX: number,
  vbMinY: number,
  scaleX: number,
  scaleY: number,
): VisualTextLine[] {
  const lines: VisualTextLine[] = [];
  for (const { element, matrix, transformError } of traverse(root)) {
    if (transformError || localName(element) !== 'text') continue;
    lines.push(...textElementLines(element, matrix, vbMinX, vbMinY, scaleX, scaleY));
  }
  return lines;
}

function textElementLines(
  element: Element,
  matrix: SvgMatrix,
  vbMinX: number,
  vbMinY: number,
  scaleX: number,
  scaleY: number,
): VisualTextLine[] {
  const rawLines = splitTextElementLines(element);
  return rawLines.flatMap((line) => {
    const normalized = normalizeVisualText(line.text);
    if (!normalized) return [];
    const point = applyMatrix([line.x, line.y], matrix);
    return [{
      text: normalized,
      xMm: round2((point[0] - vbMinX) / scaleX),
      yMm: round2((point[1] - vbMinY) / scaleY),
    }];
  });
}

function splitTextElementLines(element: Element): Array<{ text: string; x: number; y: number }> {
  const tspans = Array.from(element.children).filter((child) => localName(child) === 'tspan');
  const parentX = coordinateAttr(element, 'x') ?? 0;
  const parentY = coordinateAttr(element, 'y') ?? 0;
  if (tspans.length === 0) {
    return [{ text: element.textContent ?? '', x: parentX, y: parentY }];
  }

  const lines: Array<{ text: string; x: number; y: number }> = [];
  let x = parentX;
  let y = parentY;
  let current: { text: string; x: number; y: number } | null = null;

  for (const tspan of tspans) {
    const text = tspan.textContent ?? '';
    const explicitX = coordinateAttr(tspan, 'x');
    const explicitY = coordinateAttr(tspan, 'y');
    const dx = coordinateAttr(tspan, 'dx');
    const dy = coordinateAttr(tspan, 'dy');
    const startsNewLine = current === null ||
      explicitX !== null ||
      explicitY !== null ||
      (dy !== null && Math.abs(dy) > 0.001);

    if (explicitX !== null) x = explicitX;
    else if (dx !== null) x += dx;
    if (explicitY !== null) y = explicitY;
    else if (dy !== null) y += dy;

    if (startsNewLine) {
      if (current) lines.push(current);
      current = { text, x, y };
    } else if (current) {
      current.text += text;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function groupVisualDetailLabels(lines: VisualTextLine[]): VisualDetailLabel[] {
  const sorted = [...lines].sort((left, right) => left.yMm - right.yMm || left.xMm - right.xMm);
  const labels: VisualDetailLabel[] = [];

  for (const sizeLine of sorted) {
    const size = parseVisualSizeLine(sizeLine.text);
    if (!size) continue;
    const maxXDelta = Math.max(35, Math.min(180, Math.max(size.widthMm, size.heightMm) * 0.35));
    const maxYDelta = Math.max(20, Math.min(220, Math.max(size.widthMm, size.heightMm) * 0.35));
    const upper = sorted
      .filter((line) =>
        line.yMm < sizeLine.yMm &&
        sizeLine.yMm - line.yMm <= maxYDelta &&
        Math.abs(line.xMm - sizeLine.xMm) <= maxXDelta,
      )
      .sort((left, right) => right.yMm - left.yMm);
    const detailLine = upper.find((line) => parseVisualDetailLine(line.text) !== null);
    if (!detailLine) continue;
    const orderLine = upper
      .filter((line) => line.yMm < detailLine.yMm)
      .find((line) => parseVisualOrderLine(line.text) !== null);
    if (!orderLine) continue;
    const orderName = parseVisualOrderLine(orderLine.text);
    const detailNumber = parseVisualDetailLine(detailLine.text);
    if (!orderName || detailNumber === null) continue;

    labels.push({
      key: `${orderName}:${detailNumber}:${size.widthMm}:${size.heightMm}:${round2(sizeLine.xMm)}:${round2(sizeLine.yMm)}`,
      orderName,
      detailNumber,
      widthMm: size.widthMm,
      heightMm: size.heightMm,
      hasExplicitSize: true,
      cxMm: round2((orderLine.xMm + detailLine.xMm + sizeLine.xMm) / 3),
      cyMm: round2((orderLine.yMm + detailLine.yMm + sizeLine.yMm) / 3),
      linePointsMm: [
        [orderLine.xMm, orderLine.yMm],
        [detailLine.xMm, detailLine.yMm],
        [sizeLine.xMm, sizeLine.yMm],
      ],
      rawLines: [orderLine.text, detailLine.text, sizeLine.text],
    });
  }

  for (const detailLine of sorted) {
    const detailNumber = parseVisualDetailLine(detailLine.text);
    if (detailNumber === null) continue;
    const orderLine = findVisualOrderLineForDetail(sorted, detailLine);
    if (!orderLine) continue;
    const orderName = parseVisualOrderLine(orderLine.text);
    if (!orderName) continue;
    if (hasExplicitVisualLabelNear(labels, orderName, detailNumber, orderLine, detailLine)) continue;

    labels.push({
      key: `${orderName}:${detailNumber}:no-size:${round2(detailLine.xMm)}:${round2(detailLine.yMm)}`,
      orderName,
      detailNumber,
      widthMm: null,
      heightMm: null,
      hasExplicitSize: false,
      cxMm: round2((orderLine.xMm + detailLine.xMm) / 2),
      cyMm: round2((orderLine.yMm + detailLine.yMm) / 2),
      linePointsMm: [
        [orderLine.xMm, orderLine.yMm],
        [detailLine.xMm, detailLine.yMm],
      ],
      rawLines: [orderLine.text, detailLine.text],
    });
  }

  return dedupeVisualLabels(labels);
}

function findVisualOrderLineForDetail(lines: VisualTextLine[], detailLine: VisualTextLine): VisualTextLine | null {
  return lines
    .filter((line) =>
      line.yMm < detailLine.yMm &&
      detailLine.yMm - line.yMm <= 160 &&
      Math.abs(line.xMm - detailLine.xMm) <= 260 &&
      parseVisualOrderLine(line.text) !== null,
    )
    .sort((left, right) => right.yMm - left.yMm || Math.abs(left.xMm - detailLine.xMm) - Math.abs(right.xMm - detailLine.xMm))[0] ?? null;
}

function hasExplicitVisualLabelNear(
  labels: VisualDetailLabel[],
  orderName: string,
  detailNumber: number,
  orderLine: VisualTextLine,
  detailLine: VisualTextLine,
): boolean {
  const cxMm = (orderLine.xMm + detailLine.xMm) / 2;
  const cyMm = (orderLine.yMm + detailLine.yMm) / 2;
  return labels.some((label) =>
    label.hasExplicitSize &&
    label.orderName === orderName &&
    label.detailNumber === detailNumber &&
    Math.abs(label.cxMm - cxMm) <= 260 &&
    Math.abs(label.cyMm - cyMm) <= 180,
  );
}

function parseVisualOrderLine(text: string): string | null {
  const match = VISUAL_ORDER_RE.exec(text);
  return match?.groups?.order ?? null;
}

function parseVisualDetailLine(text: string): number | null {
  if (parseVisualSizeLine(text) || parseVisualOrderLine(text)) return null;
  const match = VISUAL_DETAIL_RE.exec(text);
  const parsed = positiveFloat(match?.groups?.detail);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

function parseVisualSizeLine(text: string): { widthMm: number; heightMm: number } | null {
  const match = VISUAL_SIZE_RE.exec(text.replace(/\s+/g, ''));
  const widthMm = positiveFloat(match?.groups?.width);
  const heightMm = positiveFloat(match?.groups?.height);
  return widthMm && heightMm ? { widthMm, heightMm } : null;
}

function dedupeVisualLabels(labels: VisualDetailLabel[]): VisualDetailLabel[] {
  const seen = new Set<string>();
  const out: VisualDetailLabel[] = [];
  for (const label of labels) {
    if (seen.has(label.key)) continue;
    seen.add(label.key);
    out.push(label);
  }
  return out;
}

export function matchVisualLabelsToPartContours(
  contours: PartContourGeometry[],
  labels: VisualDetailLabel[],
): Map<PartContourGeometry, VisualDetailLabel> {
  const matches = new Map<PartContourGeometry, VisualDetailLabel>();
  const usedLabels = new Set<VisualDetailLabel>();
  const orderedContours = [...contours].sort((left, right) =>
    (left.placedWidthMm * left.placedHeightMm) - (right.placedWidthMm * right.placedHeightMm),
  );

  for (const contour of orderedContours) {
    const match = labels
      .filter((label) => !usedLabels.has(label))
      .map((label) => ({ label, score: visualLabelContourScore(label, contour) }))
      .filter((candidate) => candidate.score !== null)
      .sort((left, right) => Number(left.score) - Number(right.score))[0];
    if (!match) continue;
    matches.set(contour, match.label);
    usedLabels.add(match.label);
  }

  return matches;
}

function visualLabelContourScore(label: VisualDetailLabel, contour: PartContourGeometry): number | null {
  const center = contourCenter(contour);
  const distance = Math.hypot(label.cxMm - center[0], label.cyMm - center[1]);
  const points = label.linePointsMm.length > 0 ? label.linePointsMm : [[label.cxMm, label.cyMm] as Point];
  const insideTolerance = Math.max(10, Math.min(contour.placedWidthMm, contour.placedHeightMm) * 0.2);
  const nearTolerance = Math.max(35, Math.min(220, Math.min(contour.placedWidthMm, contour.placedHeightMm) * 0.45));
  const minContourDistance = Math.min(...points.map(([x, y]) => pointDistanceToContour(x, y, contour)));
  const inside = points.some(([x, y]) => pointInsideContour(x, y, contour, insideTolerance)) ||
    pointInsideContour(label.cxMm, label.cyMm, contour, insideTolerance);
  const maxCenterDistance = Math.max(80, Math.hypot(contour.placedWidthMm, contour.placedHeightMm) * 0.85);
  const sizeDelta = visualLabelContourSizeDelta(label, contour);
  const positionOk = inside || minContourDistance <= nearTolerance || distance <= maxCenterDistance;
  if (!positionOk) return null;

  if (
    label.hasExplicitSize &&
    sizeDelta > Math.max(120, Math.min(contour.placedWidthMm, contour.placedHeightMm) * 0.5) &&
    !inside &&
    minContourDistance > nearTolerance * 0.5
  ) {
    return null;
  }

  const sizePenalty = label.hasExplicitSize && sizeDelta > DETAIL_SIZE_TOLERANCE_MM
    ? Math.min(sizeDelta, 200) * 3
    : 0;
  return minContourDistance * 3 + distance * 0.2 + sizePenalty + (inside ? 0 : 25) + (label.hasExplicitSize ? 0 : 40);
}

function contourCenter(contour: PartContourGeometry): Point {
  return [
    contour.xMm + contour.placedWidthMm / 2,
    contour.yMm + contour.placedHeightMm / 2,
  ];
}

function pointInsideContour(x: number, y: number, contour: PartContourGeometry, toleranceMm: number): boolean {
  return x >= contour.xMm - toleranceMm &&
    y >= contour.yMm - toleranceMm &&
    x <= contour.xMm + contour.placedWidthMm + toleranceMm &&
    y <= contour.yMm + contour.placedHeightMm + toleranceMm;
}

function pointDistanceToContour(x: number, y: number, contour: PartContourGeometry): number {
  const dx = Math.max(contour.xMm - x, 0, x - (contour.xMm + contour.placedWidthMm));
  const dy = Math.max(contour.yMm - y, 0, y - (contour.yMm + contour.placedHeightMm));
  return Math.hypot(dx, dy);
}

function visualLabelContourSizeDelta(label: VisualDetailLabel, contour: PartContourGeometry): number {
  if (!label.hasExplicitSize || label.widthMm === null || label.heightMm === null) return 0;
  const expected = [label.widthMm, label.heightMm].sort((a, b) => a - b);
  const actual = [contour.placedWidthMm, contour.placedHeightMm].sort((a, b) => a - b);
  return Math.max(Math.abs(expected[0] - actual[0]), Math.abs(expected[1] - actual[1]));
}

function resolveVisualLabelSize(
  label: VisualDetailLabel,
  contour: PartContourGeometry,
): { widthMm: number; heightMm: number } {
  if (label.hasExplicitSize && label.widthMm !== null && label.heightMm !== null) {
    return { widthMm: label.widthMm, heightMm: label.heightMm };
  }
  return {
    widthMm: round2(Math.max(contour.placedWidthMm, contour.placedHeightMm)),
    heightMm: round2(Math.min(contour.placedWidthMm, contour.placedHeightMm)),
  };
}

function coordinateAttr(element: Element, name: string): number | null {
  const values = numbersFrom(element.getAttribute(name) ?? '');
  return values[0] ?? null;
}

function normalizeVisualText(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function elementPoints(element: Element): Point[] {
  const tag = localName(element);
  if (tag === 'rect') {
    const x = floatAttr(element, 'x') ?? 0;
    const y = floatAttr(element, 'y') ?? 0;
    const width = floatAttr(element, 'width');
    const height = floatAttr(element, 'height');
    if (!width || !height || width <= 0 || height <= 0) return [];
    return [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
  }
  if (tag === 'polygon' || tag === 'polyline') {
    return parsePoints(element.getAttribute('points') ?? '');
  }
  if (tag === 'path') {
    return parseSvgPathPointsForUpload(element.getAttribute('d') ?? '');
  }
  return [];
}

function pointsBbox(points: Point[]): Bbox | null {
  if (points.length === 0) return null;
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function parseViewBox(value: string | null): Bbox | null {
  const numbers = numbersFrom(value ?? '');
  return numbers.length >= 4 ? [numbers[0], numbers[1], numbers[2], numbers[3]] : null;
}

function* traverse(
  element: Element,
  matrix: SvgMatrix = identityMatrix(),
  inheritedTransformError: string | null = null,
): Generator<{ element: Element; matrix: SvgMatrix; transformError: string | null }> {
  const ownTransform = parseSvgTransformList(element.getAttribute('transform'));
  const transformError = inheritedTransformError ?? ownTransform.error;
  const current = ownTransform.error ? matrix : composeMatrix(matrix, ownTransform.matrix);
  yield { element, matrix: current, transformError };
  for (const child of Array.from(element.children)) {
    yield* traverse(child, current, transformError);
  }
}

function identityMatrix(): SvgMatrix {
  return [1, 0, 0, 1, 0, 0];
}

function composeMatrix(parent: SvgMatrix, child: SvgMatrix): SvgMatrix {
  const [pa, pb, pc, pd, pe, pf] = parent;
  const [ca, cb, cc, cd, ce, cf] = child;
  return [
    pa * ca + pc * cb,
    pb * ca + pd * cb,
    pa * cc + pc * cd,
    pb * cc + pd * cd,
    pa * ce + pc * cf + pe,
    pb * ce + pd * cf + pf,
  ];
}

function applyMatrix(point: Point, matrix: SvgMatrix): Point {
  const [a, b, c, d, e, f] = matrix;
  const [x, y] = point;
  return [a * x + c * y + e, b * x + d * y + f];
}

export function applySvgMatrixToPoint(point: SvgPoint, matrix: SvgMatrix): SvgPoint {
  return applyMatrix(point, matrix);
}

export function parseSvgTransformList(value: string | null): { matrix: SvgMatrix; error: string | null } {
  const raw = value?.trim();
  if (!raw) return { matrix: identityMatrix(), error: null };

  let cursor = 0;
  let matched = false;
  let current = identityMatrix();
  TRANSFORM_RE.lastIndex = 0;

  for (const match of raw.matchAll(TRANSFORM_RE)) {
    const matchIndex = match.index ?? 0;
    const between = raw.slice(cursor, matchIndex);
    if (between.trim().replaceAll(',', '') !== '') {
      return { matrix: identityMatrix(), error: 'Неподдерживаемый синтаксис SVG transform' };
    }
    matched = true;
    cursor = matchIndex + match[0].length;

    const numbers = transformNumbers(match[2]);
    if (!numbers) {
      return { matrix: identityMatrix(), error: `Неподдерживаемый SVG transform: ${match[1]}` };
    }
    const transform = transformMatrix(match[1], numbers);
    if (!transform) {
      return { matrix: identityMatrix(), error: `Неподдерживаемый SVG transform: ${match[1]}` };
    }
    current = composeMatrix(transform, current);
  }

  if (!matched || raw.slice(cursor).trim().replaceAll(',', '') !== '') {
    return { matrix: identityMatrix(), error: 'Неподдерживаемый синтаксис SVG transform' };
  }
  return { matrix: current, error: null };
}

function transformMatrix(name: string, numbers: number[]): SvgMatrix | null {
  const op = name.toLowerCase();
  if (op === 'matrix') {
    return numbers.length === 6 ? [numbers[0], numbers[1], numbers[2], numbers[3], numbers[4], numbers[5]] : null;
  }
  if (op === 'translate') {
    if (numbers.length < 1 || numbers.length > 2) return null;
    return [1, 0, 0, 1, numbers[0], numbers[1] ?? 0];
  }
  if (op === 'scale') {
    if (numbers.length < 1 || numbers.length > 2) return null;
    return [numbers[0], 0, 0, numbers[1] ?? numbers[0], 0, 0];
  }
  if (op === 'rotate') {
    if (numbers.length !== 1 && numbers.length !== 3) return null;
    const angle = (numbers[0] * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rotation: SvgMatrix = [cos, sin, -sin, cos, 0, 0];
    if (numbers.length === 1) return rotation;
    const [cx, cy] = [numbers[1], numbers[2]];
    return composeMatrix(translationMatrix(cx, cy), composeMatrix(rotation, translationMatrix(-cx, -cy)));
  }
  if (op === 'skewx') {
    if (numbers.length !== 1) return null;
    return [1, 0, Math.tan((numbers[0] * Math.PI) / 180), 1, 0, 0];
  }
  if (op === 'skewy') {
    if (numbers.length !== 1) return null;
    return [1, Math.tan((numbers[0] * Math.PI) / 180), 0, 1, 0, 0];
  }
  return null;
}

function translationMatrix(x: number, y: number): SvgMatrix {
  return [1, 0, 0, 1, x, y];
}

function transformNumbers(value: string): number[] | null {
  const numbers: number[] = [];
  let rest = value;
  while (rest.trim() !== '') {
    const match = TRANSFORM_NUMBER_TOKEN_RE.exec(rest);
    if (!match?.[1]) return null;
    const parsed = parseFloatValue(match[1]);
    if (parsed === null) return null;
    numbers.push(parsed);
    rest = rest.slice(match[0].length);
  }
  return numbers;
}

function parsePoints(value: string): Point[] {
  const numbers = numbersFrom(value.replaceAll(',', ' '));
  const points: Point[] = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    points.push([numbers[index], numbers[index + 1]]);
  }
  return points;
}

export function parseSvgPathPointsForUpload(value: string): Point[] {
  const tokens = value.replaceAll(',', ' ').match(PATH_TOKEN_RE) ?? [];
  const points: Point[] = [];
  let index = 0;
  let command: string | null = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;

  const isCommand = (token: string) => token.length === 1 && /[A-Za-z]/.test(token);
  const readNumber = () => {
    if (index >= tokens.length || isCommand(tokens[index])) return null;
    const number = parseFloatValue(tokens[index]);
    index += 1;
    return number;
  };
  const readPair = (relative: boolean, baseX = x, baseY = y): Point | null => {
    const left = readNumber();
    const right = readNumber();
    if (left === null || right === null) return null;
    return relative ? [baseX + left, baseY + right] : [left, right];
  };

  while (index < tokens.length) {
    if (isCommand(tokens[index])) {
      command = tokens[index];
      index += 1;
    }
    if (!command) return [];
    const relative = command === command.toLowerCase();
    const op = command.toUpperCase();

    if (op === 'Z') {
      x = startX;
      y = startY;
      points.push([x, y]);
      command = null;
      continue;
    }

    let consumed = false;
    if (op === 'M') {
      let first = true;
      while (index < tokens.length && !isCommand(tokens[index])) {
        const pair = readPair(relative);
        if (!pair) return [];
        [x, y] = pair;
        if (first) {
          startX = x;
          startY = y;
          first = false;
        }
        points.push([x, y]);
        consumed = true;
      }
      command = relative ? 'l' : 'L';
    } else if (op === 'L') {
      while (index < tokens.length && !isCommand(tokens[index])) {
        const pair = readPair(relative);
        if (!pair) return [];
        [x, y] = pair;
        points.push([x, y]);
        consumed = true;
      }
    } else if (op === 'H' || op === 'V') {
      while (index < tokens.length && !isCommand(tokens[index])) {
        const number = readNumber();
        if (number === null) return [];
        if (op === 'H') x = relative ? x + number : number;
        if (op === 'V') y = relative ? y + number : number;
        points.push([x, y]);
        consumed = true;
      }
    } else if (op === 'C' || op === 'S' || op === 'Q' || op === 'T' || op === 'A') {
      const pairsPerCommand = op === 'C' ? 3 : op === 'S' || op === 'Q' ? 2 : op === 'T' ? 1 : 0;
      while (index < tokens.length && !isCommand(tokens[index])) {
        if (op === 'A') {
          const values = Array.from({ length: 7 }, readNumber);
          if (values.some((number) => number === null)) return [];
          x = relative ? x + Number(values[5]) : Number(values[5]);
          y = relative ? y + Number(values[6]) : Number(values[6]);
          points.push([x, y]);
        } else {
          const baseX = x;
          const baseY = y;
          const commandPoints: Point[] = [];
          for (let pairIndex = 0; pairIndex < pairsPerCommand; pairIndex += 1) {
            const pair = readPair(relative, baseX, baseY);
            if (!pair) return [];
            commandPoints.push(pair);
            points.push(pair);
          }
          [x, y] = commandPoints[commandPoints.length - 1];
        }
        consumed = true;
      }
    } else {
      return [];
    }
    if (!consumed && index < tokens.length && !isCommand(tokens[index])) return [];
  }
  return points;
}

function floatAttr(element: Element, name: string): number | null {
  return parseFloatValue(element.getAttribute(name));
}

function positiveFloat(value: string | null | undefined): number | null {
  const parsed = parseFloatValue(value ?? null);
  return parsed !== null && parsed > 0 ? round2(parsed) : null;
}

function parseMm(value: string | null): number | null {
  const match = (value ?? '').match(NUMBER_RE);
  const parsed = match?.[0] ? parseFloatValue(match[0]) : null;
  return parsed !== null ? round3(parsed) : null;
}

function parseFloatValue(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function numbersFrom(value: string): number[] {
  const matches = value.match(NUMBER_RE) ?? [];
  return matches
    .map((match) => parseFloatValue(match))
    .filter((number): number is number => number !== null);
}

function sizeMatches(
  declaredWidth: number,
  declaredHeight: number,
  placedWidth: number,
  placedHeight: number,
): boolean {
  const expected = [declaredWidth, declaredHeight].sort((a, b) => a - b);
  const actual = [placedWidth, placedHeight].sort((a, b) => a - b);
  return Math.max(Math.abs(expected[0] - actual[0]), Math.abs(expected[1] - actual[1])) <= DETAIL_SIZE_TOLERANCE_MM;
}

function hasIgnoredGeometryAncestor(element: Element): boolean {
  let current = element.parentElement;
  while (current) {
    if (['defs', 'font', 'glyph', 'missing-glyph', 'text', 'tspan', 'metadata', 'style'].includes(localName(current))) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function localName(element: Element): string {
  return element.localName || element.tagName.split(':').pop() || element.tagName;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
