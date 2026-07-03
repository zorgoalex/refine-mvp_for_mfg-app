import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(__dirname, '..', '..', '..', p), 'utf8');

describe('orders list phone rendering', () => {
  it('list.tsx branches on useIsMobile and renders OrderCardList', () => {
    const src = read('pages/orders/list.tsx');
    expect(src).toContain('useIsMobile');
    expect(src).toContain('OrderCardList');
  });
  it('OrderCardList uses card model and List pagination, no Table', () => {
    const src = read('pages/orders/mobile/OrderCardList.tsx');
    expect(src).toContain('buildOrderCardModel');
    expect(src).not.toContain('<Table');
    expect(src).toContain('onOpen');
  });
  it('cut-select group workflow stays desktop-only', () => {
    const src = read('pages/orders/mobile/OrderCardList.tsx');
    expect(src).not.toContain('cutSelect');
  });
});
