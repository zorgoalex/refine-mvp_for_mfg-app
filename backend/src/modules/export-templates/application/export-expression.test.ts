import { describe, expect, it } from 'vitest';
import { evaluateExpression, validateExportColumns } from './export-expression';
import type { BazisExportDetail, ExportExpression } from './export-template.types';

const detail: BazisExportDetail = {
  cutEnabled: true, materialType: 'Площадной', materialName: 'ЛДСП', materialArticle: 'A-1', thicknessMm: 16,
  position: '.07', partName: 'Боковина', finishedLengthMm: 720, finishedWidthMm: 500,
  cutLengthMm: 724, cutWidthMm: 504, quantity: 2, orientation: '', groove: '',
  l1Name: '', l1Designation: '', l1ThicknessMm: 0, l2Name: '', l2Designation: '', l2ThicknessMm: 0,
  w1Name: '', w1Designation: '', w1ThicknessMm: 0, w2Name: '', w2Designation: '', w2ThicknessMm: 0,
  priority: null, comment: '', customProperty: '', glue: '', milling: '', route: '', film: '',
  sourceBazisProjectName: 'BP', sourceBazisOrderNo: '42', sourceBazisProductName: 'Шкаф', sourceBathCutNumber: '10-2',
  sourceOrderName: 'ERP-1491',
};
const context = { rowNumber: 3, exportedAt: new Date('2026-08-05T12:00:00Z'), templateName: 'Тест' };

describe('export expression', () => {
  it('evaluates nested if/else, dynamic fields and concatenation', () => {
    const expression: ExportExpression = {
      type: 'if_else',
      when: { left: { type: 'field', field: 'detail.quantity' }, op: 'gte', right: { type: 'constant', value: 2 } },
      then: { type: 'concat', parts: [
        { type: 'field', field: 'source.sourceBazisProductName' }, { type: 'constant', value: '-' },
        { type: 'field', field: 'row.number' },
      ] },
      else: { type: 'empty' },
    };
    expect(evaluateExpression(expression, detail, context)).toBe('Шкаф-3');
  });

  it('applies string, number and math functions with typed results', () => {
    expect(evaluateExpression({ type: 'string_fn', fn: 'upper', input: { type: 'constant', value: ' abc ' } }, detail, context)).toBe(' ABC ');
    expect(evaluateExpression({ type: 'number_fn', fn: 'round', digits: 2, input: { type: 'constant', value: '12.345' } }, detail, context)).toBe(12.35);
    expect(evaluateExpression({ type: 'math', fn: 'multiply', parts: [
      { type: 'field', field: 'detail.quantity' }, { type: 'constant', value: 2.5 },
    ] }, detail, context)).toBe(5);
  });

  it('uses raw Position and the canonical Basis QR identity in legacy fields', () => {
    expect(evaluateExpression({ type: 'field', field: 'legacy.position' }, detail, context)).toBe('.07');
    expect(evaluateExpression({ type: 'field', field: 'legacy.qr' }, detail, context)).toBe('BPШкаф..07');
    expect(evaluateExpression({ type: 'field', field: 'legacy.qr' }, {
      ...detail,
      sourceBazisProjectName: '',
      sourceBazisOrderNo: '',
    }, context)).toBe('ERP-1491Шкаф..07');
  });

  it('rejects locale decimals, divide-by-zero and unknown fields', () => {
    expect(() => evaluateExpression({ type: 'number_fn', fn: 'round', input: { type: 'constant', value: '1,5' } }, detail, context)).toThrow('Expected an invariant finite number');
    expect(() => evaluateExpression({ type: 'math', fn: 'divide', parts: [
      { type: 'constant', value: 4 }, { type: 'constant', value: 0 },
    ] }, detail, context)).toThrow('Division by zero');
    expect(() => validateExportColumns([{ columnKey: 'x', header: 'X', expression: { type: 'field', field: 'process.env.SECRET' } }])).toThrow('Export template validation failed');
  });

  it('distinguishes exists, blank, zero and false', () => {
    const branch = (left: ExportExpression, op: 'exists' | 'not_empty') => evaluateExpression({
      type: 'if_else', when: { left, op }, then: { type: 'constant', value: 'yes' }, else: { type: 'constant', value: 'no' },
    }, detail, context);
    expect(branch({ type: 'constant', value: '' }, 'exists')).toBe('yes');
    expect(branch({ type: 'constant', value: '   ' }, 'not_empty')).toBe('no');
    expect(branch({ type: 'constant', value: 0 }, 'not_empty')).toBe('yes');
    expect(branch({ type: 'constant', value: false }, 'not_empty')).toBe('yes');
  });
});
