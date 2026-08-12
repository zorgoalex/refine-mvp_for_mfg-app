import type {
  CncTelegramCutLayout,
  CncTelegramManualSvgUploadRequest,
} from '../../api/types/cncTelegramApi.types';

const DETAIL_HEADER_RE = /(?<order>\d{4,})#(?<detail>\d{1,5})#/;
const DETAIL_SIZE_RE = /@(?<width>\d+(?:[.,]\d+)?)\*(?<height>\d+(?:[.,]\d+)?)@/;
const NUMBER_RE = /-?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?/g;
const PATH_TOKEN_RE = /[MmLlHhVvCcSsQqTtAaZz]|-?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?/g;
const MATRIX_RE = /matrix\(([^)]+)\)/i;
const GEOMETRY_TAGS = new Set(['rect', 'polygon', 'polyline', 'path']);
const LAYOUT_BOUNDS_TOLERANCE_MM = 2;
const DETAIL_SIZE_TOLERANCE_MM = 8;

type Matrix = [number, number, number, number, number, number];
type Point = [number, number];
type Bbox = [number, number, number, number];

export interface ParsedSvgUpload {
  fileName: string;
  svgContentHash: string;
  cutLayout: CncTelegramCutLayout;
  items: CncTelegramManualSvgUploadRequest['items'];
}

export async function parseSvgCutUploadFile(file: File): Promise<ParsedSvgUpload> {
  const text = await file.text();
  const parsed = parseSvgCutUploadText(text, file.name);
  return {
    ...parsed,
    svgContentHash: await sha256Hex(text),
  };
}

export function parseSvgCutUploadText(text: string, fileName = 'upload.svg'): Omit<ParsedSvgUpload, 'svgContentHash'> {
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
    return invalid(['not an SVG file']);
  }
  if (typeof DOMParser === 'undefined') {
    return invalid(['DOMParser is unavailable in this browser']);
  }

  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    return invalid([`XML parse error: ${parseError.textContent?.trim() || 'invalid XML'}`]);
  }
  const root = doc.documentElement;
  if (!root || localName(root) !== 'svg') {
    return invalid(['missing SVG root element']);
  }

  const sheetWidth = parseMm(root.getAttribute('width'));
  const sheetHeight = parseMm(root.getAttribute('height'));
  const viewBox = parseViewBox(root.getAttribute('viewBox'));
  const partialSheet = sheetWidth && sheetHeight ? { widthMm: sheetWidth, heightMm: sheetHeight } : null;
  if (!sheetWidth || !sheetHeight || !viewBox) {
    return invalid(['missing root width/height mm or viewBox'], partialSheet);
  }

  const [vbMinX, vbMinY, vbWidth, vbHeight] = viewBox;
  if (sheetWidth <= 0 || sheetHeight <= 0 || vbWidth <= 0 || vbHeight <= 0) {
    return invalid(['invalid root width/height or viewBox'], partialSheet);
  }
  const scaleX = vbWidth / sheetWidth;
  const scaleY = vbHeight / sheetHeight;

  const layoutItems: CncTelegramCutLayout['items'] = [];
  const seenGeometry = new Set<string>();
  const rejected = new Set<string>();
  let rawCommentCount = 0;
  let partContourCount = 0;

  for (const { element, matrix } of traverse(root)) {
    if (!GEOMETRY_TAGS.has(localName(element))) continue;
    const elementId = element.getAttribute('id') ?? '';
    const comments = detailComments(element);
    rawCommentCount += comments.length;
    if (!elementId.includes('PartContour')) continue;

    partContourCount += 1;
    if (comments.length === 0) continue;

    const points = elementPoints(element).map((point) => applyMatrix(point, matrix));
    const bbox = pointsBbox(points);
    if (!bbox) {
      if (comments.some((comment) => parseDetailComment(comment, null))) {
        rejected.add('PartContour detail outlines have no geometry');
      }
      continue;
    }

    const xMm = (bbox[0] - vbMinX) / scaleX;
    const yMm = (bbox[1] - vbMinY) / scaleY;
    const placedWidthMm = Math.abs(bbox[2] - bbox[0]) / scaleX;
    const placedHeightMm = Math.abs(bbox[3] - bbox[1]) / scaleY;
    const parsedComments = comments
      .map((comment) => parseDetailComment(comment, [placedWidthMm, placedHeightMm]))
      .filter((comment): comment is ParsedDetailComment => comment !== null);
    if (parsedComments.length === 0) {
      rejected.add('PartContour detail outlines have unreadable detail comments');
      continue;
    }

    const insideSheet =
      xMm >= -LAYOUT_BOUNDS_TOLERANCE_MM &&
      yMm >= -LAYOUT_BOUNDS_TOLERANCE_MM &&
      xMm + placedWidthMm <= sheetWidth + LAYOUT_BOUNDS_TOLERANCE_MM &&
      yMm + placedHeightMm <= sheetHeight + LAYOUT_BOUNDS_TOLERANCE_MM;
    if (!insideSheet) {
      rejected.add('PartContour detail outlines outside sheet');
      continue;
    }

    let matchedComment = false;
    for (const parsed of parsedComments) {
      if (!sizeMatches(parsed.widthMm, parsed.heightMm, placedWidthMm, placedHeightMm)) continue;
      matchedComment = true;
      const key = [
        parsed.orderName,
        parsed.detailNumber,
        parsed.widthMm,
        parsed.heightMm,
        elementId,
      ].join('|');
      if (seenGeometry.has(key)) continue;
      seenGeometry.add(key);
      layoutItems.push({
        orderName: parsed.orderName,
        detailNumber: parsed.detailNumber,
        widthMm: parsed.widthMm,
        heightMm: parsed.heightMm,
        quantity: 1,
        confidence: 0.99,
        sourceElementId: elementId,
        xMm: round2(xMm),
        yMm: round2(yMm),
        placedWidthMm: round2(placedWidthMm),
        placedHeightMm: round2(placedHeightMm),
        rotated: Math.round(placedWidthMm) === Math.round(parsed.heightMm) &&
          Math.round(placedHeightMm) === Math.round(parsed.widthMm),
      });
    }
    if (!matchedComment) {
      rejected.add('PartContour detail outline size does not match detail comment');
    }
  }

  const reasons: string[] = [];
  if (rawCommentCount === 0) reasons.push('no detail comments');
  if (partContourCount === 0) reasons.push('no PartContour detail outlines');
  reasons.push(...Array.from(rejected).sort());
  if (partContourCount > 0 && layoutItems.length === 0) {
    reasons.push('PartContour outlines exist but no placed detail passed geometry checks');
  }

  const status = layoutItems.length > 0 && reasons.length === 0 ? 'valid' : 'invalid';
  const cutLayout: CncTelegramCutLayout = {
    status,
    reasons,
    sheet: { widthMm: round2(sheetWidth), heightMm: round2(sheetHeight) },
    rawCommentCount,
    partContourCount,
    acceptedItemCount: status === 'valid' ? layoutItems.length : 0,
    items: status === 'valid' ? layoutItems : [],
  };
  return {
    fileName,
    cutLayout,
    items: layoutItemsToRequestItems(cutLayout),
  };
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

function detailComments(element: Element): string[] {
  const values: string[] = [];
  for (const child of Array.from(element.querySelectorAll('*'))) {
    if (localName(child) !== 'odm') continue;
    if (child.getAttribute('name') !== 'Comments') continue;
    const value = child.getAttribute('value')?.trim();
    if (value) values.push(value);
  }
  return values;
}

interface ParsedDetailComment {
  orderName: string;
  detailNumber: number;
  widthMm: number;
  heightMm: number;
}

function parseDetailComment(comment: string, bboxSize: [number, number] | null): ParsedDetailComment | null {
  const header = DETAIL_HEADER_RE.exec(comment);
  if (!header?.groups) return null;
  const size = DETAIL_SIZE_RE.exec(comment);
  let width = positiveFloat(size?.groups?.width);
  let height = positiveFloat(size?.groups?.height);
  if ((!width || !height) && bboxSize) {
    width = round2(Math.max(...bboxSize));
    height = round2(Math.min(...bboxSize));
  }
  if (!width || !height) return null;
  return {
    orderName: header.groups.order,
    detailNumber: Number(header.groups.detail),
    widthMm: width,
    heightMm: height,
  };
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
    return parsePathPoints(element.getAttribute('d') ?? '');
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

function* traverse(element: Element, matrix: Matrix = identityMatrix()): Generator<{ element: Element; matrix: Matrix }> {
  const ownMatrix = parseMatrix(element.getAttribute('transform'));
  const current = ownMatrix ? composeMatrix(matrix, ownMatrix) : matrix;
  yield { element, matrix: current };
  for (const child of Array.from(element.children)) {
    yield* traverse(child, current);
  }
}

function identityMatrix(): Matrix {
  return [1, 0, 0, 1, 0, 0];
}

function composeMatrix(parent: Matrix, child: Matrix): Matrix {
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

function applyMatrix(point: Point, matrix: Matrix): Point {
  const [a, b, c, d, e, f] = matrix;
  const [x, y] = point;
  return [a * x + c * y + e, b * x + d * y + f];
}

function parseMatrix(value: string | null): Matrix | null {
  if (!value) return null;
  const match = MATRIX_RE.exec(value);
  if (!match?.[1]) return null;
  const numbers = numbersFrom(match[1]);
  return numbers.length === 6 ? [numbers[0], numbers[1], numbers[2], numbers[3], numbers[4], numbers[5]] : null;
}

function parsePoints(value: string): Point[] {
  const numbers = numbersFrom(value.replaceAll(',', ' '));
  const points: Point[] = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    points.push([numbers[index], numbers[index + 1]]);
  }
  return points;
}

function parsePathPoints(value: string): Point[] {
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
  const readPair = (relative: boolean): Point | null => {
    const left = readNumber();
    const right = readNumber();
    if (left === null || right === null) return null;
    return relative ? [x + left, y + right] : [left, right];
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
          for (let pairIndex = 0; pairIndex < pairsPerCommand; pairIndex += 1) {
            const pair = readPair(relative);
            if (!pair) return [];
            [x, y] = pair;
            points.push([x, y]);
          }
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
