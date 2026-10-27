// Presentation helpers of the «NewLine» orders list. Display only: tones and hints
// never gate actions and never change the values shown by the other variants.

export type WorkbenchTone = 'neutral' | 'active' | 'ready' | 'warning' | 'danger';

const normalize = (value?: string | null) => (value ?? '').trim().toLowerCase();

export function orderStatusTone(name?: string | null): WorkbenchTone {
  const value = normalize(name);
  if (!value) return 'neutral';
  if (value.includes('готов')) return 'ready';
  if (value.includes('предварит') || value.includes('выдан') || value.includes('закрыт') || value.includes('архив')) return 'neutral';
  if (value.includes('отмен') || value.includes('отказ')) return 'danger';
  return 'active';
}

export function paymentStatusTone(name?: string | null): WorkbenchTone {
  const value = normalize(name);
  if (!value) return 'neutral';
  if (value.startsWith('не оплач')) return 'danger';
  if (value.startsWith('частично')) return 'warning';
  if (value.startsWith('оплач')) return 'ready';
  return 'neutral';
}

export interface WorkbenchDeadlineHint {
  text: string;
  tone: WorkbenchTone;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const toLocalDay = (value: unknown): number | null => {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  // «YYYY-MM-DD…» is a calendar date: take it as written, without a timezone shift.
  const parts = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value) : null;
  if (parts) return new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])).getTime();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/** Hint under the planned date. Issued/completed orders are never called overdue. */
export function orderDeadlineHint(
  order: { planned_completion_date?: unknown; issue_date?: unknown; completion_date?: unknown },
  now: Date = new Date(),
): WorkbenchDeadlineHint | null {
  const planned = toLocalDay(order.planned_completion_date);
  if (planned === null) return null;
  if (toLocalDay(order.issue_date) !== null) return { text: 'выдан', tone: 'neutral' };
  if (toLocalDay(order.completion_date) !== null) return { text: 'выполнен', tone: 'neutral' };
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.round((planned - today) / DAY_MS);
  if (days < 0) return { text: `просрочено ${Math.abs(days)} дн.`, tone: 'danger' };
  if (days === 0) return { text: 'сегодня', tone: 'warning' };
  if (days === 1) return { text: 'завтра', tone: 'warning' };
  return { text: `через ${days} дн.`, tone: days <= 2 ? 'warning' : 'neutral' };
}

const WORKBENCH_LEADING_COLUMNS = [
  'order_name',
  'project_code',
  'client_name',
  'order_status_name',
  'production_status_name',
  'planned_completion_date',
  'final_amount',
  'payment_status_name',
  'material_name',
  'film_name',
  'milling_type_name',
];

/**
 * Default column order of the «NewLine» list: what the manager reads first goes first.
 * Returns exactly the given keys (nothing added, nothing dropped); a saved user order wins.
 */
export function orderListWorkbenchDefaultOrder(keys: readonly string[]): string[] {
  const available = new Set(keys);
  const leading = WORKBENCH_LEADING_COLUMNS.filter((key) => available.has(key));
  const leadingSet = new Set(leading);
  return [...leading, ...keys.filter((key) => !leadingSet.has(key))];
}

/** «NewLine», mockup 03: grouping of the loaded page of the orders list (the server order is kept inside a group). */
export type OrderListGrouping = 'none' | 'status' | 'deadline';

export const ORDER_LIST_GROUPINGS: ReadonlyArray<{ value: OrderListGrouping; label: string }> = [
  { value: 'none', label: 'Без группировки' },
  { value: 'status', label: 'По статусу' },
  { value: 'deadline', label: 'По сроку' },
];

const DEADLINE_GROUPS = [
  { key: 'overdue', label: 'Просрочено' },
  { key: 'today', label: 'Сегодня' },
  { key: 'week', label: 'Ближайшие 7 дней' },
  { key: 'later', label: 'Позже' },
  { key: 'none', label: 'Без срока' },
  { key: 'done', label: 'Выполнены и выданы' },
] as const;

type GroupableOrder = {
  order_status_name?: unknown;
  planned_completion_date?: unknown;
  issue_date?: unknown;
  completion_date?: unknown;
};

export function orderDeadlineGroupKey(order: GroupableOrder, now: Date = new Date()): (typeof DEADLINE_GROUPS)[number]['key'] {
  if (toLocalDay(order.issue_date) !== null || toLocalDay(order.completion_date) !== null) return 'done';
  const planned = toLocalDay(order.planned_completion_date);
  if (planned === null) return 'none';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.round((planned - today) / DAY_MS);
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days <= 7) return 'week';
  return 'later';
}

export interface OrderListGroup<T> {
  key: string;
  label: string;
  rows: T[];
}

/** Groups in a stable order: deadlines — from overdue to done; statuses — as they first appear on the page. */
export function groupOrderRows<T extends GroupableOrder>(rows: readonly T[], grouping: OrderListGrouping, now: Date = new Date()): OrderListGroup<T>[] {
  if (grouping === 'none') return [{ key: 'all', label: '', rows: [...rows] }];
  if (grouping === 'deadline') {
    return DEADLINE_GROUPS
      .map((group) => ({ key: group.key, label: group.label, rows: rows.filter((row) => orderDeadlineGroupKey(row, now) === group.key) }))
      .filter((group) => group.rows.length > 0);
  }
  const groups = new Map<string, OrderListGroup<T>>();
  for (const row of rows) {
    const name = typeof row.order_status_name === 'string' && row.order_status_name.trim() ? row.order_status_name.trim() : 'Без статуса';
    const group = groups.get(name) ?? { key: name, label: name, rows: [] };
    group.rows.push(row);
    groups.set(name, group);
  }
  return [...groups.values()];
}

/** «NewLine», mockup 03: quick periods over the order date — the same «Дата заказа» filter as in the form. */
export type OrderListPeriod = 'all' | 'today' | 'week' | '30d' | 'quarter';

export const ORDER_LIST_PERIODS: ReadonlyArray<{ value: OrderListPeriod; label: string }> = [
  { value: 'all', label: 'Все' },
  { value: 'today', label: 'Сегодня' },
  { value: 'week', label: 'Эта неделя' },
  { value: '30d', label: '30 дней' },
  { value: 'quarter', label: 'Квартал' },
];

const isoDay = (date: Date): string => {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** [from, to] as YYYY-MM-DD; `null` — no date limit. The week starts on Monday; the quarter is the calendar one. */
export function orderListPeriodRange(period: OrderListPeriod, now: Date = new Date()): [string, string] | null {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'all') return null;
  if (period === 'today') return [isoDay(today), isoDay(today)];
  if (period === 'week') {
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return [isoDay(monday), isoDay(sunday)];
  }
  if (period === '30d') {
    const from = new Date(today);
    from.setDate(today.getDate() - 29);
    return [isoDay(from), isoDay(today)];
  }
  const quarterStart = new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1);
  const quarterEnd = new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3 + 3, 0);
  return [isoDay(quarterStart), isoDay(quarterEnd)];
}

/** Which quick period the current order-date filter is: `null` — a custom range. */
export function orderListPeriodOf(filters: ReadonlyArray<{ field?: unknown; operator?: unknown; value?: unknown }>, now: Date = new Date()): OrderListPeriod | null {
  const from = filters.find((filter) => filter.field === 'order_date' && filter.operator === 'gte')?.value;
  const to = filters.find((filter) => filter.field === 'order_date' && filter.operator === 'lte')?.value;
  if (from === undefined && to === undefined) return 'all';
  for (const option of ORDER_LIST_PERIODS) {
    const range = orderListPeriodRange(option.value, now);
    if (range && range[0] === from && range[1] === to) return option.value;
  }
  return null;
}
