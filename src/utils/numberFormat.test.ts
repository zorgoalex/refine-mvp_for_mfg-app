import { describe, expect, it } from 'vitest';
import { createSmartFormatter } from './numberFormat';

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
