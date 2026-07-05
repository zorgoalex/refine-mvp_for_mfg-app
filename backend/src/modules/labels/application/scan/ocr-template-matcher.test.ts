import { describe, expect, it } from 'vitest';
import {
  matchesMaterial,
  parseDetailNumber,
  parseDimensions,
  parseOrderNumber,
} from './label-text-extraction';
import { matchOcrTemplates, type OcrTemplateForMatch } from './ocr-template-matcher';

describe('OCR helper primitives', () => {
  it('parseDimensions parses a plain "width x height" line', () => {
    expect(parseDimensions('649 X238')).toEqual({ width: 649, height: 238 });
    expect(parseDimensions('no size here')).toBeNull();
  });

  it('matchesMaterial tolerates lowercase ЛДСП with intervening words (no mm captured)', () => {
    expect(matchesMaterial('лДСп Дуб Гарден 16мм')).toBe('ЛДСП');
  });

  it('parseOrderNumber extracts digits from a tolerant whole line', () => {
    expect(parseOrderNumber('671')).toBe('671');
    expect(parseOrderNumber('Зак 671')).toBe('671');
  });

  it('parseDetailNumber rejects out-of-range values', () => {
    expect(parseDetailNumber('3')).toBe(3);
    expect(parseDetailNumber('40000')).toBeNull();
  });
});

describe('matchOcrTemplates', () => {
  const realizaciaLines = [
    '671',
    'Реал.Маикудык00.00.17',
    'лДСп Дуб Гарден 16мм',
    'P.P. 649 X238',
    '649',
    'X',
    '238',
  ];
  const realizaciaTemplate: OcrTemplateForMatch = {
    id: 1,
    name: 'Реализация',
    rules: [{ field: 'order_number' }, { field: 'order_name' }, { field: 'material' }, { field: 'dimensions' }],
  };

  it('1. matches the «Реализация» format and extracts fields', () => {
    const result = matchOcrTemplates(realizaciaLines, [realizaciaTemplate]);
    expect(result).not.toBeNull();
    expect(result!.templateId).toBe(1);
    expect(result!.score).toBeGreaterThanOrEqual(4);
    expect(result!.fields.orderName).toBe('671');
    expect(result!.fields.material).toContain('ЛДСП');
    expect(result!.fields.width).toBe(649);
    expect(result!.fields.height).toBe(238);
  });

  it('2. returns null when there is no dimensions/material line to satisfy the template', () => {
    const result = matchOcrTemplates(['Заказ№ 5001', 'Поз.3'], [realizaciaTemplate]);
    expect(result).toBeNull();
  });

  it('3. returns null with only one strong rule (need >=2 strong)', () => {
    const template: OcrTemplateForMatch = {
      id: 2,
      name: 'dims-only',
      rules: [{ field: 'dimensions' }],
    };
    const result = matchOcrTemplates(realizaciaLines, [template]);
    expect(result).toBeNull();
  });

  it('4. returns null for two numeric strong fields with no discriminant', () => {
    const template: OcrTemplateForMatch = {
      id: 3,
      name: 'two-numeric',
      rules: [{ field: 'order_number' }, { field: 'detail_number' }],
    };
    const result = matchOcrTemplates(['671', '3'], [template]);
    expect(result).toBeNull();
  });

  it('5. wins when an anchor on one of the two numeric rules supplies the discriminant', () => {
    const template: OcrTemplateForMatch = {
      id: 3,
      name: 'two-numeric-anchored',
      rules: [{ field: 'order_number', anchor: 'Зак' }, { field: 'detail_number' }],
    };
    const result = matchOcrTemplates(['Зак 671', '3'], [template]);
    expect(result).not.toBeNull();
    expect(result!.fields.orderName).toBe('671');
    expect(result!.fields.detailNumber).toBe(3);
  });

  it('6. anchor comparison tolerates OCR latin/cyrillic confusion (Р.Р. vs P.P.)', () => {
    const template: OcrTemplateForMatch = {
      id: 4,
      name: 'anchor-tolerance',
      rules: [{ field: 'material' }, { field: 'dimensions', anchor: 'Р.Р.' }],
    };
    const result = matchOcrTemplates(['ЛДСП 16 мм', 'P.P. 649 X238'], [template]);
    expect(result).not.toBeNull();
    expect(result!.fields.width).toBe(649);
    expect(result!.fields.height).toBe(238);
    expect(result!.fields.material).toBe('ЛДСП 16мм');
  });

  it('7. determinism: equal score/strongMatched picks the smaller template id', () => {
    const templateHighId: OcrTemplateForMatch = {
      id: 9,
      name: 'dup-high',
      rules: [{ field: 'order_number' }, { field: 'material' }, { field: 'dimensions' }],
    };
    const templateLowId: OcrTemplateForMatch = {
      id: 2,
      name: 'dup-low',
      rules: [{ field: 'order_number' }, { field: 'material' }, { field: 'dimensions' }],
    };
    const result = matchOcrTemplates(realizaciaLines, [templateHighId, templateLowId]);
    expect(result).not.toBeNull();
    expect(result!.templateId).toBe(2);
  });

  it('8. result never carries a bazisFields property', () => {
    const result = matchOcrTemplates(realizaciaLines, [realizaciaTemplate]);
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('bazisFields');
  });

  it('9. a 2-digit-year date line (00.00.17) contributes strong weight and fills fields.date', () => {
    const template: OcrTemplateForMatch = {
      id: 5,
      name: 'date-2digit-year',
      rules: [{ field: 'date' }, { field: 'material' }, { field: 'dimensions' }],
    };
    const result = matchOcrTemplates(['00.00.17', 'ЛДСП 16мм', '649 X 238'], [template]);
    expect(result).not.toBeNull();
    expect(result!.fields.date).toBe('00.00.17');
    expect(result!.fields.width).toBe(649);
    expect(result!.fields.height).toBe(238);
  });
});
