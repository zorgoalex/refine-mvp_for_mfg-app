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
  { key: 'd', label: 'D', defaultAfter: 'b' },
  { key: 'c', label: 'C' },
  { key: 'actions', label: 'Actions', lockVisible: true, lockPosition: 'end' },
];

describe('OrderDetailColumnSettings', () => {
  it('normalizes order and keeps locked columns visible', () => {
    expect(normalizeOrderDetailColumnSettings(['a', 'b', 'd', 'c', 'actions'], definitions, {
      order: ['c', 'missing', 'b', 'c'],
      hidden: ['a', 'b', 'missing'],
    })).toEqual({
      order: ['c', 'b', 'd', 'a', 'actions'],
      hidden: ['b'],
    });
  });

  it('keeps an end-pinned action column last when old preferences precede new columns', () => {
    expect(normalizeOrderDetailColumnSettings(
      ['a', 'b', 'd', 'c', 'actions'],
      definitions,
      { order: ['a', 'actions', 'b'], hidden: [] },
    ).order).toEqual(['a', 'b', 'd', 'c', 'actions']);
  });

  it('places a newly introduced column after its default anchor without resetting saved order', () => {
    expect(normalizeOrderDetailColumnSettings(
      ['a', 'b', 'd', 'c', 'actions'],
      definitions,
      { order: ['c', 'a', 'b', 'actions'], hidden: [] },
    ).order).toEqual(['c', 'a', 'b', 'd', 'actions']);
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
