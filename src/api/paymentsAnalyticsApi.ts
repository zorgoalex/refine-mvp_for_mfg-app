import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';

/** Filters of the analytics summary; the period is required. Mirrors the backend query. */
export interface PaymentsAnalyticsSummaryParams {
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

export interface PaymentsAnalyticsSummaryResponse {
  dateFrom: string;
  dateTo: string;
  count: number;
  /** Decimal string. */
  amount: string;
  byType: Array<{ typePaidName: string | null; count: number; amount: string }>;
  byDay: Array<{ paymentDate: string; count: number; amount: string }>;
}

export type ReceivableBucket = '0-7' | '8-30' | '31-60' | '61+';

export interface PaymentsDashboardResponse {
  dateFrom: string;
  dateTo: string;
  received: { count: number; amount: string };
  refunds: { count: number; amount: string };
  byDay: Array<{ paymentDate: string; count: number; amount: string }>;
  byType: Array<{ typePaidName: string | null; count: number; amount: string }>;
  receivables: {
    orders: number;
    amount: string;
    byAge: Array<{ bucket: ReceivableBucket; orders: number; amount: string }>;
    topDebtors: Array<{ clientId: number; clientName: string; orders: number; amount: string; oldestOrderDate: string }>;
  };
}

/** «+Платежи (аналитика)»: итоги периода считает backend (право finance.analytics.view проверяется там же). */
export const paymentsAnalyticsApi = {
  summary(params: PaymentsAnalyticsSummaryParams): Promise<PaymentsAnalyticsSummaryResponse> {
    return httpClient.get<PaymentsAnalyticsSummaryResponse>(withQuery(apiRoutes.paymentsAnalytics.summary, params));
  },

  dashboard(params: { dateFrom: string; dateTo: string }): Promise<PaymentsDashboardResponse> {
    return httpClient.get<PaymentsDashboardResponse>(withQuery(apiRoutes.paymentsAnalytics.dashboard, params));
  },
};
