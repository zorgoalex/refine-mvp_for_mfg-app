import type { IResourceItem } from '@refinedev/core';
import type { MenuProps } from 'antd';
import { useMemo } from 'react';
import type { SidebarMenuOrderPreference } from '../api/types/profileApi.types';

export type SiderResource = IResourceItem;

export interface SiderMenuItem {
  name: string;
  label: string;
  route: string;
}

export interface SiderMenuOrderItem {
  key: string;
  label: string;
}

export interface SidebarMenuOrderDefaults {
  top: string[];
  categories: string[];
  resources: Record<string, string[]>;
}

export interface SiderMenuData {
  topMenuItems: NonNullable<MenuProps['items']>;
  topMenuOrderItems: SiderMenuOrderItem[];
  flatMenuItems: NonNullable<MenuProps['items']>;
  categorizedResources: Record<string, SiderMenuItem[]>;
  categoryOrder: string[];
  menuOrderDefaults: SidebarMenuOrderDefaults;
  menuOrderSettings: SidebarMenuOrderPreference;
  selectedKey: string;
  canCreateOrders: boolean;
  canViewSettings: boolean;
  ordersRoute: string;
  calendarRoute: string;
  statusBoardRoute: string | null;
  handleNavigate: (route: string) => void;
  handleNewOrder: () => void;
}

/** External CRM link rendered in the top menu, below Calendar. */
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
  /** Optional current-user ordering for the sidebar menu. */
  sidebarMenuOrder?: Partial<SidebarMenuOrderPreference> | null;
  /** Injectable external-link opener (default: window.open in a new tab). */
  openExternal?: (url: string) => void;
}

/**
 * Stable target name so the CRM tab is reused instead of spawning a new one.
 * Reuses one named external tab so repeated clicks focus it without reloading.
 */
export const CRM_WINDOW_NAME = 'erpCrmWindow';

/** Minimal window surface used by the opener (eases testing). */
interface OpenerWindow {
  open(url: string, target: string): WindowProxyLike | null;
}
interface WindowProxyLike {
  closed: boolean;
  focus(): void;
}

/**
 * Build a CRM opener that keeps ONE warm tab.
 *
 * Calling `window.open(url, name)` with a URL re-navigates (reloads) an existing
 * named tab every time — the SPA blanks and refetches, costing seconds. So we
 * retain a reference to the opened window and, while it is still open, just
 * `focus()` it WITHOUT passing a URL (no reload). We only open a fresh tab when
 * none exists yet or the user closed it. The reference lives in module scope and
 * survives ERP's in-app route changes (it is a single-page app).
 */
export function makeCrmOpener(
  getWindow: () => OpenerWindow | undefined = () =>
    (typeof window !== 'undefined' ? (window as unknown as OpenerWindow) : undefined),
): (url: string) => void {
  let ref: WindowProxyLike | null = null;
  return (url: string) => {
    const w = getWindow();
    if (!w) return;
    if (ref && !ref.closed) {
      ref.focus(); // reuse the warm tab — do NOT re-navigate
      return;
    }
    ref = w.open(url, CRM_WINDOW_NAME);
  };
}

const defaultOpenExternal = makeCrmOpener();

function uniqueKnownKeys(keys: readonly string[] | undefined, allowed: Set<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const key of keys ?? []) {
    if (!allowed.has(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

export function applySidebarOrder(defaultOrder: readonly string[], preferredOrder?: readonly string[] | null): string[] {
  const allowed = new Set(defaultOrder);
  return uniqueKnownKeys([...(preferredOrder ?? []), ...defaultOrder], allowed);
}

export function normalizeSidebarMenuOrderPreference(
  defaults: SidebarMenuOrderDefaults,
  value?: Partial<SidebarMenuOrderPreference> | null,
): SidebarMenuOrderPreference {
  const resources: Record<string, string[]> = {};
  for (const category of defaults.categories) {
    resources[category] = applySidebarOrder(
      defaults.resources[category] ?? [],
      value?.resources?.[category],
    );
  }

  return {
    top: applySidebarOrder(defaults.top, value?.top),
    categories: applySidebarOrder(defaults.categories, value?.categories),
    resources,
  };
}

export function buildSidebarMenuOrderDefaults(args: {
  topMenuItems: NonNullable<MenuProps['items']>;
  categoryOrder: readonly string[];
  categorizedResources: Record<string, SiderMenuItem[]>;
}): SidebarMenuOrderDefaults {
  const top = extractMenuOrderItems(args.topMenuItems).map((item) => item.key);
  return {
    top,
    categories: [...args.categoryOrder],
    resources: Object.fromEntries(
      args.categoryOrder.map((category) => [
        category,
        (args.categorizedResources[category] ?? []).map((item) => item.name),
      ]),
    ),
  };
}

export function extractMenuOrderItems(items: NonNullable<MenuProps['items']>): SiderMenuOrderItem[] {
  return items
    .map((item) => {
      if (!item || typeof item !== 'object' || !('key' in item)) return null;
      const key = String((item as { key?: unknown }).key ?? '');
      if (!key) return null;
      const title = (item as { title?: unknown }).title;
      const label = (item as { label?: unknown }).label;
      return {
        key,
        label: typeof title === 'string'
          ? title
          : typeof label === 'string'
            ? label
            : key,
      };
    })
    .filter((item): item is SiderMenuOrderItem => Boolean(item));
}

function orderMenuItems(
  items: NonNullable<MenuProps['items']>,
  order?: readonly string[] | null,
): NonNullable<MenuProps['items']> {
  const byKey = new Map<string, NonNullable<MenuProps['items']>[number]>();
  for (const item of items) {
    if (!item || typeof item !== 'object' || !('key' in item)) continue;
    const key = String((item as { key?: unknown }).key ?? '');
    if (key) byKey.set(key, item);
  }

  const result: NonNullable<MenuProps['items']> = [];
  for (const key of order ?? []) {
    const item = byKey.get(key);
    if (!item) continue;
    result.push(item);
    byKey.delete(key);
  }
  result.push(...byKey.values());
  return result;
}

export function applySidebarMenuOrderToResources(
  categorizedResources: Record<string, SiderMenuItem[]>,
  categoryOrder: readonly string[],
  order: SidebarMenuOrderPreference,
): Record<string, SiderMenuItem[]> {
  const result: Record<string, SiderMenuItem[]> = {};
  for (const category of categoryOrder) {
    const items = categorizedResources[category] ?? [];
    const byName = new Map(items.map((item) => [item.name, item]));
    result[category] = [];
    for (const name of order.resources[category] ?? []) {
      const item = byName.get(name);
      if (!item) continue;
      result[category].push(item);
      byName.delete(name);
    }
    result[category].push(...byName.values());
  }
  return result;
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
  statusBoard?: { route: string; label: string } | null;
  push: (route: string) => void;
  crm?: TopMenuCrmInput | null;
  openExternal?: (url: string) => void;
  order?: readonly string[] | null;
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
    args.statusBoard && args.canViewNavigation('order-status-board')
      ? {
          key: 'order-status-board',
          icon: args.resourceIcons['order-status-board'],
          label: args.statusBoard.label,
          title: args.statusBoard.label,
          onClick: () => args.push(args.statusBoard!.route),
        }
      : null,
    args.crm && args.canViewNavigation('crm')
      ? {
          key: 'crm',
          icon: args.crm.icon,
          label: args.crm.label,
          title: args.crm.label,
          onClick: () => openExternal(args.crm!.url),
        }
      : null,
  ];
  return orderMenuItems(items.filter(Boolean) as NonNullable<MenuProps['items']>, args.order);
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
    if (
      resource.name === 'orders_view' ||
      resource.name === 'calendar' ||
      resource.name === 'order-status-board'
    ) {
      return;
    }
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

/** Pick the status-board resource route and label with safe fallbacks. */
export function resolveStatusBoardRoute(
  resources: SiderResource[],
  resourceLabels: Record<string, string>,
): { route: string; label: string } {
  const resource = resources.find((item) => item.name === 'order-status-board');
  const route =
    typeof resource?.list === 'string' ? resource.list : '/order-status-board';
  const label = resourceLabels['order-status-board'] || 'Доски статусов';
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
    sidebarMenuOrder,
    openExternal,
  } = input;

  const selectedKey = useMemo(
    () => computeSelectedKey(resources, pathname),
    [resources, pathname],
  );

  const defaultCategorizedResources = useMemo(
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

  const statusBoard = useMemo(
    () =>
      resources.some((resource) => resource.name === 'order-status-board')
        ? resolveStatusBoardRoute(resources, resourceLabels)
        : null,
    [resources, resourceLabels],
  );

  const handleNavigate = (route: string) => {
    push(route);
  };

  const handleNewOrder = () => {
    push(ordersRoute);
    setIsCreateModalOpen(true);
  };

  const defaultTopMenuItems = useMemo(
    () => buildTopMenuItems({
      canViewNavigation,
      resourceIcons,
      ordersRoute,
      ordersLabel,
      calendarRoute,
      calendarLabel,
      statusBoard,
      push,
      crm,
      openExternal,
    }),
    [
      canViewNavigation,
      resourceIcons,
      ordersRoute,
      ordersLabel,
      calendarRoute,
      calendarLabel,
      statusBoard,
      push,
      crm,
      openExternal,
    ],
  );

  const menuOrderDefaults = useMemo(
    () => buildSidebarMenuOrderDefaults({
      topMenuItems: defaultTopMenuItems,
      categoryOrder,
      categorizedResources: defaultCategorizedResources,
    }),
    [defaultTopMenuItems, categoryOrder, defaultCategorizedResources],
  );

  const menuOrderSettings = useMemo(
    () => normalizeSidebarMenuOrderPreference(menuOrderDefaults, sidebarMenuOrder),
    [menuOrderDefaults, sidebarMenuOrder],
  );

  const topMenuItems = useMemo(
    () => orderMenuItems(defaultTopMenuItems, menuOrderSettings.top),
    [defaultTopMenuItems, menuOrderSettings.top],
  );

  const categorizedResources = useMemo(
    () => applySidebarMenuOrderToResources(
      defaultCategorizedResources,
      categoryOrder,
      menuOrderSettings,
    ),
    [defaultCategorizedResources, categoryOrder, menuOrderSettings],
  );

  const orderedCategoryOrder = menuOrderSettings.categories;

  const flatMenuItems = useMemo(
    () => buildFlatMenuItems(categorizedResources, orderedCategoryOrder, resourceIcons, handleNavigate),
    [categorizedResources, orderedCategoryOrder, resourceIcons, handleNavigate],
  );

  return {
    topMenuItems,
    topMenuOrderItems: extractMenuOrderItems(defaultTopMenuItems),
    flatMenuItems,
    categorizedResources,
    categoryOrder: orderedCategoryOrder,
    menuOrderDefaults,
    menuOrderSettings,
    selectedKey,
    canCreateOrders,
    canViewSettings,
    ordersRoute,
    calendarRoute,
    statusBoardRoute: statusBoard?.route ?? null,
    handleNavigate,
    handleNewOrder,
  };
}
