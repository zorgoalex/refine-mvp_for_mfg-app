/**
 * Sorting of the «Заказы» and «Платежи» tabs of the client card. The keys are a closed list; the SQL behind each key is
 * fixed in the repositories (never built from the request). Sorting happens in the database over all pages.
 */
export type SortDirection = 'asc' | 'desc';

export const CLIENT_ORDER_SORT_KEYS = ['number', 'date', 'status', 'production', 'payment', 'final', 'paid', 'debt'] as const;
export type ClientOrderSortKey = typeof CLIENT_ORDER_SORT_KEYS[number];

/**
 * Financial columns (the payment status and the money): ordering by them reveals the values, so it needs the right to see
 * order money — as the payment status sort of the orders list.
 */
export const CLIENT_ORDER_MONEY_SORT_KEYS: readonly ClientOrderSortKey[] = ['payment', 'final', 'paid', 'debt'];

export const CLIENT_PAYMENT_SORT_KEYS = ['date', 'amount', 'type', 'order', 'notes'] as const;
export type ClientPaymentSortKey = typeof CLIENT_PAYMENT_SORT_KEYS[number];

export interface TabSort<K extends string> { key: K; direction: SortDirection }

/** Newest first — the order of both tabs when nothing is chosen. */
export const DEFAULT_ORDER_SORT: TabSort<ClientOrderSortKey> = { key: 'date', direction: 'desc' };
export const DEFAULT_PAYMENT_SORT: TabSort<ClientPaymentSortKey> = { key: 'date', direction: 'desc' };

/**
 * Natural order of an order number («12» before «101», «101-2» after «101»): the leading digits as a number, then the
 * whole text. `column` is a fixed SQL expression from the repository.
 */
export const orderNumberSortSql = (column: string, direction: 'ASC' | 'DESC') =>
  `NULLIF(substring(${column} from '^[0-9]{1,18}'), '')::numeric ${direction} NULLS LAST, ${column} ${direction} NULLS LAST`;

export const sqlDirection = (direction: SortDirection): 'ASC' | 'DESC' => (direction === 'asc' ? 'ASC' : 'DESC');
