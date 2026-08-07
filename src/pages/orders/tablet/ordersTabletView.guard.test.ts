import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const list = readFileSync('src/pages/orders/list.tsx', 'utf8');
const cards = readFileSync('src/pages/orders/mobile/OrderCardList.tsx', 'utf8');
const tabletCss = readFileSync('src/ui-evolution/styles/tablet.css', 'utf8');

describe('tablet orders view integration', () => {
  it('connects the user-scoped list/cards/board contract to canonical navigation', () => {
    expect(list).toContain('ordersViewStorageKey(currentUser?.id)');
    expect(list).toContain("routerNavigate('/order-status-board')");
    expect(list).toContain("setOrdersViewQuery(location.search, returnMode)");
    expect(list).toContain('window.localStorage.setItem(ordersViewKey, returnMode)');
    expect(list).toContain('featureFlags.orderStatusBoard');
    expect(list).toContain('canViewNavigationResource(');
    expect(list).toContain('canViewResourceByRoleVisibility(');
    expect(list).toContain('...(isTablet && canViewStatusBoard');
    expect(list).toContain("if (!isTablet || !canViewStatusBoard) return");
    expect(list).toContain('orders-tablet-view-switch');
    expect(list).toContain('aria-label="Вид заказов"');
    expect(list).not.toContain("tab=production");
  });

  it('reuses the honest mobile card mapper in the tablet grid', () => {
    expect(list).toContain("(isMobile || isTablet) && ordersViewMode === 'cards'");
    expect(list).toContain("'order-card-list--tablet'");
    expect(cards).toContain('buildOrderCardModel');
    expect(tabletCss).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(tabletCss).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(tabletCss).toContain('grid-template-columns: minmax(0, 1fr)');
  });
});
