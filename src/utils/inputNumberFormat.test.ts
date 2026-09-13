import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatNumber, numberFormatter, numberParser } from './numberFormat';
import { formatInputNumber, optionalInputNumberFormatter } from './inputNumberFormat';

const values = [undefined, null, '', 0, '0', -0, '-0', 1, '1', 12.5, '12.5', '1234.56',
  32767, '32767', Number.NaN, 'invalid', Infinity, 'Infinity', '  ', '1e3'];

describe('native InputNumber formatter adapters', () => {
  it.each(values)('preserves existing display for native value %j', value => {
    for (const precision of [0, 2]) {
      // AntD currently passes strings into these old number-only signatures.
      // Deliberately exercise that runtime contract without changing the helpers.
      expect(formatInputNumber(value, precision)).toBe(Reflect.apply(formatNumber, undefined, [value, precision]));
      expect(optionalInputNumberFormatter(value, precision)).toBe(Reflect.apply(numberFormatter, undefined, [value, precision]));
    }
  });

  it('keeps clear/retype parsing and numeric persistence unchanged', () => {
    expect(numberParser('')).toBe('');
    expect(numberParser('  ')).toBe('');
    expect(numberParser('1 234,50')).toBe(1234.5);
    expect(numberParser('0')).toBe(0);
    expect(numberParser('32767')).toBe(32767);
  });

  it('preserves the old distinction between numeric zero and native string zero', () => {
    expect(optionalInputNumberFormatter(0)).toBe('');
    expect(optionalInputNumberFormatter('0')).toBe('0');
    expect(optionalInputNumberFormatter('')).toBe('');
    expect(formatInputNumber('', 2)).toBe('0,00');
  });

  it.each([
    ['../pages/orders/components/modals/EdgeTypeQuickCreate.tsx', 'optionalInputNumberFormatter', 1],
    ['../pages/orders/components/modals/MillingTypeQuickCreate.tsx', 'optionalInputNumberFormatter', 1],
    ['../pages/orders/components/sections/OrderBasicInfo.tsx', 'optionalInputNumberFormatter', 1],
    ['../pages/orders/components/sections/OrderFinanceSection.tsx', 'formatInputNumber', 3],
  ] as const)('wires the tested adapter into %s without replacing the parser', (file, formatter, count) => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(source.match(new RegExp(`formatter=\\{\\([^)]*\\) => ${formatter}\\(`, 'g'))).toHaveLength(count);
    expect(source).toContain('parser={numberParser}');
    expect(source).not.toContain('stringMode');
  });
});
