// The payments dashboard: period choice and the numbers ready for drawing. Pure helpers.
import dayjs from 'dayjs';
import type { PaymentsDashboardResponse, ReceivableBucket } from '../../api/paymentsAnalyticsApi';

export const DASHBOARD_PERIODS = [7, 30, 90] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];

/** Inclusive period of the last `days` days ending today. */
export function dashboardRange(days: DashboardPeriod, today: string): { dateFrom: string; dateTo: string } {
  return { dateFrom: dayjs(today).subtract(days - 1, 'day').format('YYYY-MM-DD'), dateTo: today };
}

export const RECEIVABLE_BUCKET_LABELS: Record<ReceivableBucket, string> = {
  '0-7': 'до 7 дней',
  '8-30': '8–30 дней',
  '31-60': '31–60 дней',
  '61+': 'больше 60 дней',
};

export interface DashboardView {
  received: number;
  receivedCount: number;
  refunds: number;
  refundsCount: number;
  average: number | null;
  receivables: number;
  receivableOrders: number;
  /** One bar per day; `share` is the height against the best day. */
  days: Array<{ date: string; amount: number; count: number; share: number }>;
  types: Array<{ name: string; amount: number; count: number; share: number }>;
  ages: Array<{ bucket: ReceivableBucket; label: string; amount: number; orders: number; share: number }>;
  debtors: PaymentsDashboardResponse['receivables']['topDebtors'];
}

const number = (value: string | number | null | undefined) => Number(value) || 0;

export function dashboardView(response: PaymentsDashboardResponse): DashboardView {
  const received = number(response.received.amount);
  const receivables = number(response.receivables.amount);
  const bestDay = Math.max(0, ...response.byDay.map((day) => number(day.amount)));
  return {
    received,
    receivedCount: response.received.count,
    refunds: number(response.refunds.amount),
    refundsCount: response.refunds.count,
    average: response.received.count > 0 ? received / response.received.count : null,
    receivables,
    receivableOrders: response.receivables.orders,
    days: response.byDay.map((day) => {
      const amount = number(day.amount);
      return { date: day.paymentDate, amount, count: day.count, share: bestDay > 0 ? amount / bestDay : 0 };
    }),
    types: response.byType.map((type) => {
      const amount = number(type.amount);
      return { name: type.typePaidName?.trim() || 'Без типа', amount, count: type.count, share: received > 0 ? amount / received : 0 };
    }),
    ages: response.receivables.byAge.map((age) => {
      const amount = number(age.amount);
      return { bucket: age.bucket, label: RECEIVABLE_BUCKET_LABELS[age.bucket], amount, orders: age.orders, share: receivables > 0 ? amount / receivables : 0 };
    }),
    debtors: response.receivables.topDebtors,
  };
}
