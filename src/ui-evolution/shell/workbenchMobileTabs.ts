/** Нижняя панель NewLine на телефоне (мокап 22): главные разделы + «Ещё» (всё меню). */
export interface WorkbenchMobileTab {
  resource: string;
  route: string;
  label: string;
}

export const WORKBENCH_MOBILE_TAB_CANDIDATES: readonly WorkbenchMobileTab[] = [
  { resource: 'orders_view', route: '/orders', label: 'Заказы' },
  { resource: 'calendar', route: '/calendar', label: 'Календарь' },
  { resource: 'mdf-work-board', route: '/mdf-work-board', label: 'МДФ' },
  { resource: 'scan', route: '/scan', label: 'Сканер' },
];

export const WORKBENCH_MOBILE_TAB_LIMIT = 4;

/**
 * Только разделы, которые есть в приложении (флаги) и видны пользователю в меню
 * (те же права и видимость, что у бокового меню). Остальное — в «Ещё».
 */
export function resolveWorkbenchMobileTabs(
  availableResources: ReadonlySet<string>,
  canView: (resource: string) => boolean,
): WorkbenchMobileTab[] {
  return WORKBENCH_MOBILE_TAB_CANDIDATES
    .filter((tab) => availableResources.has(tab.resource) && canView(tab.resource))
    .slice(0, WORKBENCH_MOBILE_TAB_LIMIT);
}

export function isWorkbenchMobileTabActive(route: string, pathname: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}
