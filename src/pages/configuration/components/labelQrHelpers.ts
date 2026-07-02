import type { LabelTemplateElement } from '../../../api/types/labelsApi.types';

export interface LabelCanvasBounds {
  widthMm: number;
  heightMm: number;
}

export interface LabelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface QrConflict {
  elementKey: string;
  conflictKey: string;
  reason: 'edge' | 'locked' | 'blocked' | 'overlap';
  otherElementKey?: string;
}

export interface AutoShiftForQrInput {
  qr: LabelTemplateElement;
  elements: LabelTemplateElement[];
  canvas: LabelCanvasBounds;
}

export interface AutoShiftForQrResult {
  elements: LabelTemplateElement[];
  conflicts: QrConflict[];
}

const QR_QUIET_ZONE_RATIO = 0.1;
const MIN_QR_SIDE_MM = 8;
const MIN_ELEMENT_SIDE_MM = 0.1;
const LINE_HIT_HEIGHT_MM = 1;

export function qrTemplateOf(element: LabelTemplateElement): string {
  const value = element.style?.qrTemplate;
  return typeof value === 'string' ? value : '';
}

export function qrErrorCorrectionOf(element: LabelTemplateElement): 'L' | 'M' | 'Q' | 'H' {
  const value = element.style?.qrErrorCorrection;
  return value === 'L' || value === 'Q' || value === 'H' ? value : 'M';
}

export function qrSideOf(element: LabelTemplateElement): number {
  const width = Number(element.widthMm ?? 0);
  const height = Number(element.heightMm ?? 0);
  return Math.max(MIN_QR_SIDE_MM, width, height);
}

export function qrProtectedRect(element: LabelTemplateElement): LabelRect {
  const side = qrSideOf(element);
  const quiet = side * QR_QUIET_ZONE_RATIO;
  return {
    x: Number(element.xMm ?? 0) - quiet,
    y: Number(element.yMm ?? 0) - quiet,
    width: side + quiet * 2,
    height: side + quiet * 2,
  };
}

export function elementRect(element: LabelTemplateElement): LabelRect {
  if (element.kind === 'qr') return qrProtectedRect(element);
  const width = Math.max(MIN_ELEMENT_SIDE_MM, Math.abs(Number(element.widthMm ?? 0)));
  const rawHeight = Math.abs(Number(element.heightMm ?? 0));
  const height = Math.max(element.kind === 'line' ? LINE_HIT_HEIGHT_MM : MIN_ELEMENT_SIDE_MM, rawHeight);
  return {
    x: Number(element.xMm ?? 0),
    y: Number(element.yMm ?? 0),
    width,
    height,
  };
}

export function extractQrTemplateFieldIds(template: string): string[] {
  const ids = new Set<string>();
  for (const match of template.matchAll(/\{([^{}]+)\}/g)) {
    const fieldId = match[1]?.trim();
    if (fieldId) ids.add(fieldId);
  }
  return Array.from(ids);
}

export function renderQrTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{([^{}]+)\}/g, (_match, fieldId: string) => {
    const value = values[fieldId.trim()];
    return value === null || value === undefined ? '' : String(value);
  });
}

export function autoShiftForQr({ qr, elements, canvas }: AutoShiftForQrInput): AutoShiftForQrResult {
  const qrElement = normalizeQrElement(qr);
  const nextElements = elements.map((element) =>
    element.elementKey === qrElement.elementKey ? qrElement : element,
  );
  if (!nextElements.some((element) => element.elementKey === qrElement.elementKey)) {
    nextElements.push(qrElement);
  }

  const qrRect = qrProtectedRect(qrElement);
  const conflicts: QrConflict[] = [];
  if (!rectInsideCanvas(qrRect, canvas)) {
    conflicts.push({
      elementKey: qrElement.elementKey,
      conflictKey: `edge:${qrElement.elementKey}`,
      reason: 'edge',
    });
  }

  const movable = nextElements.filter((element) => element.elementKey !== qrElement.elementKey);
  const moved = new Map<string, LabelTemplateElement>();

  for (const element of movable) {
    const current = moved.get(element.elementKey) ?? element;
    if (!rectsOverlap(elementRect(current), qrRect)) continue;
    if (isQrShiftLocked(current)) {
      conflicts.push({
        elementKey: qrElement.elementKey,
        conflictKey: `locked:${current.elementKey}`,
        reason: 'locked',
        otherElementKey: current.elementKey,
      });
      continue;
    }
    const shifted = findShortestValidShift(current, qrRect, nextElements, moved, canvas, qrElement.elementKey);
    if (!shifted) {
      conflicts.push({
        elementKey: qrElement.elementKey,
        conflictKey: `blocked:${current.elementKey}`,
        reason: 'blocked',
        otherElementKey: current.elementKey,
      });
      continue;
    }
    moved.set(current.elementKey, shifted);
  }

  if (conflicts.length > 0) {
    return { elements, conflicts };
  }

  return {
    elements: nextElements.map((element) => moved.get(element.elementKey) ?? element),
    conflicts: [],
  };
}

export function collectQrConflicts(elements: LabelTemplateElement[], canvas: LabelCanvasBounds): QrConflict[] {
  const conflicts: QrConflict[] = [];
  const qrElements = elements.filter((element) => element.kind === 'qr');
  for (const qr of qrElements) {
    const qrRect = qrProtectedRect(qr);
    if (!rectInsideCanvas(qrRect, canvas)) {
      conflicts.push({
        elementKey: qr.elementKey,
        conflictKey: `edge:${qr.elementKey}`,
        reason: 'edge',
      });
    }
    for (const other of elements) {
      if (other.elementKey === qr.elementKey) continue;
      if (!rectsOverlap(qrRect, elementRect(other))) continue;
      conflicts.push({
        elementKey: qr.elementKey,
        conflictKey: `overlap:${qr.elementKey}:${other.elementKey}`,
        reason: 'overlap',
        otherElementKey: other.elementKey,
      });
    }
  }
  return conflicts;
}

function normalizeQrElement(qr: LabelTemplateElement): LabelTemplateElement {
  const side = qrSideOf(qr);
  return {
    ...qr,
    kind: 'qr',
    sourceField: null,
    staticText: null,
    widthMm: side,
    heightMm: side,
    style: {
      ...(qr.style ?? {}),
      qrErrorCorrection: qrErrorCorrectionOf(qr),
    },
  };
}

function isQrShiftLocked(element: LabelTemplateElement): boolean {
  return Boolean(element.style?.locked);
}

function findShortestValidShift(
  element: LabelTemplateElement,
  qrRect: LabelRect,
  allElements: LabelTemplateElement[],
  moved: Map<string, LabelTemplateElement>,
  canvas: LabelCanvasBounds,
  qrElementKey: string,
): LabelTemplateElement | null {
  const rect = elementRect(element);
  const candidates = [
    { dx: qrRect.x - (rect.x + rect.width), dy: 0 },
    { dx: qrRect.x + qrRect.width - rect.x, dy: 0 },
    { dx: 0, dy: qrRect.y - (rect.y + rect.height) },
    { dx: 0, dy: qrRect.y + qrRect.height - rect.y },
  ]
    .filter((candidate) => candidate.dx !== 0 || candidate.dy !== 0)
    .sort((a, b) => Math.abs(a.dx) + Math.abs(a.dy) - (Math.abs(b.dx) + Math.abs(b.dy)));

  for (const candidate of candidates) {
    const shifted = {
      ...element,
      xMm: roundMm(Number(element.xMm ?? 0) + candidate.dx),
      yMm: roundMm(Number(element.yMm ?? 0) + candidate.dy),
    };
    const shiftedRect = elementRect(shifted);
    if (!rectInsideCanvas(shiftedRect, canvas)) continue;
    if (rectsOverlap(shiftedRect, qrRect)) continue;
    if (createsElementCollision(shifted, allElements, moved, qrElementKey)) continue;
    return shifted;
  }
  return null;
}

function createsElementCollision(
  shifted: LabelTemplateElement,
  allElements: LabelTemplateElement[],
  moved: Map<string, LabelTemplateElement>,
  qrElementKey: string,
): boolean {
  const rect = elementRect(shifted);
  for (const other of allElements) {
    if (other.elementKey === shifted.elementKey || other.elementKey === qrElementKey) continue;
    const otherElement = moved.get(other.elementKey) ?? other;
    if (rectsOverlap(rect, elementRect(otherElement))) return true;
  }
  return false;
}

function rectInsideCanvas(rect: LabelRect, canvas: LabelCanvasBounds): boolean {
  return rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.width <= Number(canvas.widthMm ?? 0) &&
    rect.y + rect.height <= Number(canvas.heightMm ?? 0);
}

function rectsOverlap(a: LabelRect, b: LabelRect): boolean {
  return a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y;
}

function roundMm(value: number): number {
  return Math.round(value * 10) / 10;
}
