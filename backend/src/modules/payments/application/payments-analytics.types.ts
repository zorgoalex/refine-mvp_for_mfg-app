/** Filters of the payments analytics summary — the same conditions the «+Платежи» list applies. */
export interface PaymentsAnalyticsSummaryQuery {
  /** Inclusive payment-date period; required, at most {@link PAYMENTS_ANALYTICS_MAX_DAYS} days. */
  dateFrom: string;
  dateTo: string;
  orderName?: string;
  clientName?: string;
  notes?: string;
  typePaidName?: string;
  orderStatusName?: string;
  paymentStatusName?: string;
  productionStatusName?: string;
  orderDateFrom?: string;
  orderDateTo?: string;
  amountMin?: number;
  amountMax?: number;
  orderAmountMin?: number;
  orderAmountMax?: number;
  totalPaymentsMin?: number;
  totalPaymentsMax?: number;
  orderBalanceMin?: number;
  orderBalanceMax?: number;
}

/** Longest period the summary covers: bounds the per-day breakdown. */
export const PAYMENTS_ANALYTICS_MAX_DAYS = 366;

export interface PaymentsAnalyticsSummaryDto {
  dateFrom: string;
  dateTo: string;
  /** Payments of the period under the filters. */
  count: number;
  /** Their total, a decimal string with two fraction digits. */
  amount: string;
  /** By payment type, largest total first. */
  byType: Array<{ typePaidName: string | null; count: number; amount: string }>;
  /** By payment day, newest first. */
  byDay: Array<{ paymentDate: string; count: number; amount: string }>;
}

/** Longest period of the dashboard («Поступления по дням» draws one bar per day). */
export const PAYMENTS_DASHBOARD_MAX_DAYS = 92;

export interface PaymentsDashboardQuery {
  /** Inclusive payment-date period, at most {@link PAYMENTS_DASHBOARD_MAX_DAYS} days. */
  dateFrom: string;
  dateTo: string;
}

/** Days since the order date → receivables bucket. */
export const RECEIVABLE_BUCKETS = ['0-7', '8-30', '31-60', '61+'] as const;
export type ReceivableBucket = (typeof RECEIVABLE_BUCKETS)[number];

/**
 * Dashboard of the payments analytics. Payments and orders marked deleted are left out everywhere.
 * Amounts are decimal strings. A receivable is an order handed to the client (status «Выдан» or
 * «Завершен») within the last year that is not fully paid: coalesce(final_amount, total_amount) −
 * paid_amount > 0 (the same debt the clients analytics shows). Its age is counted from the order date.
 */
export interface PaymentsDashboardDto {
  dateFrom: string;
  dateTo: string;
  /** Incoming payments of the period (refunds are not netted here). */
  received: { count: number; amount: string };
  /** Payments with a negative amount. */
  refunds: { count: number; amount: string };
  /** Every day of the period, oldest first; a day without payments is zero. */
  byDay: Array<{ paymentDate: string; count: number; amount: string }>;
  /** Incoming payments by payment type, largest first. */
  byType: Array<{ typePaidName: string | null; count: number; amount: string }>;
  receivables: {
    orders: number;
    amount: string;
    byAge: Array<{ bucket: ReceivableBucket; orders: number; amount: string }>;
    /** Clients with the largest receivables, at most ten. */
    topDebtors: Array<{ clientId: number; clientName: string; orders: number; amount: string; oldestOrderDate: string }>;
  };
}
