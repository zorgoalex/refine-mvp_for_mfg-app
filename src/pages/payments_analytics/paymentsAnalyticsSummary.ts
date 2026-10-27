// Totals of the «+Платежи» analytics screen: what came in for the period, how it splits by payment
// type and by day. Pure functions: the page passes the current list filters, the backend counts.
import dayjs from 'dayjs';
import type { PaymentsAnalyticsSummaryParams, PaymentsAnalyticsSummaryResponse } from '../../api/paymentsAnalyticsApi';

export interface AnalyticsFilter { field?: unknown; operator?: unknown; value?: unknown }

/** Days covered when the list has no payment-date filter of its own. */
export const SUMMARY_DEFAULT_DAYS = 30;
/** Longest period the backend summarises. */
export const SUMMARY_MAX_DAYS = 366;

type ParamKey = Exclude<keyof PaymentsAnalyticsSummaryParams, 'dateFrom' | 'dateTo'>;
/** List filter (`field:operator`) → summary parameter. Anything else the summary cannot follow. */
const PARAM_BY_FILTER: Record<string, ParamKey> = {
  'order_name:contains': 'orderName',
  'client_name:contains': 'clientName',
  'notes:contains': 'notes',
  'type_paid_name:eq': 'typePaidName',
  'order_status_name:eq': 'orderStatusName',
  'payment_status_name:eq': 'paymentStatusName',
  'production_status_name:eq': 'productionStatusName',
  'order_date:gte': 'orderDateFrom',
  'order_date:lte': 'orderDateTo',
  'amount:gte': 'amountMin',
  'amount:lte': 'amountMax',
  'order_effective_final_amount:gte': 'orderAmountMin',
  'order_effective_final_amount:lte': 'orderAmountMax',
  'total_payments_for_order:gte': 'totalPaymentsMin',
  'total_payments_for_order:lte': 'totalPaymentsMax',
  'order_balance_total:gte': 'orderBalanceMin',
  'order_balance_total:lte': 'orderBalanceMax',
};

export interface SummaryScope {
  /** Request for the backend; `null` when the summary cannot be shown (see `problem`). */
  params: PaymentsAnalyticsSummaryParams | null;
  from: string;
  to: string;
  /** The list had no payment-date filter: the last 30 days are shown. */
  defaulted: boolean;
  problem: 'period_too_long' | 'unsupported_filter' | null;
}

/**
 * Whether the backend reads a text filter exactly as the list does. The list (Hasura `_ilike`) treats
 * `%`, `_` and `\` as pattern characters and keeps outer spaces; the summary matches the text
 * literally and trims it. A value where the two would differ is not summarised.
 */
export function isPlainSearchText(value: string): boolean {
  return value === value.trim() && !/[%_\\]/.test(value);
}

/** The summary request for the same rows the list shows; without a payment-date filter — the last 30 days. */
export function summaryScope(filters: readonly AnalyticsFilter[] | undefined, today: string): SummaryScope {
  const rest: Partial<Record<ParamKey, string | number>> = {};
  let from: string | null = null;
  let to: string | null = null;
  let unsupported = false;
  for (const filter of filters ?? []) {
    const field = typeof filter?.field === 'string' ? filter.field : null;
    const operator = typeof filter?.operator === 'string' ? filter.operator : null;
    const value = filter?.value;
    if (value === undefined || value === null || value === '') continue;
    if (!field || !operator || (typeof value !== 'string' && typeof value !== 'number')) { unsupported = true; continue; }
    if (field === 'payment_date' && typeof value === 'string' && (operator === 'gte' || operator === 'lte' || operator === 'eq')) {
      if (operator !== 'lte') from = value;
      if (operator !== 'gte') to = value;
      continue;
    }
    const param = PARAM_BY_FILTER[`${field}:${operator}`];
    if (!param || (typeof value === 'string' && !isPlainSearchText(value))) { unsupported = true; continue; }
    rest[param] = value;
  }
  const defaulted = from === null && to === null;
  const end = to ?? today;
  const start = from ?? dayjs(end).subtract(SUMMARY_DEFAULT_DAYS - 1, 'day').format('YYYY-MM-DD');
  const days = dayjs(end).diff(dayjs(start), 'day') + 1;
  const problem = unsupported ? 'unsupported_filter' : days > SUMMARY_MAX_DAYS || days < 1 ? 'period_too_long' : null;
  return {
    params: problem ? null : { dateFrom: start, dateTo: end, ...rest } as PaymentsAnalyticsSummaryParams,
    from: start,
    to: end,
    defaulted,
    problem,
  };
}

export interface SummaryPart { name: string; amount: number; share: number }
export interface SummaryDay { count: number; amount: number }
export interface PaymentsSummary {
  count: number;
  amount: number;
  parts: SummaryPart[];
  days: Record<string, SummaryDay>;
}

/** The backend answer ready for the tiles: types largest first with the tail folded into «Прочие», days by date. */
export function summarize(response: PaymentsAnalyticsSummaryResponse, maxParts = 4): PaymentsSummary {
  const amount = Number(response.amount) || 0;
  const types = response.byType.map((part) => ({ name: part.typePaidName?.trim() || 'Без типа', amount: Number(part.amount) || 0 }));
  const head = types.slice(0, maxParts);
  const tail = types.slice(maxParts).reduce((sum, part) => sum + part.amount, 0);
  if (tail !== 0) head.push({ name: 'Прочие', amount: tail });
  const days: Record<string, SummaryDay> = {};
  for (const day of response.byDay) days[day.paymentDate] = { count: day.count, amount: Number(day.amount) || 0 };
  return {
    count: response.count,
    amount,
    parts: head.map((part) => ({ ...part, share: amount > 0 ? Math.max(0, part.amount) / amount : 0 })),
    days,
  };
}

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'] as const;

/** «чт, 01.10» — a short day label for the first row of a day. */
export function dayLabel(date: string): string {
  const day = dayjs(date);
  return day.isValid() ? `${WEEKDAYS[day.day()]}, ${day.format('DD.MM')}` : date;
}
