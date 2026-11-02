import type { ReceiptState, StateGroup } from '../domain/onec-receipts';

export interface OnecReceiptListQuery {
  page: number;
  pageSize: number;
  /** Группа состояний (счётчик-фильтр вкладки); без неё — все строки. */
  group?: StateGroup;
  kind?: 'receipts' | 'refunds';
  dateFrom?: string;
  dateTo?: string;
  search?: string;
}

/** Реквизиты платежа ERP отдаются, только если платёж виден пользователю по области `payments.view`. */
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
  /**
   * Сумма действующих возвратов по документу поступления в валюте поступления (у возврата — 0); только возвраты,
   * относящиеся к заказу строки (у поступления на несколько заказов — только при области видимости «все»).
   */
  refundedAmount: string;
  /** У возврата — поступление, которое возвращают. */
  refundOf: { documentId: number; number: string | null } | null;
  /** `manualLink` — у заказа 1С ручная связь (в т.ч. «не относится к приложению»: тогда `erpOrder` пуст). */
  onecOrder: { refKey: string; documentId: number | null; number: string | null; date: string | null; manualLink: boolean } | null;
  erpOrder: {
    orderId: number; orderName: string | null; clientName: string | null; finalAmount: string | null; paidAmount: string | null;
    paymentsCount: number; deleted: boolean; linkOrigin: 'manual' | 'rule' | null;
  } | null;
  state: ReceiptState;
  /** Код причины, по которой строка не сверяется (подпись — на экране); `null` — ограничений нет. */
  reason: string | null;
  /** У `changed` — что изменилось относительно сверки (коды); реквизиты чужого платежа — обобщённо `payment_changed`. */
  changes: string[] | null;
  match: { matchId: number; kind: 'matched' | 'dismissed'; origin: string; note: string | null; createdAt: string } | null;
  payment: OnecReceiptPaymentDto | null;
  /** Непрозрачный токен состояния строки: команды (следующие срезы) сверяют его после блокировок. */
  stateToken: string;
}

export interface OnecReceiptsCapabilities {
  /** Ручные команды вкладки доступны (флаг `…_COMMANDS` и права `payments.onec.manage` + `payments.update`). */
  commands: boolean;
}

export interface OnecReceiptListResponseDto {
  data: OnecReceiptListItemDto[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  counters: Record<StateGroup, number>;
  capabilities: OnecReceiptsCapabilities;
}

export interface OnecReceiptCardDto {
  line: OnecReceiptListItemDto;
  /** Платежи заказа ERP строки. */
  candidates: Array<{
    paymentId: number; amount: string; paymentDate: string; typeName: string | null; notes: string | null;
    sameAmount: boolean; daysApart: number; matchedTo: { lineId: number; number: string | null } | null; paymentToken: string;
  }>;
  /** Возвраты по документу поступления. */
  refunds: Array<{ lineId: number; documentId: number; kind: string; number: string; date: string; amount: string; currency: string | null; live: boolean }>;
  /** «Оплачено по 1С» заказа ERP: поступления минус возвраты; `null` — заказ ERP не определён. */
  onecPaid: string | null;
  history: Array<{
    matchId: number; kind: 'matched' | 'dismissed'; origin: string; note: string | null; createdAt: string; createdBy: string | null;
    removedAt: string | null; removedBy: string | null; removedReason: string | null;
    payment: { hidden: true } | { hidden: false; paymentId: number; amount: string; paymentDate: string } | null;
  }>;
  capabilities: OnecReceiptsCapabilities;
}

/** Ответ ручной команды: изменилось ли что-то (повтор той же команды — `false`) и строка в области пользователя. */
export interface OnecReceiptCommandResponseDto {
  changed: boolean;
  matchId: number | null;
  /** `null` — после команды строка вне области видимости пользователя. */
  line: OnecReceiptListItemDto | null;
}
