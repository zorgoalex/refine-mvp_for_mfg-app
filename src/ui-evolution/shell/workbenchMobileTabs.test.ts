import { describe, expect, it } from 'vitest';
import { isWorkbenchMobileTabActive, resolveWorkbenchMobileTabs } from './workbenchMobileTabs';

describe('NewLine phone tab bar', () => {
  const all = new Set(['orders_view', 'calendar', 'mdf-work-board', 'scan']);

  it('shows only sections that exist and the user may see', () => {
    expect(resolveWorkbenchMobileTabs(all, () => true).map((t) => t.label))
      .toEqual(['Заказы', 'Календарь', 'МДФ', 'Сканер']);
    expect(resolveWorkbenchMobileTabs(all, (r) => r !== 'mdf-work-board').map((t) => t.resource))
      .toEqual(['orders_view', 'calendar', 'scan']);
    // scanner disabled by the labels flag: no resource, no tab
    expect(resolveWorkbenchMobileTabs(new Set(['orders_view']), () => true).map((t) => t.resource))
      .toEqual(['orders_view']);
    expect(resolveWorkbenchMobileTabs(all, () => false)).toEqual([]);
  });

  it('marks a section active on its nested pages only', () => {
    expect(isWorkbenchMobileTabActive('/orders', '/orders')).toBe(true);
    expect(isWorkbenchMobileTabActive('/orders', '/orders/show/12')).toBe(true);
    expect(isWorkbenchMobileTabActive('/orders', '/orders-analytics')).toBe(false);
    expect(isWorkbenchMobileTabActive('/scan', '/calendar')).toBe(false);
  });
});
