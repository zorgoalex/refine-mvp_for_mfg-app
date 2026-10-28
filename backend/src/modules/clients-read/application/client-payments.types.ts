/** One payment of a client in the «Платежи» tab of the client card. */
export interface ClientPaymentDto {
  paymentId: number;
  paymentDate: string;
  amount: number;
  typePaidName: string | null;
  notes: string | null;
  /** The payment came from 1C (it has a 1C key). */
  fromOnec: boolean;
  order: { orderId: number; orderName: string; fullNumber: string | null };
}

export interface ClientPaymentsResponseDto {
  data: ClientPaymentDto[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  /**
   * Which payments the user is shown: of all orders of the client (`all`), only of the user's own orders — creator or
   * manager (`own`), or of the orders the user's payment visibility otherwise allows, e.g. the ones he works on (`restricted`).
   */
  scope: 'all' | 'own' | 'restricted';
  /** Sum of every payment the user is shown (all pages). */
  summary: { amount: number };
}

export const CLIENT_PAYMENTS_PAGE_SIZE_MAX = 100;
