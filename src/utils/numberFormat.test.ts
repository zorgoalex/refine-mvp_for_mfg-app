import { describe, expect, it, vi } from 'vitest';
import { createSmartFormatter, formatNumber } from './numberFormat';

describe('createSmartFormatter', () => {
  it('keeps Ant Design empty runtime values empty', () => {
    const formatter = createSmartFormatter(2);

    expect(formatter(undefined)).toBe('');
    expect(formatter(null)).toBe('');
    expect(formatter('')).toBe('');
  });

  it('formats real numeric values without forcing decimal zeroes', () => {
    const formatter = createSmartFormatter(2);

    expect(formatter(0)).toBe('0');
    expect(formatter(12)).toBe('12');
    expect(formatter(12.5)).toBe('12,50');
  });
});

describe('formatNumber reuses its formatter', () => {
  it('creates one Intl.NumberFormat per precision', () => {
    const Original = Intl.NumberFormat;
    let created = 0;
    const counting = function (...args: ConstructorParameters<typeof Intl.NumberFormat>) {
      created += 1;
      return new Original(...args);
    } as unknown as typeof Intl.NumberFormat;
    Intl.NumberFormat = counting;
    try {
      const first = formatNumber(1234.5, 7);
      for (let i = 0; i < 50; i += 1) formatNumber(1234.5 + i, 7);
      expect(formatNumber(1234.5, 7)).toBe(first);
      expect(created).toBe(1);
    } finally {
      Intl.NumberFormat = Original;
    }
  });
});
