import type { OcrFieldCode, OcrTemplateRule } from '../../../api/types/labelsApi.types';

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
