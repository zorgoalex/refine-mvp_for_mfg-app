// «Платежи → Поступления 1С»: зеркало DTO backend (modules/payments-onec/application/onec-receipts.types.ts).

export type OnecReceiptState =
  | 'matched' | 'changed' | 'dismissed' | 'inactive' | 'foreign_currency' | 'no_erp_order' | 'to_create' | 'review'
  | 'refund_review' | 'refund_info';

export type OnecReceiptGroup = 'review' | 'to_create' | 'matched' | 'dismissed' | 'no_erp_order' | 'refunds' | 'other';

export interface OnecReceiptListParams {
  page: number;
  pageSize: number;
  group?: OnecReceiptGroup;
  kind?: 'receipts' | 'refunds';
  dateFrom?: string;
  dateTo?: string;
  search?: string;
}

/** Реквизиты платежа приходят, только если платёж виден пользователю по области видимости платежей. */
export type OnecReceiptPaymentDto =
  | { hidden: true }
  | { hidden: false; paymentId: number; amount: string; paymentDate: string; typeName: string | null; orderId: number; orderName: string | null };

export interface OnecReceiptListItemDto {
  lineId: number;
  documentId: number;
  kind: string;
  isRefund: boolean;
  number: string;
  date: string;
  counterpartyName: string | null;
  amount: string;
  currency: string | null;
  posted: boolean;
  deletedInOnec: boolean;
  missingInSource: boolean;
  lineRemoved: boolean;
  refundedAmount: string;
  refundOf: { documentId: number; number: string | null } | null;
  onecOrder: { refKey: string; documentId: number | null; number: string | null; date: string | null } | null;
  erpOrder: {
    orderId: number; orderName: string | null; clientName: string | null; finalAmount: string | null; paidAmount: string | null;
    paymentsCount: number; deleted: boolean; linkOrigin: 'manual' | 'rule' | null;
  } | null;
  state: OnecReceiptState;
  reason: string | null;
  match: { matchId: number; kind: 'matched' | 'dismissed'; origin: string; note: string | null; createdAt: string } | null;
  payment: OnecReceiptPaymentDto | null;
  stateToken: string;
}

export interface OnecReceiptsCapabilities {
  commands: boolean;
}

export interface OnecReceiptListResponse {
  data: OnecReceiptListItemDto[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  counters: Record<OnecReceiptGroup, number>;
  capabilities: OnecReceiptsCapabilities;
}

export interface OnecReceiptCardResponse {
  line: OnecReceiptListItemDto;
  candidates: Array<{
    paymentId: number; amount: string; paymentDate: string; typeName: string | null; notes: string | null;
    sameAmount: boolean; daysApart: number; matchedTo: { lineId: number; number: string | null } | null; paymentToken: string;
  }>;
  refunds: Array<{ lineId: number; documentId: number; kind: string; number: string; date: string; amount: string; currency: string | null; live: boolean }>;
  onecPaid: string | null;
  history: Array<{
    matchId: number; kind: 'matched' | 'dismissed'; origin: string; note: string | null; createdAt: string; createdBy: string | null;
    removedAt: string | null; removedBy: string | null; removedReason: string | null;
    payment: { hidden: true } | { hidden: false; paymentId: number; amount: string; paymentDate: string } | null;
  }>;
  capabilities: OnecReceiptsCapabilities;
}
