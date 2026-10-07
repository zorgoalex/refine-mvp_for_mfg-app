/** One order of a client in the «Документы ERP» tab of the client card. Money only for a user who may see order financials. */
export interface ClientOrderDto {
  orderId: number;
  orderName: string;
  /** «<project code>-<order name>», as in the orders list; null without a project code. */
  fullNumber: string | null;
  orderDate: string | null;
  orderStatusName: string | null;
  productionStatusName: string | null;
  paymentStatusName: string | null;
  finalAmount?: number;
  paidAmount?: number;
  debtAmount?: number;
}

/** Money of every order of the client the user may see (all pages). */
export interface ClientOrdersSummaryDto {
  finalAmount: number;
  paidAmount: number;
  debtAmount: number;
}

export interface ClientOrdersResponseDto {
  data: ClientOrderDto[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  /** Which orders the user is shown: all orders of the client or only the user's own (creator or manager). */
  scope: 'all' | 'own';
  /** Absent without `orders.view_financials`. */
  summary?: ClientOrdersSummaryDto;
}

export const CLIENT_ORDERS_PAGE_SIZE_MAX = 100;
