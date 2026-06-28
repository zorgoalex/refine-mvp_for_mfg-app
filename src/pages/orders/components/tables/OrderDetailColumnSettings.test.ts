import { describe, expect, it } from 'vitest';
import type { ColumnsType } from 'antd/es/table';
import {
  applyOrderDetailColumnSettings,
  normalizeOrderDetailColumnSettings,
  type OrderDetailColumnDefinition,
} from './OrderDetailColumnSettings';

const definitions: OrderDetailColumnDefinition[] = [
  { key: 'a', label: 'A', lockVisible: true },
  { key: 'b', label: 'B' },
  { key: 'c', label: 'C' },
];

describe('OrderDetailColumnSettings', () => {
  it('normalizes order and keeps locked columns visible', () => {
    expect(normalizeOrderDetailColumnSettings(['a', 'b', 'c'], definitions, {
      order: ['c', 'missing', 'b', 'c'],
      hidden: ['a', 'b', 'missing'],
    })).toEqual({
      order: ['c', 'b', 'a'],
      hidden: ['b'],
    });
  });

  it('applies visibility and order to table columns', () => {
    const columns: ColumnsType<{ id: number }> = [
      { key: 'a', title: 'A' },
      { key: 'b', title: 'B' },
      { key: 'c', title: 'C' },
    ];

    const result = applyOrderDetailColumnSettings(columns, {
      order: ['c', 'a', 'b'],
      hidden: ['b'],
    });

    expect(result.map((column) => column.key)).toEqual(['c', 'a']);
  });
});
