import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOrderCardPagination } from './OrderCardList';

const read = (p: string) => readFileSync(join(__dirname, '..', '..', '..', p), 'utf8');

describe('orders list phone rendering', () => {
  it('list.tsx branches on the phone device tier and renders OrderCardList', () => {
    const src = read('pages/orders/list.tsx');
    expect(src).toContain('useDeviceTier');
    expect(src).toContain("deviceTier === 'phone'");
    expect(src).toContain('OrderCardList');
  });
  it('OrderCardList uses card model and List pagination, no Table', () => {
    const src = read('pages/orders/mobile/OrderCardList.tsx');
    expect(src).toContain('buildOrderCardModel');
    expect(src).not.toContain('<Table');
    expect(src).toContain('onOpen');
  });
  it('converts Table pagination position to a valid Ant List position', () => {
    const onPaginationChange = vi.fn();
    expect(buildOrderCardPagination({
      current: 1,
      pageSize: 20,
      total: 4641,
      position: ['topRight', 'bottomRight'],
    }, onPaginationChange)).toMatchObject({
      current: 1,
      pageSize: 20,
      total: 4641,
      position: 'bottom',
      simple: false,
      showLessItems: true,
      showSizeChanger: true,
      onChange: onPaginationChange,
    });
  });
  it('cut-select group workflow stays desktop-only', () => {
    const src = read('pages/orders/mobile/OrderCardList.tsx');
    expect(src).not.toContain('cutSelect');
  });

  it('collapses phone header actions into an accessible one-row disclosure', () => {
    const src = read('pages/orders/list.tsx');
    const css = read('pages/orders/list.css');
    expect(src).toContain('const OrdersMobileHeaderDisclosure');
    expect(src).toContain('aria-expanded={expanded}');
    expect(src).toContain('aria-controls="orders-mobile-header-controls"');
    expect(src).toContain('Действия и фильтры');
    expect(src).toContain('if (!next) setFiltersVisible(false)');
    expect(css).toContain('.orders-mobile-header-disclosure--mobile');
    expect(css).toContain('min-height: 44px');
    expect(css).toContain('grid-template-rows: 0fr');
    expect(css).toContain('transition-property: grid-template-rows, opacity, visibility');
    expect(css).toContain('transform: scale(0.96)');
    expect(css).not.toContain('transition: all');
  });

  it('offers persistent list and card modes on phones', () => {
    const src = read('pages/orders/list.tsx');
    expect(src).toContain('(isTablet || isMobile) && (');
    expect(src).toContain("isMobile ? 'cards' : 'list'");
    expect(src).toContain("(isMobile || isTablet) && ordersViewMode === 'cards'");
    expect(src).toContain("'order-card-list--mobile'");
    expect(src).toContain("{isMobile ? ' Список' : ''}");
    expect(src).toContain("{isMobile ? ' Карточки' : ''}");
  });
});
