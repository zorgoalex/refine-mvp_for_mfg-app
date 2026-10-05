import type { OrderResourceKind, OrderResourceUnit } from './orderApi.types';
import type { OnecUnitCode } from './onecDocumentsApi.types';

/** Заявки поставщикам (план 2026-09-28 §5.5, фаза 3а) — зеркало backend DTO (supplier-requests.types.ts). */
export type SupplierRequestStatus = 'draft' | 'sent' | 'closed' | 'cancelled';

export const SUPPLIER_REQUEST_DRAFT_ITEMS_LIMIT = 200;
export const SUPPLIER_REQUEST_LINES_LIMIT = 100;
export const SUPPLIER_REQUEST_LINE_ORDERS_LIMIT = 200;

export interface CreateSupplierRequestDraftsBody {
  requestId: string;
  items: Array<{ orderId: number; resourceKey: string }>;
}

export type DraftSkipReason = 'not_in_order' | 'no_deficit' | 'no_data' | 'order_closed' | 'in_draft';

export interface CreateSupplierRequestDraftsResultDto {
  requests: Array<{
    requestId: number;
    requestNumber: string;
    supplierName: string;
    linesCount: number;
    ordersCount: number;
  }>;
  skipped: Array<{ orderId: number; resourceKey: string; reason: DraftSkipReason }>;
}

/** Приход 1С, привязанный к заказу строки заявки (ф.3б). Старый backend поле не присылает. */
export type OnecDocumentState = 'active' | 'conflict' | 'kind_changed' | 'missing' | 'deleted' | 'unposted' | 'line_removed';

export interface SupplierRequestReceiptLinkDto {
  linkId: number;
  allocationId: number;
  documentId: number;
  documentNumber: string;
  documentDate: string;
  lineId: number;
  /** В единице строки заявки. */
  quantity: number;
  /** Версия закупа — для «Отвязать». */
  procurementVersion: number;
  /** Состояние документа 1С (нет у старого backend — действует). */
  documentState?: OnecDocumentState;
}

/** Приход того же заказа и материала, не привязанный к заявке целиком — кандидат для «Привязать» (ф.3б). */
export interface SupplierRequestPossibleMatchDto {
  allocationId: number;
  documentId: number;
  documentNumber: string;
  documentDate: string;
  lineId: number;
  counterpartyName: string | null;
  /** Не привязано к заявкам, в единице строки заявки. */
  unlinkedQuantity: number;
  /** Предложение для привязки: min(не привязано, осталось получить по заявке). */
  suggestedQuantity: number;
  supplierCheck: 'match' | 'unknown';
  procurementVersion: number;
}

export type SupplierRequestFulfillment = 'waiting' | 'partial' | 'received';

/** Оплата 1С, привязанная к заказу строки заявки (ф.3б-2); видна только с finance.view. Старый backend не присылает. */
export interface SupplierRequestPaymentLinkDto {
  linkId: number;
  allocationId: number;
  documentId: number;
  documentNumber: string;
  documentDate: string;
  lineId: number;
  amount: number;
  currency: string;
  procurementVersion: number;
  /** Состояние документа 1С (нет у старого backend — действует). */
  documentState?: OnecDocumentState;
}

/** Оплата того же заказа и материала с непривязанной суммой — кандидат для «Привязать оплату» (ф.3б-2). */
export interface SupplierRequestPossiblePaymentDto {
  allocationId: number;
  documentId: number;
  documentNumber: string;
  documentDate: string;
  lineId: number;
  counterpartyName: string | null;
  unlinkedAmount: number;
  currency: string;
  supplierCheck: 'match' | 'unknown';
  procurementVersion: number;
}

export interface SupplierRequestLineOrderDto {
  lineOrderId: number;
  orderId: number;
  orderName: string;
  fullNumber: string;
  clientName: string | null;
  procurementId: number;
  quantity: number;
  /** Пришло по привязанным приходам (единица строки заявки). Старый backend не присылает — трактовать как 0. */
  fulfilled?: number;
  /** Все неснятые приходные связи — лимит «Привязать» (нет у старого backend). */
  linked?: number;
  fulfillment?: SupplierRequestFulfillment;
  receipts?: SupplierRequestReceiptLinkDto[];
  /** Только для отправленных заявок. */
  possibleMatches?: SupplierRequestPossibleMatchDto[];
  /** Оплаты и «оплачено» по валютам (ф.3б-2) — пусто без finance.view, нет поля на старом backend. */
  payments?: SupplierRequestPaymentLinkDto[];
  paid?: Record<string, number>;
  possiblePayments?: SupplierRequestPossiblePaymentDto[];
}

export interface SupplierRequestLineDto {
  lineId: number;
  lineNo: number;
  resourceKey: string;
  kind: OrderResourceKind;
  refId: number;
  name: string;
  unit: OnecUnitCode;
  /** Единица потребности материала и площадь листа — для пересчёта «≈ м²» в интерфейсе. */
  demandUnit: OrderResourceUnit;
  sheetAreaM2: number | null;
  quantity: number;
  stockQuantity: number;
  orders: SupplierRequestLineOrderDto[];
  hiddenOrdersCount: number;
  hiddenOrdersQuantity: number;
  /** Заказы в корзине: не показываются, при сохранении черновика убираются. Старый backend поле не присылает. */
  deletedOrdersCount?: number;
  deletedOrdersQuantity?: number;
}

export interface SupplierRequestSummaryDto {
  requestId: number;
  requestNumber: string;
  status: SupplierRequestStatus;
  supplierKey: string;
  supplierId: number | null;
  supplierName: string;
  expectedDate: string | null;
  comment: string | null;
  linesCount: number;
  /** fulfilled — пришло по заказам строки (единица строки заявки). Старый backend не присылает — трактовать как 0. */
  lines: Array<{ name: string; quantity: number; unit: OnecUnitCode; fulfilled?: number }>;
  /** Сверка «приход» по заказам заявки. Старый backend не присылает — трактовать как 'none'. */
  receiptState?: 'none' | 'partial' | 'done';
  /** Сверка «оплата» (ф.3б-2): 'hidden' — нет finance.view. Старый backend не присылает — трактовать как 'hidden'. */
  paymentState?: 'hidden' | 'none' | 'paid';
  /** Оплачено по валютам — только с finance.view. Старый backend не присылает. */
  paid?: Record<string, number>;
  ordersCount: number;
  hiddenOrdersCount: number;
  deletedOrdersCount?: number;
  version: number;
  createdAt: string;
  createdByName: string | null;
  sentAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
}

export interface SupplierRequestCardDto extends SupplierRequestSummaryDto {
  lineItems: SupplierRequestLineDto[];
  actions: { edit: boolean; send: boolean; close: boolean; cancel: boolean };
  /** Только в ответе GET карточки; нет — старый backend (шаблонов нет). */
  capabilities?: { supplierTextTemplates: boolean };
}

export interface SupplierRequestsListParams {
  /** Через запятую. */
  status?: string;
  search?: string;
}

export interface SupplierRequestsListResponseDto {
  data: SupplierRequestSummaryDto[];
  counts: Record<SupplierRequestStatus, number>;
  truncated: boolean;
}

export interface UpdateSupplierRequestLineOrderInput {
  lineOrderId: number;
  quantity: number;
}

export interface UpdateSupplierRequestLineInput {
  lineId: number;
  quantity: number;
  orders: UpdateSupplierRequestLineOrderInput[];
}

export interface UpdateSupplierRequestBody {
  expectedVersion: number;
  comment?: string | null;
  expectedDate?: string | null;
  /** null — «Поставщик не указан»; число — поставщик из справочника. */
  supplierId?: number | null;
  /** Полная замена содержимого строк: строки и заказы, которых нет в списке, удаляются. */
  lines?: UpdateSupplierRequestLineInput[];
}

export interface TransitionSupplierRequestBody {
  expectedVersion: number;
}

export interface SupplierRequestCommandResultDto {
  changed: boolean;
  request: SupplierRequestCardDto;
}
