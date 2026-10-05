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
