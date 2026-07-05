import type { LabelOcrTemplateInput, OcrFieldCode, OcrTemplateRule } from '../../../api/types/labelsApi.types';

/** RU labels for the OCR field picker/list — mirrors backend field semantics, no business logic. */
export const OCR_FIELD_LABELS_RU: Record<OcrFieldCode, string> = {
  order_number: 'Номер заказа',
  order_name: 'Имя заказа',
  detail_number: 'Номер позиции',
  dimensions: 'Размеры (Ш×В)',
  material: 'Материал',
  quantity: 'Количество',
  date: 'Дата',
  detail_name: 'Имя детали',
  ignore: 'Игнорировать',
};

/**
 * "Strong" fields carry enough signal on their own to help identify a label.
 * Mirrors the backend template-validity invariant (labels.service / DTO).
 */
export const OCR_STRONG_FIELDS: ReadonlySet<OcrFieldCode> = new Set([
  'order_number',
  'detail_number',
  'dimensions',
  'material',
  'quantity',
  'date',
]);

/** Fields that alone can discriminate between similar labels without needing an anchor. */
export const OCR_DISCRIMINANT_FIELDS: ReadonlySet<OcrFieldCode> = new Set(['dimensions', 'material']);

export function fieldLabelRu(field: OcrFieldCode): string {
  return OCR_FIELD_LABELS_RU[field];
}

export function isStrongFieldFe(field: OcrFieldCode): boolean {
  return OCR_STRONG_FIELDS.has(field);
}

/**
 * Mirror of the backend DTO invariant (see labels/dto/label-ocr-template.dto.ts) used to
 * disable Save and show an inline hint before a round trip to the server.
 * Returns null when the rule set is valid, otherwise a RU error message.
 */
export function validateOcrRulesFe(rules: OcrTemplateRule[]): string | null {
  const nonIgnoreRules = rules.filter((rule) => rule.field !== 'ignore');

  const strongCount = nonIgnoreRules.filter((rule) => isStrongFieldFe(rule.field)).length;
  if (strongCount < 2) {
    return 'Нужно минимум 2 распознаваемых поля';
  }

  const hasDiscriminantField = nonIgnoreRules.some((rule) => OCR_DISCRIMINANT_FIELDS.has(rule.field));
  const hasAnchor = rules.some((rule) => typeof rule.anchor === 'string' && rule.anchor.trim().length > 0);
  if (!hasDiscriminantField && !hasAnchor) {
    return 'Нужно поле-дискриминант: размеры/материал или якорь';
  }

  const seenFields = new Set<OcrFieldCode>();
  for (const rule of nonIgnoreRules) {
    if (seenFields.has(rule.field)) {
      return `Поле встречается дважды: ${fieldLabelRu(rule.field)}`;
    }
    seenFields.add(rule.field);
  }

  return null;
}

/**
 * Suggests an anchor string from a recognized line: the leading non-digit run
 * before the first digit, trimmed. Used to prefill the "Якорь" input when the
 * user opts a rule into anchor-matching — still editable afterwards.
 * Returns '' when the line has no digit at all, or starts with one (nothing
 * to anchor on before the numeric part).
 */
export function suggestAnchor(line: string): string {
  const match = line.match(/\d/);
  if (!match || match.index === undefined || match.index === 0) {
    return '';
  }
  return line.slice(0, match.index).trim();
}

/**
 * Builds the create/update payload from editor form state. Anchor is
 * normalized to null when blank so the backend always sees a nullish anchor
 * rather than an empty string (matches the DTO's nullable-anchor contract).
 */
export function buildOcrTemplateInput(state: {
  name: string;
  isActive: boolean;
  rules: OcrTemplateRule[];
  sampleLines: string[];
  idempotencyKey: string;
}): LabelOcrTemplateInput {
  return {
    name: state.name,
    isActive: state.isActive,
    idempotencyKey: state.idempotencyKey,
    sampleLines: state.sampleLines,
    rules: state.rules.map((rule) => ({
      field: rule.field,
      sampleText: rule.sampleText,
      anchor: rule.anchor && rule.anchor.trim().length > 0 ? rule.anchor : null,
    })),
  };
}

export interface NormalizedBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Converts a 4-point OCR box (pixel coordinates in a processed image of size
 * imgW×imgH) into a normalized bounding rect (0..1 fractions of the image
 * dimensions) suitable for drawing as a CSS-percentage overlay on top of the
 * displayed <img>. Returns null when the box is missing/malformed or the
 * image dimensions are not known/positive.
 */
export function normalizeBox(
  box: number[][] | undefined,
  imgW: number | undefined,
  imgH: number | undefined,
): NormalizedBox | null {
  if (!Array.isArray(box) || box.length === 0) return null;
  if (!(typeof imgW === 'number') || !(typeof imgH === 'number') || !(imgW > 0) || !(imgH > 0)) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of box) {
    if (!Array.isArray(point) || point.length < 2) return null;
    const [x, y] = point;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

  return {
    left: clamp01(minX / imgW),
    top: clamp01(minY / imgH),
    width: clamp01((maxX - minX) / imgW),
    height: clamp01((maxY - minY) / imgH),
  };
}

/** Distinct non-ignore field RU labels, in first-occurrence order — for the list column. */
export function summarizeFieldTags(rules: OcrTemplateRule[]): string[] {
  const seenFields = new Set<OcrFieldCode>();
  const tags: string[] = [];
  for (const rule of rules) {
    if (rule.field === 'ignore') continue;
    if (seenFields.has(rule.field)) continue;
    seenFields.add(rule.field);
    tags.push(fieldLabelRu(rule.field));
  }
  return tags;
}
