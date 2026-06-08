import { describe, expect, it, vi } from 'vitest';
import type { IResourceItem } from '@refinedev/core';
import {
  buildCategorizedResources,
  buildFlatMenuItems,
  computeSelectedKey,
  resolveCalendarRoute,
  resolveOrdersRoute,
} from './siderMenuItems';

function makeResource(name: string, list: string, label?: string): IResourceItem {
  return {
    name,
    list,
    meta: label ? { label } : undefined,
  } as IResourceItem;
}

describe('computeSelectedKey', () => {
  it('returns the matching resource name when its list route is a prefix', () => {
    const resources: IResourceItem[] = [
      makeResource('orders', '/orders'),
      makeResource('calendar', '/calendar'),
    ];
    expect(computeSelectedKey(resources, '/orders/123')).toBe('orders');
    expect(computeSelectedKey(resources, '/calendar')).toBe('calendar');
  });

  it('prefers the longer matching route (avoids /clients vs /clients-analytics clash)', () => {
    const resources: IResourceItem[] = [
      makeResource('clients', '/clients'),
      makeResource('clients_analytics', '/clients-analytics'),
    ];
    expect(computeSelectedKey(resources, '/clients-analytics')).toBe('clients_analytics');
    expect(computeSelectedKey(resources, '/clients')).toBe('clients');
  });

  it('returns empty string when no route matches', () => {
    const resources: IResourceItem[] = [makeResource('orders', '/orders')];
    expect(computeSelectedKey(resources, '/unknown')).toBe('');
  });

  it('ignores resources without a string list route', () => {
    const resources: IResourceItem[] = [
      { name: 'no-list' } as IResourceItem,
      makeResource('orders', '/orders'),
    ];
    expect(computeSelectedKey(resources, '/orders')).toBe('orders');
  });
});

describe('buildCategorizedResources', () => {
  const categories = ['Контрагенты', 'Финансы', 'Производство', 'Материалы', 'Справочники', 'Настройки'];
  const categoryMap: Record<string, string> = {
    clients: 'Контрагенты',
    payments: 'Финансы',
    materials: 'Материалы',
    configuration: 'Настройки',
  };
  const labels: Record<string, string> = {
    clients: 'Клиенты',
    payments: 'Платежи',
    materials: 'Материалы',
    configuration: 'Конфигурация',
  };

  it('groups resources by category and sorts within category by Russian label', () => {
    const resources: IResourceItem[] = [
      makeResource('payments', '/payments'),
      makeResource('clients', '/clients'),
      makeResource('materials', '/materials'),
    ];
    const result = buildCategorizedResources({
      resources,
      categoryOrder: categories,
      categoryMap,
      resourceLabels: labels,
      canViewNavigation: () => true,
      canViewSettings: true,
    });
    expect(result['Финансы'].map((i) => i.name)).toEqual(['payments']);
    expect(result['Контрагенты'].map((i) => i.name)).toEqual(['clients']);
    expect(result['Материалы'].map((i) => i.name)).toEqual(['materials']);
  });

  it('excludes resources the user cannot navigate to', () => {
    const resources: IResourceItem[] = [
      makeResource('payments', '/payments'),
      makeResource('clients', '/clients'),
    ];
    const result = buildCategorizedResources({
      resources,
      categoryOrder: categories,
      categoryMap,
      resourceLabels: labels,
      canViewNavigation: (name) => name === 'payments',
      canViewSettings: true,
    });
    expect(result['Финансы']).toHaveLength(1);
    expect(result['Контрагенты']).toHaveLength(0);
  });

  it('excludes Настройки category when canViewSettings is false', () => {
    const resources: IResourceItem[] = [
      makeResource('configuration', '/configuration'),
    ];
    const result = buildCategorizedResources({
      resources,
      categoryOrder: categories,
      categoryMap,
      resourceLabels: labels,
      canViewNavigation: () => true,
      canViewSettings: false,
    });
    expect(result['Настройки']).toEqual([]);
  });

  it('excludes orders_view and calendar from categorized list (handled in top menu)', () => {
    const resources: IResourceItem[] = [
      makeResource('orders_view', '/orders'),
      makeResource('calendar', '/calendar'),
    ];
    const result = buildCategorizedResources({
      resources,
      categoryOrder: categories,
      categoryMap,
      resourceLabels: {},
      canViewNavigation: () => true,
      canViewSettings: true,
    });
    for (const cat of Object.values(result)) {
      expect(cat).toEqual([]);
    }
  });

  it('skips resources without a list route or meta.route', () => {
    const resources: IResourceItem[] = [
      { name: 'no-route' } as IResourceItem,
      makeResource('clients', '/clients'),
    ];
    const result = buildCategorizedResources({
      resources,
      categoryOrder: categories,
      categoryMap,
      resourceLabels: labels,
      canViewNavigation: () => true,
      canViewSettings: true,
    });
    expect(result['Контрагенты']).toHaveLength(1);
  });

  it('falls back to Справочники for resources without a category mapping', () => {
    const resources: IResourceItem[] = [makeResource('unknown', '/unknown')];
    const result = buildCategorizedResources({
      resources,
      categoryOrder: categories,
      categoryMap,
      resourceLabels: { unknown: 'Unknown' },
      canViewNavigation: () => true,
      canViewSettings: true,
    });
    expect(result['Справочники'].map((i) => i.name)).toEqual(['unknown']);
  });
});

describe('resolveOrdersRoute and resolveCalendarRoute', () => {
  it('returns resource-defined routes when present', () => {
    const resources: IResourceItem[] = [
      makeResource('orders_view', '/custom-orders'),
      makeResource('calendar', '/custom-calendar'),
    ];
    expect(resolveOrdersRoute(resources, {}).route).toBe('/custom-orders');
    expect(resolveCalendarRoute(resources, {}).route).toBe('/custom-calendar');
  });

  it('falls back to /orders and /calendar when resource is missing', () => {
    expect(resolveOrdersRoute([], {}).route).toBe('/orders');
    expect(resolveCalendarRoute([], {}).route).toBe('/calendar');
  });

  it('falls back to Russian labels when not in label map', () => {
    const orders = resolveOrdersRoute([], {});
    expect(orders.label).toBe('Заказы');
    const calendar = resolveCalendarRoute([], {});
    expect(calendar.label).toBe('Календарь');
  });
});

describe('buildFlatMenuItems', () => {
  it('returns flat items in category order with onClick wired to navigate', () => {
    const navigate = vi.fn();
    const categories: Record<string, { name: string; label: string; route: string }[]> = {
      Контрагенты: [{ name: 'clients', label: 'Клиенты', route: '/clients' }],
      Финансы: [{ name: 'payments', label: 'Платежи', route: '/payments' }],
      Производство: [],
      Материалы: [],
      Справочники: [],
      Настройки: [],
    };
    const items = buildFlatMenuItems(categories, Object.keys(categories), {}, navigate);
    expect(items).toHaveLength(2);
    expect(items?.[0]).toMatchObject({ key: 'clients' });
    expect(items?.[1]).toMatchObject({ key: 'payments' });

    (items?.[0] as { onClick?: () => void }).onClick?.();
    expect(navigate).toHaveBeenCalledWith('/clients');
  });

  it('skips empty categories', () => {
    const navigate = vi.fn();
    const categories: Record<string, { name: string; label: string; route: string }[]> = {
      Контрагенты: [],
      Финансы: [],
      Производство: [],
      Материалы: [],
      Справочники: [],
      Настройки: [],
    };
    const items = buildFlatMenuItems(categories, Object.keys(categories), {}, navigate);
    expect(items).toEqual([]);
  });
});
