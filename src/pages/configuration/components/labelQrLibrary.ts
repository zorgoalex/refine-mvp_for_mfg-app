import type { LabelTemplateElement } from '../../../api/types/labelsApi.types';

export type QrChip = { kind: 'field'; fieldId: string } | { kind: 'text'; text: string };
export type QrRow = QrChip[];

// Static text must not contain braces or newlines, otherwise parsing + round-trip
// would silently mutate content on edit/reload. Pipe (|) is allowed as literal text.
// The UI filters input with this; the helper strips defensively.
export const QR_TEXT_FORBIDDEN = /[{}\n]/g;
export function sanitizeQrText(text: string): string {
  return text.replace(QR_TEXT_FORBIDDEN, '');
}

export function chipsToTemplate(chips: QrChip[], separator = '|'): string {
  return chips
    .map((c) => (c.kind === 'field' ? `{${c.fieldId}}` : sanitizeQrText(c.text)))
    .join(separator);
}

export function templateToChips(template: string, separator = '|'): QrChip[] {
  if (!template) return [];
  return template.split(separator).map((part): QrChip => {
    const m = part.match(/^\{([^{}]+)\}$/);
    return m ? { kind: 'field', fieldId: m[1].trim() } : { kind: 'text', text: part };
  });
}

export function rowsToTemplate(rows: QrRow[]): string {
  // Convert each row to its template string by concatenating chips (no separator).
  // Field chips become {fieldId}, text chips become sanitizeQrText(text).
  // Join rows with newline. Drop trailing fully-empty rows.
  const rowStrings = rows.map((row) => {
    return row
      .map((c) => (c.kind === 'field' ? `{${c.fieldId}}` : sanitizeQrText(c.text)))
      .join('');
  });

  // Drop trailing empty row strings
  while (rowStrings.length > 0 && rowStrings[rowStrings.length - 1] === '') {
    rowStrings.pop();
  }

  return rowStrings.join('\n');
}

export function templateToRows(template: string): QrRow[] {
  if (!template) return [];
  const lines = template.split('\n');
  return lines.map((line): QrRow => {
    if (!line) return [];
    const chips: QrChip[] = [];
    let lastIndex = 0;

    // Match all {fieldId} patterns in the line
    const fieldRegex = /\{([^{}]+)\}/g;
    let match;
    while ((match = fieldRegex.exec(line)) !== null) {
      // Add any literal text before this field
      if (match.index > lastIndex) {
        const literalText = line.substring(lastIndex, match.index);
        chips.push({ kind: 'text', text: literalText });
      }
      // Add the field chip
      chips.push({ kind: 'field', fieldId: match[1].trim() });
      lastIndex = fieldRegex.lastIndex;
    }

    // Add any remaining literal text after the last field
    if (lastIndex < line.length) {
      const literalText = line.substring(lastIndex);
      chips.push({ kind: 'text', text: literalText });
    }

    return chips;
  });
}

export function uniqueQrName(base: string, existingNames: string[]): string {
  // Case-insensitive + trimmed to match the backend contract
  // (validateQrElementNames lowercases): 'QR' and 'qr' must collide.
  const norm = (v: string) => v.trim().toLowerCase();
  const taken = new Set(existingNames.map(norm));
  if (!taken.has(norm(base))) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base} ${i}`;
    if (!taken.has(norm(candidate))) return candidate;
  }
}

export function collectDuplicateQrNames(elements: LabelTemplateElement[]): string[] {
  // Case-insensitive to match the backend validateQrElementNames contract.
  const seen = new Map<string, { name: string; count: number }>();
  for (const el of elements) {
    if (el.kind !== 'qr') continue;
    const raw = String((el.style as Record<string, unknown> | undefined)?.qrName ?? '').trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    const entry = seen.get(key) ?? { name: raw, count: 0 };
    entry.count += 1;
    seen.set(key, entry);
  }
  return [...seen.values()].filter((e) => e.count > 1).map((e) => e.name);
}

// Pre-existing qr elements (saved before qrName existed) have no name; the
// backend's validateQrElementNames now 422s LABEL_QR_NAME_REQUIRED on save.
// Surface this client-side before hitting the server. Returned positions are
// 1-based, counted among qr elements only (matches how the save-error message
// references "QR without a name").
export function collectEmptyQrNames(elements: LabelTemplateElement[]): number[] {
  const positions: number[] = [];
  let qrIndex = 0;
  for (const el of elements) {
    if (el.kind !== 'qr') continue;
    qrIndex += 1;
    const raw = String((el.style as Record<string, unknown> | undefined)?.qrName ?? '').trim();
    if (!raw) positions.push(qrIndex);
  }
  return positions;
}

export function qrDraftFromElement(element: LabelTemplateElement): { name: string; contentTemplate: string; errorCorrection: 'L' | 'M' | 'Q' | 'H'; defaultSizeMm: number } {
  const style = (element.style ?? {}) as Record<string, unknown>;
  const ec = style.qrErrorCorrection;
  return {
    name: String(style.qrName ?? '').trim() || 'QR',
    contentTemplate: String(style.qrTemplate ?? ''),
    errorCorrection: ec === 'L' || ec === 'Q' || ec === 'H' ? ec : 'M',
    defaultSizeMm: Math.max(8, Number(element.widthMm ?? element.heightMm ?? 20)),
  };
}

export function qrElementFromLibrary(
  src: { name: string; contentTemplate: string; errorCorrection: 'L' | 'M' | 'Q' | 'H'; defaultSizeMm: number; sourceTemplateId?: number },
  xMm: number,
  yMm: number,
  existing: LabelTemplateElement[],
): LabelTemplateElement {
  const existingNames = existing
    .filter((e) => e.kind === 'qr')
    .map((e) => String((e.style as Record<string, unknown> | undefined)?.qrName ?? ''));
  const side = Math.max(8, src.defaultSizeMm);
  const style: Record<string, unknown> = {
    qrName: uniqueQrName(src.name, existingNames),
    qrTemplate: src.contentTemplate,
    qrErrorCorrection: src.errorCorrection,
  };
  if (src.sourceTemplateId != null) style.qrSourceTemplateId = src.sourceTemplateId;
  return {
    elementKey: `qr-${xMm}-${yMm}-${existing.length}`,
    kind: 'qr',
    sourceField: null,
    staticText: null,
    xMm,
    yMm,
    widthMm: side,
    heightMm: side,
    rotationDeg: 0,
    zIndex: existing.length,
    style,
    condition: {},
  };
}
