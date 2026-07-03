import type { LabelTemplateElement } from '../../../api/types/labelsApi.types';

export type QrChip = { kind: 'field'; fieldId: string } | { kind: 'text'; text: string };

// Static text must not contain the separator or brace chars, otherwise the flat
// `join('|')` / `split('|')` + `{field}` regex round-trip would silently mutate
// content on edit/reload. The UI filters input with this; the helper strips defensively.
export const QR_TEXT_FORBIDDEN = /[|{}]/g;
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
