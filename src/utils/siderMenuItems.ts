import type { IResourceItem } from '@refinedev/core';
import type { MenuProps } from 'antd';
import { useMemo } from 'react';

export type SiderResource = IResourceItem;

export interface SiderMenuItem {
  name: string;
  label: string;
  route: string;
}

export interface SiderMenuData {
  topMenuItems: NonNullable<MenuProps['items']>;
  flatMenuItems: NonNullable<MenuProps['items']>;
  categorizedResources: Record<string, SiderMenuItem[]>;
  selectedKey: string;
  canCreateOrders: boolean;
  canViewSettings: boolean;
  ordersRoute: string;
  handleNavigate: (route: string) => void;
  handleNewOrder: () => void;
}

/** External CRM (Twenty) link rendered in the top menu, below Calendar. */
export interface TopMenuCrmInput {
  url: string;
  label: string;
  icon?: React.ReactNode;
}

export interface UseSiderMenuItemsInput {
  resources: SiderResource[];
  pathname: string;
  push: (route: string) => void;
  categoryOrder: readonly string[];
  categoryMap: Record<string, string>;
  resourceLabels: Record<string, string>;
  resourceIcons: Record<string, React.ReactNode>;
  canViewNavigation: (resourceName: string) => boolean;
  canViewSettings: boolean;
  canCreateOrders: boolean;
  setIsCreateModalOpen: (open: boolean) => void;
  /** Optional external CRM link shown below Calendar; omit/null to hide. */
  crm?: TopMenuCrmInput | null;
  /** Injectable external-link opener (default: window.open in a new tab). */
  openExternal?: (url: string) => void;
}

/**
 * Stable target name so repeat clicks REUSE (and focus) the same CRM tab
 * instead of spawning a new one each time. We deliberately do NOT pass
 * `noopener`/`noreferrer`: those force every open into a fresh browsing-context
 * group, which defeats name-based reuse (the cause of the "new tab every click"
 * bug). Twenty is a trusted first-party target, so the retained `window.opener`
 * is an acceptable trade for a single, warm, reused CRM tab.
 */
export const CRM_WINDOW_NAME = 'erpCrmWindow';

function defaultOpenExternal(url: string): void {
  if (typeof window !== 'undefined') {
    window.open(url, CRM_WINDOW_NAME);
  }
}

/**
 * Pure helper: build the top menu items (Orders, Calendar, and an optional
 * external CRM link rendered directly below Calendar). The CRM item navigates
 * out of the SPA via `openExternal` rather than the router `push`.
 */
export function buildTopMenuItems(args: {
  canViewNavigation: (resourceName: string) => boolean;
  resourceIcons: Record<string, React.ReactNode>;
  ordersRoute: string;
  ordersLabel: string;
  calendarRoute: string;
  calendarLabel: string;
  push: (route: string) => void;
  crm?: TopMenuCrmInput | null;
  openExternal?: (url: string) => void;
}): NonNullable<MenuProps['items']> {
  const openExternal = args.openExternal ?? defaultOpenExternal;
  const items: MenuProps['items'] = [
    args.canViewNavigation('orders_view')
      ? {
          key: 'orders_view',
          icon: args.resourceIcons['orders_view'],
          label: args.ordersLabel,
          title: args.ordersLabel,
          onClick: () => args.push(args.ordersRoute),
        }
      : null,
    args.canViewNavigation('calendar')
      ? {
          key: 'calendar',
          icon: args.resourceIcons['calendar'],
          label: args.calendarLabel,
          title: args.calendarLabel,
          onClick: () => args.push(args.calendarRoute),
        }
      : null,
    args.crm
      ? {
          key: 'crm',
          icon: args.crm.icon,
          label: args.crm.label,
          title: args.crm.label,
          onClick: () => openExternal(args.crm!.url),
        }
      : null,
  ];
  return items.filter(Boolean) as NonNullable<MenuProps['items']>;
}

/**
 * Pure helper: pick the most specific resource whose `list` route is a
 * prefix of the current pathname. Sort by route length descending so
 * `/clients-analytics` is matched before `/clients` for the path
 * `/clients-analytics`.
 */
export function computeSelectedKey(
  resources: SiderResource[],
  pathname: string,
): string {
  const sorted = [...resources]
    .filter((r) => typeof r.list === 'string')
    .sort((a, b) => (b.list as string).length - (a.list as string).length);
  const match = sorted.find((r) => pathname.startsWith(r.list as string));
  return match?.name ?? '';
}

/**
 * Pure helper: build the categorized map of resources, filtering out
 * those without a list route or without navigation permission, sorted
 * by Russian label inside each category.
 */
export function buildCategorizedResources(args: {
  resources: SiderResource[];
  categoryOrder: readonly string[];
  categoryMap: Record<string, string>;
  resourceLabels: Record<string, string>;
  canViewNavigation: (resourceName: string) => boolean;
  canViewSettings: boolean;
}): Record<string, SiderMenuItem[]> {
  const { resources, categoryOrder, categoryMap, resourceLabels, canViewNavigation, canViewSettings } = args;

  const categories: Record<string, SiderMenuItem[]> = categoryOrder.reduce(
    (acc, cat) => ({ ...acc, [cat]: [] }),
    {} as Record<string, SiderMenuItem[]>,
  );

  resources.forEach((resource) => {
    if (resource.name === 'orders_view' || resource.name === 'calendar') return;
    const category = categoryMap[resource.name] || 'Справочники';
    const label = resourceLabels[resource.name] || resource.meta?.label || resource.name;
    const route = typeof resource.list === 'string'
      ? resource.list
      : resource.meta?.route ?? '';
    if (!route) return;
    if (category === 'Настройки' && !canViewSettings) return;
    if (!canViewNavigation(resource.name)) return;
    categories[category].push({ name: resource.name, label, route });
  });

  categoryOrder.forEach((cat) => {
    categories[cat].sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  });

  return categories;
}

/**
 * Pure helper: pick the orders resource route and label, with sensible
 * fallbacks.
 */
export function resolveOrdersRoute(
  resources: SiderResource[],
  resourceLabels: Record<string, string>,
): { route: string; label: string } {
  const ordersResource = resources.find((r) => r.name === 'orders_view');
  const route = typeof ordersResource?.list === 'string' ? ordersResource.list : '/orders';
  const label = resourceLabels['orders_view'] || 'Заказы';
  return { route, label };
}

/**
 * Pure helper: pick the calendar resource route and label, with
 * sensible fallbacks.
 */
export function resolveCalendarRoute(
  resources: SiderResource[],
  resourceLabels: Record<string, string>,
): { route: string; label: string } {
  const calendarResource = resources.find((r) => r.name === 'calendar');
  const route = typeof calendarResource?.list === 'string' ? calendarResource.list : '/calendar';
  const label = resourceLabels['calendar'] || 'Календарь';
  return { route, label };
}

export function buildFlatMenuItems(
  categorizedResources: Record<string, SiderMenuItem[]>,
  categoryOrder: readonly string[],
  resourceIcons: Record<string, React.ReactNode>,
  onNavigate: (route: string) => void,
): NonNullable<MenuProps['items']> {
  return categoryOrder.flatMap((category) => {
    const items = categorizedResources[category];
    if (!items || items.length === 0) return [];
    return items.map((item) => ({
      key: item.name,
      icon: resourceIcons[item.name],
      label: item.label,
      title: item.label,
      onClick: () => onNavigate(item.route),
    }));
  });
}

/**
 * Hook: compute all data the Sider (desktop) and MobileSiderDrawer
 * (mobile) need to render their menus. Pure helpers (computeSelectedKey,
 * buildCategorizedResources, etc.) are exported separately for unit
 * tests.
 */
export function useSiderMenuItems(input: UseSiderMenuItemsInput): SiderMenuData {
  const {
    resources,
    pathname,
    push,
    categoryOrder,
    categoryMap,
    resourceLabels,
    resourceIcons,
    canViewNavigation,
    canViewSettings,
    canCreateOrders,
    setIsCreateModalOpen,
    crm,
    openExternal,
  } = input;

  const selectedKey = useMemo(
    () => computeSelectedKey(resources, pathname),
    [resources, pathname],
  );

  const categorizedResources = useMemo(
    () =>
      buildCategorizedResources({
        resources,
        categoryOrder,
        categoryMap,
        resourceLabels,
        canViewNavigation,
        canViewSettings,
      }),
    [resources, categoryOrder, categoryMap, resourceLabels, canViewNavigation, canViewSettings],
  );

  const { route: ordersRoute, label: ordersLabel } = useMemo(
    () => resolveOrdersRoute(resources, resourceLabels),
    [resources, resourceLabels],
  );

  const { route: calendarRoute, label: calendarLabel } = useMemo(
    () => resolveCalendarRoute(resources, resourceLabels),
    [resources, resourceLabels],
  );

  const handleNavigate = (route: string) => {
    push(route);
  };

  const handleNewOrder = () => {
    push(ordersRoute);
    setIsCreateModalOpen(true);
  };

  const topMenuItems = buildTopMenuItems({
    canViewNavigation,
    resourceIcons,
    ordersRoute,
    ordersLabel,
    calendarRoute,
    calendarLabel,
    push,
    crm,
    openExternal,
  });

  const flatMenuItems = useMemo(
    () => buildFlatMenuItems(categorizedResources, categoryOrder, resourceIcons, handleNavigate),
    [categorizedResources, categoryOrder, resourceIcons, handleNavigate],
  );

  return {
    topMenuItems,
    flatMenuItems,
    categorizedResources,
    selectedKey,
    canCreateOrders,
    canViewSettings,
    ordersRoute,
    handleNavigate,
    handleNewOrder,
  };
}
