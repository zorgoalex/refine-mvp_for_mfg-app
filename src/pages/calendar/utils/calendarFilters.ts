import type { CalendarFilters, CalendarOrder } from '../types/calendar';

const FILTER_KEYS: Array<keyof CalendarFilters> = [
  'quickSearch',
  'orderQuery',
  'clientQuery',
  'materialName',
  'millingTypeName',
  'paymentStatusName',
  'orderStatusName',
];

const normalize = (value: unknown) => String(value ?? '').trim().toLowerCase();

const hasValue = (value: unknown): boolean => normalize(value).length > 0;

const includesNormalized = (value: unknown, query: unknown): boolean => {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return true;
  return normalize(value).includes(normalizedQuery);
};

const equalsNormalized = (value: unknown, query: unknown): boolean => {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return true;
  return normalize(value) === normalizedQuery;
};

const orderTextFields = (order: CalendarOrder) => [
  order.order_name,
  order.order_id,
  order.doweling_order_name,
];

const detailMaterialNames = (order: CalendarOrder) =>
  (order.order_details ?? [])
    .map((detail) => detail.material?.material_name)
    .filter(Boolean);

const detailMillingNames = (order: CalendarOrder) =>
  (order.order_details ?? [])
    .map((detail) => detail.milling_type?.milling_type_name)
    .filter(Boolean);

export const getCalendarActiveFilterCount = (filters: CalendarFilters): number =>
  FILTER_KEYS.reduce((count, key) => count + (hasValue(filters[key]) ? 1 : 0), 0);

export const hasCalendarActiveFilters = (filters: CalendarFilters): boolean =>
  getCalendarActiveFilterCount(filters) > 0;

export const cleanCalendarFilters = (filters: CalendarFilters): CalendarFilters =>
  FILTER_KEYS.reduce<CalendarFilters>((next, key) => {
    const value = String(filters[key] ?? '').trim();
    if (value) next[key] = value;
    return next;
  }, {});

export const matchesCalendarFilters = (
  order: CalendarOrder,
  filters: CalendarFilters,
): boolean => {
  if (hasValue(filters.quickSearch)) {
    const quickMatches = [
      ...orderTextFields(order),
      order.client_name,
    ].some((value) => includesNormalized(value, filters.quickSearch));
    if (!quickMatches) return false;
  }

  if (hasValue(filters.orderQuery)) {
    const orderMatches = orderTextFields(order).some((value) =>
      includesNormalized(value, filters.orderQuery),
    );
    if (!orderMatches) return false;
  }

  if (hasValue(filters.clientQuery) && !includesNormalized(order.client_name, filters.clientQuery)) {
    return false;
  }

  if (hasValue(filters.materialName)) {
    const materialMatches = detailMaterialNames(order).some((name) =>
      includesNormalized(name, filters.materialName),
    );
    if (!materialMatches) return false;
  }

  if (hasValue(filters.millingTypeName)) {
    const millingMatches = detailMillingNames(order).some((name) =>
      includesNormalized(name, filters.millingTypeName),
    );
    if (!millingMatches) return false;
  }

  if (hasValue(filters.paymentStatusName) && !equalsNormalized(order.payment_status_name, filters.paymentStatusName)) {
    return false;
  }

  if (hasValue(filters.orderStatusName) && !equalsNormalized(order.order_status_name, filters.orderStatusName)) {
    return false;
  }

  return true;
};

export const applyCalendarFilters = (
  orders: CalendarOrder[],
  filters: CalendarFilters,
): CalendarOrder[] => {
  if (!hasCalendarActiveFilters(filters)) return orders;
  return orders.filter((order) => matchesCalendarFilters(order, filters));
};
