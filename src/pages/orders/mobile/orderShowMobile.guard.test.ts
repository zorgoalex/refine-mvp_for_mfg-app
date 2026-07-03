import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(__dirname, '..', '..', '..', p), 'utf8');

describe('order show header phone stacking', () => {
  it('all three header rows carry the stacking class', () => {
    const src = read('pages/orders/components/sections/OrderShowHeader.tsx');
    expect(src.split('order-show-header__row').length - 1).toBeGreaterThanOrEqual(3);
  });
  it('mobile.css stacks header rows vertically on phone', () => {
    const css = read('styles/mobile.css');
    expect(css).toMatch(/\.order-show-header__row[\s\S]*flex-direction:\s*column\s*!important/);
  });
});
