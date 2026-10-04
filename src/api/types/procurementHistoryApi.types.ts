/** «История» материала заказа в экране снабжения (план §5.?, этап 4a). */

export type ProcurementHistoryEventKind =
  | 'marked'
  | 'unmarked'
  | 'allocation_added'
  | 'allocation_removed'
  | 'allocation_linked'
  | 'allocation_unlinked'
  | 'request_created'
  | 'request_updated'
  | 'request_sent'
  | 'request_closed'
  | 'request_cancelled';

export type ProcurementHistoryDocKind = 'purchase_receipt' | 'bank_outflow' | 'cash_outflow';

export interface ProcurementHistoryDocumentRef {
  documentId: number;
  docKind: ProcurementHistoryDocKind | null;
  number: string | null;
  /** YYYY-MM-DD. */
  date: string | null;
}

export interface ProcurementHistoryRequestRef {
  supplierRequestId: number;
  number: string | null;
}

export interface ProcurementHistoryEvent {
  id: string;
  /** ISO. */
  at: string;
  kind: ProcurementHistoryEventKind;
  actorName: string | null;
  /** 'manual' | 'onec' | ... — только для `marked`. */
  origin: string | null;
  role: 'receipt' | 'payment' | null;
  quantity: number | null;
  /** 'sheet' | 'm2' | 'lm' | 'pcs' | ... — единица 1С или потребности, зависит от события. */
  unit: string | null;
  amount: number | null;
  /** Только для пользователей с finance.view. */
  currency: string | null;
  /** Приход-распределение, выставившее «Закуплено». */
  markedPurchased: boolean;
  document: ProcurementHistoryDocumentRef | null;
  request: ProcurementHistoryRequestRef | null;
  /** Связи с заявками, созданные/снятые вместе с распределением (групповой подбор, снятие распределения). */
  requestLinks?: ProcurementHistoryRequestLink[];
}

export interface ProcurementHistoryRequestLink {
  action: 'linked' | 'unlinked';
  supplierRequestId: number;
  number: string | null;
  quantity: number | null;
  unit: string | null;
}

export interface ProcurementHistoryCurrent {
  name: string;
  quantity: number | null;
  unit: 'm2' | 'lm';
  purchased: boolean;
  origin: 'manual' | 'onec' | null;
  markedAt: string | null;
  quantityAtMark: number | null;
  unitAtMark: 'm2' | 'lm' | null;
  changedSinceMark: boolean;
  orphan: boolean;
}

export interface ProcurementHistoryParams {
  orderId: number;
  resourceKey: string;
  /** 1..200, по умолчанию 50. */
  limit?: number;
  /** Курсор для подгрузки более старых событий. */
  before?: string;
}

export interface ProcurementHistoryResponse {
  orderId: number;
  resourceKey: string;
  current: ProcurementHistoryCurrent | null;
  events: ProcurementHistoryEvent[];
  nextCursor: string | null;
}
