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
  it('show.tsx branches details table for phone', () => {
    const src = read('pages/orders/show.tsx');
    expect(src).toContain('useIsMobile');
    expect(src).toContain('DetailCardList');
  });
  it('edit header summary reuses stacking class', () => {
    const src = read('pages/orders/components/sections/OrderHeaderSummary.tsx');
    expect(src).toContain('order-show-header__row');
  });
  it('client phone is a tel link', () => {
    const src = read('pages/orders/components/sections/OrderShowHeader.tsx');
    expect(src).toContain('tel:');
  });
  it('show header actions collapse into dropdown on phone', () => {
    const src = read('pages/orders/show.tsx');
    expect(src).toMatch(/isMobile[\s\S]*Dropdown|Dropdown[\s\S]*isMobile/);
  });
  it('show.tsx honors highlightDetail query param', () => {
    const src = read('pages/orders/show.tsx');
    expect(src).toContain('highlightDetail');
  });
});
