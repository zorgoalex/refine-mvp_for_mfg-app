import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeOrderListProductionNumbers } from './orderListProductionNumbers';

describe('normalizeOrderListProductionNumbers', () => {
  it('normalizes, deduplicates, and keeps server order', () => {
    expect(normalizeOrderListProductionNumbers([' 42-3 ', '42-3', '51-1', null, ''])).toEqual([
      '42-3',
      '51-1',
    ]);
  });

  it('returns an empty list for absent or invalid values', () => {
    expect(normalizeOrderListProductionNumbers(undefined)).toEqual([]);
    expect(normalizeOrderListProductionNumbers([null, {}, []])).toEqual([]);
  });
});

describe('orders list production-number columns', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/pages/orders/list.tsx'), 'utf8');

  it('registers and renders all three requested columns', () => {
    expect(source).toContain("{ key: 'bazis_cut_numbers', label: 'Базис-раскрой' }");
    expect(source).toContain("{ key: 'cut_numbers', label: 'Раскрой' }");
    expect(source).toContain("{ key: 'bath_cut_numbers', label: 'Расчет ванны' }");
    expect(source).toContain('dataIndex: "bazis_cut_numbers"');
    expect(source).toContain('dataIndex: "cut_numbers"');
    expect(source).toContain('dataIndex: "bath_cut_numbers"');
    expect(source).toContain('className="orders-production-number-list"');
  });
});
