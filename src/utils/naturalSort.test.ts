import { describe, expect, it } from 'vitest';
import { compareNatural, naturalSorter } from './naturalSort';

describe('natural sort', () => {
  it('orders numbers of Bazis projects and orders as numbers, suffixes after the number', () => {
    const names = ['1550.xml', '12', '1289', '2', '1347-5', '1347', 'Тест', '1619(Kuhnya)', '1541.1', '101'];
    expect([...names].sort(compareNatural)).toEqual(['2', '12', '101', '1289', '1347', '1347-5', '1541.1', '1550.xml', '1619(Kuhnya)', 'Тест']);
  });

  it('compares numeric strings and numbers by value', () => {
    expect(compareNatural('10.5', '10.25')).toBeGreaterThan(0);
    expect(compareNatural(9, 10)).toBeLessThan(0);
    expect(compareNatural(false, true)).toBeLessThan(0);
  });

  it('keeps empty values last in both directions (antd reverses the comparator for descend)', () => {
    const rows = [{ n: null }, { n: '12' }, { n: '2' }, { n: '' }] as Array<{ n: string | null }>;
    const sorter = naturalSorter<{ n: string | null }>('n');
    const ascend = [...rows].sort((a, b) => sorter(a, b, 'ascend')).map((r) => r.n);
    const descend = [...rows].sort((a, b) => -sorter(a, b, 'descend')).map((r) => r.n);
    expect(ascend.slice(0, 2)).toEqual(['2', '12']);
    expect(descend.slice(0, 2)).toEqual(['12', '2']);
    expect(ascend.slice(2).every((v) => v === null || v === '')).toBe(true);
    expect(descend.slice(2).every((v) => v === null || v === '')).toBe(true);
  });
});
