import type { PermissionCarrier } from './permissions';
import { canViewOrderFinancials } from './orderFinancialVisibility';

/**
 * Access groups «финансы» (plan 2026-10-17 §4): the money columns of these Hasura sources are no longer selectable on
 * the row (metadata step F2); they come through the object relationship `financials`, which Hasura answers only for a
 * user with orders.view_financials and the right to the row (null otherwise). Mirror of
 * ops/hasura/access-predicates.json `financials.sources[*].financialColumns` (guard test).
 */
export const HASURA_FINANCIAL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  orders_view: ['payment_status_name', 'total_amount', 'final_amount', 'discount', 'surcharge', 'paid_amount', 'payment_date'],
  order_details: ['milling_cost_per_sqm', 'detail_cost'],
  order_details_view: ['milling_cost_per_sqm', 'detail_cost'],
  doweling_orders: ['payment_status_id', 'total_amount', 'final_amount', 'discount', 'surcharge', 'paid_amount', 'payment_date'],
  doweling_orders_view: ['payment_status_name', 'total_amount', 'final_amount', 'discount', 'surcharge', 'paid_amount', 'payment_date'],
};

export const HASURA_FINANCIALS_RELATIONSHIP = 'financials';

/**
 * Sources whose money is fetched only when a call asks for it (`meta: { financials: true }`): order details. With the
 * backend flags on they come from the backend, and their Hasura reads (calendar details, material names) show no
 * money; the legacy paths that do show it (flags off) ask explicitly. Orders and doweling orders bring money by default
 * (their lists and cards show it, also on the legacy path).
 */
export const HASURA_FINANCIALS_ON_DEMAND: ReadonlySet<string> = new Set(['order_details', 'order_details_view']);

export function wantsHasuraFinancials(resource: string, meta?: { financials?: boolean } | null): boolean {
  return !HASURA_FINANCIALS_ON_DEMAND.has(resource) || meta?.financials === true;
}

export function isHasuraFinancialField(resource: string, field: string): boolean {
  return HASURA_FINANCIAL_FIELDS[resource]?.includes(field) ?? false;
}

/** Whether to ask Hasura for the money at all: the permission only (the UI visibility matrix hides it on screen). */
export function requestsHasuraFinancials(user: PermissionCarrier | null | undefined): boolean {
  return canViewOrderFinancials(user);
}

/** The row's own fields without money, plus `financials { … }` when the call wants money and the user may read it. */
export function selectionWithFinancials(
  resource: string,
  fields: readonly string[],
  user: PermissionCarrier | null | undefined,
  meta?: { financials?: boolean } | null,
): string[] {
  const money = HASURA_FINANCIAL_FIELDS[resource];
  if (!money) return [...fields];
  const own = fields.filter((field) => !money.includes(field));
  const wanted = money.filter((field) => fields.includes(field));
  if (wanted.length === 0 || !wantsHasuraFinancials(resource, meta) || !requestsHasuraFinancials(user)) return own;
  return [...own, `${HASURA_FINANCIALS_RELATIONSHIP} { ${wanted.join(' ')} }`];
}

/**
 * Puts the money of `financials` back on the row (screens keep reading `record.final_amount`). Without the right the
 * relationship is null and the money fields are absent — never a 0 that would read as «nothing paid».
 */
export function flattenFinancials<T>(resource: string, row: T): T {
  if (!HASURA_FINANCIAL_FIELDS[resource] || !row || typeof row !== 'object') return row;
  const { [HASURA_FINANCIALS_RELATIONSHIP]: money, ...rest } = row as Record<string, unknown>;
  return (money && typeof money === 'object' ? { ...rest, ...(money as Record<string, unknown>) } : rest) as T;
}

export function flattenFinancialRows<T>(resource: string, rows: T[] | null | undefined): T[] | null | undefined {
  if (!rows || !HASURA_FINANCIAL_FIELDS[resource]) return rows;
  return rows.map((row) => flattenFinancials(resource, row));
}

/** Whether the money of a row arrived (the relationship answered): the readiness of a form that may edit money. */
export function hasHasuraFinancials(resource: string, row: unknown): boolean {
  const money = HASURA_FINANCIAL_FIELDS[resource];
  if (!money || !row || typeof row !== 'object') return false;
  return money.every((field) => field in (row as Record<string, unknown>));
}

/**
 * The path of a sort or filter on a money field: through `financials`, or null when the user may not read money (the
 * condition is dropped, as the backend refuses financial list controls without the right).
 */
export function financialFieldPath(resource: string, field: string, user: PermissionCarrier | null | undefined): string | null | undefined {
  if (!isHasuraFinancialField(resource, field)) return undefined;
  return requestsHasuraFinancials(user) ? HASURA_FINANCIALS_RELATIONSHIP : null;
}
