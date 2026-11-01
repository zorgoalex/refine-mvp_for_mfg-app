import { describe, expect, it } from 'vitest';
import { materialSortKey, sortOrderIds } from './pg-order-resource-demand-repository';

describe('resource demand sort over all pages', () => {
  const row = (orderId: number, key: string, orderDate: string | null = '2026-10-01') => ({ orderId, key, orderDate });

  it('compares like the client: numbers by value, Russian letters, case-insensitive', () => {
    expect(sortOrderIds([row(1, '123-10'), row(2, '123-2'), row(3, '99')], 'asc')).toEqual([3, 2, 1]);
    expect(sortOrderIds([row(1, '123-10'), row(2, '123-2'), row(3, '99')], 'desc')).toEqual([1, 2, 3]);
    expect(sortOrderIds([row(1, 'Плёнка 10'), row(2, 'плёнка 2'), row(3, 'Ёлка'), row(4, 'Бук')], 'asc')).toEqual([4, 3, 2, 1]);
  });

  it('puts empty keys last in both directions; equal keys keep the default order (date desc, then id desc)', () => {
    const rows = [row(1, ''), row(2, 'Б'), row(3, 'А', '2026-09-01'), row(4, 'А', '2026-10-01'), row(5, 'А', null), row(6, 'А', '2026-10-01')];
    expect(sortOrderIds(rows, 'asc')).toEqual([6, 4, 3, 5, 2, 1]);
    expect(sortOrderIds(rows, 'desc')).toEqual([2, 6, 4, 3, 5, 1]);
  });

  it('material key = names sorted the same way, joined by a space (the column text)', () => {
    expect(materialSortKey(['Плёнка 10', 'Дуб', 'Плёнка 2'])).toBe('Дуб Плёнка 2 Плёнка 10');
    expect(materialSortKey([])).toBe('');
  });
});
