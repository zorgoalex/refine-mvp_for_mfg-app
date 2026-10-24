// The clients dashboard and the client card: period choice and numbers ready for drawing. Pure helpers.
import dayjs from 'dayjs';
import type { ClientAnalyticsCard, ClientFrequencyBucket, ClientRecencySegment, ClientsDashboardResponse } from '../../api/clientsReadApi';

export const CLIENTS_DASHBOARD_PERIODS = [30, 90, 365] as const;
export type ClientsDashboardPeriod = (typeof CLIENTS_DASHBOARD_PERIODS)[number];

export function clientsDashboardRange(days: ClientsDashboardPeriod, today: string): { dateFrom: string; dateTo: string } {
  return { dateFrom: dayjs(today).subtract(days - 1, 'day').format('YYYY-MM-DD'), dateTo: today };
}

export const RECENCY_LABELS: Record<ClientRecencySegment, { label: string; hint: string }> = {
  active: { label: 'Активные', hint: 'заказ за последние 90 дней' },
  sleeping: { label: 'Спящие', hint: 'последний заказ 91–365 дней назад' },
  lost: { label: 'Потерянные', hint: 'нет заказов больше года' },
  no_orders: { label: 'Без заказов', hint: 'ни одного заказа' },
};

export const FREQUENCY_LABELS: Record<ClientFrequencyBucket, string> = {
  '1': '1 заказ',
  '2-3': '2–3 заказа',
  '4-9': '4–9 заказов',
  '10+': '10 и больше',
};

const number = (value: string | number | null | undefined) => Number(value) || 0;

export interface ClientsDashboardView {
  clients: number;
  newClients: number;
  buyers: number;
  /** Share of the period's buyers who are repeat clients, 0..1; `null` without buyers. */
  repeatShare: number | null;
  repeatBuyers: number;
  orders: number;
  amount: number;
  paid: number;
  averageOrder: number | null;
  /** Average revenue per buying client. */
  averagePerBuyer: number | null;
  days: Array<{ date: string; newClients: number; orders: number; amount: number }>;
  recency: Array<{ segment: ClientRecencySegment; label: string; hint: string; clients: number; amount: number; share: number }>;
  frequency: Array<{ bucket: ClientFrequencyBucket; label: string; clients: number; amount: number; clientShare: number; amountShare: number }>;
  personTypes: Array<{ label: string; buyers: number; orders: number; amount: number; share: number }>;
  top: ClientsDashboardResponse['topClients'];
  reactivate: ClientsDashboardResponse['toReactivate'];
}

export function clientsDashboardView(response: ClientsDashboardResponse): ClientsDashboardView {
  const totals = response.totals;
  const amount = number(totals.amount);
  const frequencyClients = response.byFrequency.reduce((sum, row) => sum + row.clients, 0);
  const frequencyAmount = response.byFrequency.reduce((sum, row) => sum + number(row.amount), 0);
  return {
    clients: totals.clients,
    newClients: totals.newClients,
    buyers: totals.buyers,
    repeatBuyers: totals.repeatBuyers,
    repeatShare: totals.buyers > 0 ? totals.repeatBuyers / totals.buyers : null,
    orders: totals.orders,
    amount,
    paid: number(totals.paid),
    averageOrder: totals.orders > 0 ? amount / totals.orders : null,
    averagePerBuyer: totals.buyers > 0 ? amount / totals.buyers : null,
    days: response.byDay.map((day) => ({ date: day.date, newClients: day.newClients, orders: day.orders, amount: number(day.amount) })),
    recency: response.byRecency.map((row) => ({
      segment: row.segment,
      ...RECENCY_LABELS[row.segment],
      clients: row.clients,
      amount: number(row.amount),
      share: totals.clients > 0 ? row.clients / totals.clients : 0,
    })),
    frequency: response.byFrequency.map((row) => ({
      bucket: row.bucket,
      label: FREQUENCY_LABELS[row.bucket],
      clients: row.clients,
      amount: number(row.amount),
      clientShare: frequencyClients > 0 ? row.clients / frequencyClients : 0,
      amountShare: frequencyAmount > 0 ? number(row.amount) / frequencyAmount : 0,
    })),
    personTypes: response.byPersonType.map((row) => ({
      label: row.personType === 'legal' ? 'Компании' : 'Физические лица',
      buyers: row.buyers,
      orders: row.orders,
      amount: number(row.amount),
      share: amount > 0 ? number(row.amount) / amount : 0,
    })),
    top: response.topClients,
    reactivate: response.toReactivate,
  };
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'] as const;

export interface ClientCardView {
  /** A one-line reading of how the client behaves. */
  summary: string;
  recency: { segment: ClientRecencySegment; label: string };
  amount: number;
  paid: number;
  /** The client's balance: positive — owes, negative — overpaid (the same figure as the list's «Долг»). */
  debt: number;
  /** Paid share of the ordered amount, 0..1. */
  paidShare: number;
  averageOrder: number | null;
  months: Array<{ key: string; label: string; year: string | null; orders: number; amount: number; paid: number; share: number }>;
  paymentTypes: Array<{ name: string; amount: number; count: number; share: number }>;
}

const plural = (value: number, one: string, few: string, many: string) => {
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  return mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
};

export function recencyOf(daysSinceLastOrder: number | null): ClientRecencySegment {
  if (daysSinceLastOrder === null) return 'no_orders';
  if (daysSinceLastOrder <= 90) return 'active';
  return daysSinceLastOrder <= 365 ? 'sleeping' : 'lost';
}

export function clientCardView(card: ClientAnalyticsCard): ClientCardView {
  const totals = card.totals;
  const amount = number(totals.amount);
  const paid = number(totals.paid);
  const segment = recencyOf(totals.daysSinceLastOrder);
  const bestMonth = Math.max(0, ...card.byMonth.map((month) => number(month.amount)));
  const paymentsTotal = card.paymentTypes.reduce((sum, type) => sum + Math.max(0, number(type.amount)), 0);
  const parts: string[] = [];
  if (totals.orders === 0) {
    parts.push('Заказов ещё не было');
  } else {
    parts.push(`${totals.orders} ${plural(totals.orders, 'заказ', 'заказа', 'заказов')}`);
    if (totals.averageIntervalDays !== null) parts.push(`в среднем раз в ${totals.averageIntervalDays} дн.`);
    if (totals.daysSinceLastOrder !== null) {
      parts.push(totals.daysSinceLastOrder === 0 ? 'последний — сегодня' : `последний — ${totals.daysSinceLastOrder} дн. назад`);
    }
  }
  let previousYear: string | null = null;
  return {
    summary: parts.join(' · '),
    recency: { segment, label: RECENCY_LABELS[segment].label },
    amount,
    paid,
    debt: number(totals.debt),
    paidShare: amount > 0 ? Math.min(1, Math.max(0, paid / amount)) : 0,
    averageOrder: totals.orders > 0 ? amount / totals.orders : null,
    months: card.byMonth.map((month) => {
      const [year, monthNumber] = month.month.split('-');
      const yearLabel = year !== previousYear ? year : null;
      previousYear = year;
      const value = number(month.amount);
      return {
        key: month.month,
        label: MONTHS[Number(monthNumber) - 1] ?? month.month,
        year: yearLabel,
        orders: month.orders,
        amount: value,
        paid: number(month.paid),
        share: bestMonth > 0 ? value / bestMonth : 0,
      };
    }),
    paymentTypes: card.paymentTypes.map((type) => {
      const value = number(type.amount);
      return { name: type.typePaidName?.trim() || 'Без типа', amount: value, count: type.count, share: paymentsTotal > 0 ? Math.max(0, value) / paymentsTotal : 0 };
    }),
  };
}
