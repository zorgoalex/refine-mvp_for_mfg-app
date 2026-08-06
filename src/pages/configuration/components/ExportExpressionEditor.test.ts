import { describe, expect, it } from 'vitest';
import type { ExportExpression, ExportTemplateColumn } from '../../../api/exportTemplatesApi';
import { buildRowColumnOptions, expressionReferencesColumn } from './ExportExpressionEditor';

const columns: ExportTemplateColumn[] = [
  { columnKey: 'order', header: 'Заказ', expression: { type: 'field', field: 'legacy.order' } },
  { columnKey: 'qr', header: 'QR-code', expression: { type: 'field', field: 'legacy.qr' } },
];

describe('ExportExpressionEditor same-row fields', () => {
  it('numbers row fields, keeps stable keys and disables the current column', () => {
    expect(buildRowColumnOptions(columns, 'qr')).toEqual([
      { value: 'order', label: '1. Заказ', disabled: false },
      { value: 'qr', label: '2. QR-code (текущая)', disabled: true },
    ]);
  });

  it('finds column references inside nested expressions', () => {
    const expression: ExportExpression = {
      type: 'if_else',
      when: { left: { type: 'field', field: 'detail.position' }, op: 'not_empty' },
      then: { type: 'concat', parts: [
        { type: 'column_ref', columnKey: 'order' }, { type: 'constant', value: ':' },
      ] },
      else: { type: 'empty' },
    };

    expect(expressionReferencesColumn(expression, 'order')).toBe(true);
    expect(expressionReferencesColumn(expression, 'qr')).toBe(false);
  });

  it('disables a row field that would create an indirect cycle', () => {
    const dependentColumns: ExportTemplateColumn[] = [
      columns[0],
      columns[1],
      { columnKey: 'label', header: 'Этикетка', expression: { type: 'column_ref', columnKey: 'qr' } },
    ];

    expect(buildRowColumnOptions(dependentColumns, 'qr')[2]).toEqual({
      value: 'label', label: '3. Этикетка (создаст цикл)', disabled: true,
    });
  });
});
