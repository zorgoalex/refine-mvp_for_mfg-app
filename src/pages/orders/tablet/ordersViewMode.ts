export type OrdersViewMode = 'list' | 'cards' | 'board';

const ORDERS_VIEW_VALUES = new Set<unknown>(['list', 'cards', 'board']);
const ORDERS_VIEW_STORAGE_PREFIX = 'erp.ui.tablet.orders.view';

export function isOrdersViewMode(value: unknown): value is OrdersViewMode {
  return ORDERS_VIEW_VALUES.has(value);
}

export function resolveOrdersViewMode(
  queryValue: unknown,
  storedValue: unknown,
  fallback: Exclude<OrdersViewMode, 'board'> = 'list',
): OrdersViewMode {
  if (isOrdersViewMode(queryValue)) return queryValue;
  if (storedValue === 'list' || storedValue === 'cards') return storedValue;
  return fallback;
}

export function ordersViewStorageKey(userId: string | number | null | undefined): string | null {
  if (userId === null || userId === undefined || String(userId).trim() === '') return null;
  return `${ORDERS_VIEW_STORAGE_PREFIX}.${String(userId)}`;
}

export function setOrdersViewQuery(search: string, view: Exclude<OrdersViewMode, 'board'>): string {
  const params = new URLSearchParams(search);
  params.set('view', view);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}
