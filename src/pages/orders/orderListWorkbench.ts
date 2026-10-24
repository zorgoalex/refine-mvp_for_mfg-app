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
