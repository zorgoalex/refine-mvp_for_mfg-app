import { describe, expect, it } from 'vitest';
import type { OcrFieldCode, OcrTemplateRule } from '../../../api/types/labelsApi.types';
import { fieldLabelRu, isStrongFieldFe, summarizeFieldTags, validateOcrRulesFe } from './ocrTemplateHelpers';

const ALL_FIELDS: OcrFieldCode[] = [
  'order_number',
  'order_name',
  'detail_number',
  'dimensions',
  'material',
  'quantity',
  'date',
  'detail_name',
  'ignore',
];

describe('ocrTemplateHelpers', () => {
  it('returns a non-empty distinct RU label for every field code', () => {
    const labels = ALL_FIELDS.map((field) => fieldLabelRu(field));
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0);
    }
    expect(new Set(labels).size).toBe(ALL_FIELDS.length);
  });

  it('classifies strong fields correctly', () => {
    expect(isStrongFieldFe('dimensions')).toBe(true);
    expect(isStrongFieldFe('material')).toBe(true);
    expect(isStrongFieldFe('order_number')).toBe(true);
    expect(isStrongFieldFe('detail_number')).toBe(true);
    expect(isStrongFieldFe('quantity')).toBe(true);
    expect(isStrongFieldFe('date')).toBe(true);

    expect(isStrongFieldFe('order_name')).toBe(false);
    expect(isStrongFieldFe('detail_name')).toBe(false);
    expect(isStrongFieldFe('ignore')).toBe(false);
  });

  describe('validateOcrRulesFe', () => {
    it('accepts order_number + material + dimensions (>=2 strong, has discriminant)', () => {
      const rules: OcrTemplateRule[] = [
        { field: 'order_number' },
        { field: 'material' },
        { field: 'dimensions' },
      ];
      expect(validateOcrRulesFe(rules)).toBeNull();
    });

    it('rejects a single strong field', () => {
      const rules: OcrTemplateRule[] = [{ field: 'order_number' }];
      expect(validateOcrRulesFe(rules)).toBe('Нужно минимум 2 распознаваемых поля');
    });

    it('rejects two non-discriminant strong fields with no anchor', () => {
      const rules: OcrTemplateRule[] = [{ field: 'order_number' }, { field: 'quantity' }];
      expect(validateOcrRulesFe(rules)).toBe('Нужно поле-дискриминант: размеры/материал или якорь');
    });

    it('accepts two non-discriminant strong fields when a rule carries an anchor', () => {
      const rules: OcrTemplateRule[] = [
        { field: 'order_number' },
        { field: 'quantity', anchor: 'кол-во:' },
      ];
      expect(validateOcrRulesFe(rules)).toBeNull();
    });

    it('rejects a duplicated non-ignore field', () => {
      const rules: OcrTemplateRule[] = [
        { field: 'order_number' },
        { field: 'order_number' },
        { field: 'material' },
      ];
      expect(validateOcrRulesFe(rules)).toBe('Поле встречается дважды: Номер заказа');
    });

    it('allows duplicated ignore rules', () => {
      const rules: OcrTemplateRule[] = [
        { field: 'order_number' },
        { field: 'material' },
        { field: 'ignore' },
        { field: 'ignore' },
      ];
      expect(validateOcrRulesFe(rules)).toBeNull();
    });
  });

  describe('summarizeFieldTags', () => {
    it('dedups fields and drops ignore', () => {
      const rules: OcrTemplateRule[] = [
        { field: 'order_number' },
        { field: 'ignore' },
        { field: 'material' },
        { field: 'order_number' },
        { field: 'dimensions' },
      ];
      expect(summarizeFieldTags(rules)).toEqual(['Номер заказа', 'Материал', 'Размеры (Ш×В)']);
    });

    it('returns an empty array when there are no non-ignore fields', () => {
      expect(summarizeFieldTags([{ field: 'ignore' }])).toEqual([]);
      expect(summarizeFieldTags([])).toEqual([]);
    });
  });
});
