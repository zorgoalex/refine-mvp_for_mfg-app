import type { OnecDocumentState } from '../domain/onec-document-state';
import type { CurrentUser } from '../../../permissions/current-user';
import type { OnecUnitCode } from './onec-documents.types';
import type { OrderResourceKind, OrderResourceUnit } from './order-resource-demand.types';

/** Заявки поставщикам (план 2026-09-28 §5.5, фаза 3а). */
export type SupplierRequestStatus = 'draft' | 'sent' | 'closed' | 'cancelled';

/** Не больше стольких позиций «заказ × материал» в одной команде «Сформировать заявки». */
export const SUPPLIER_REQUEST_DRAFT_ITEMS_LIMIT = 200;
/** Не больше стольких строк (материалов) в заявке и заказов в строке — лимиты одной правки. */
export const SUPPLIER_REQUEST_LINES_LIMIT = 100;
export const SUPPLIER_REQUEST_LINE_ORDERS_LIMIT = 200;
export const SUPPLIER_REQUESTS_LIST_LIMIT = 200;
/** Ключ поставщика «не указан» (как в рабочем списке). */
export const SUPPLIER_KEY_NONE = 'none';

export interface CreateSupplierRequestDraftsCommand {
  currentUser: CurrentUser;
  /** Ключ идемпотентности команды (Idempotency-Key, UUID). */
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

/** Приход 1С, привязанный к заказу строки заявки (ф.3б). */
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
  /** Состояние документа 1С; недействующие (не active/conflict) в «пришло» не входят. */
  documentState: OnecDocumentState;
}

/** Приход того же заказа и материала, не привязанный к заявке целиком — кандидат для «Привязать» (§5.5). */
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

/** Оплата 1С, привязанная к заказу строки заявки (ф.3б-2); видна только с finance.view. */
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
  /** Состояние документа 1С; недействующие (не active/conflict) в «оплачено» не входят. */
  documentState: OnecDocumentState;
}

/** Оплата того же заказа и материала с непривязанной суммой — кандидат для «Привязать оплату». */
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

export type SupplierRequestFulfillment = 'waiting' | 'partial' | 'received';

export interface SupplierRequestLineOrderDto {
  lineOrderId: number;
  orderId: number;
  orderName: string;
  fullNumber: string;
  clientName: string | null;
  procurementId: number;
  quantity: number;
  /** Пришло по привязанным приходам (единица строки заявки). */
  fulfilled: number;
  /** Все неснятые приходные связи (лимит «Привязать», включая недействующие документы 1С). */
  linked: number;
  fulfillment: SupplierRequestFulfillment;
  receipts: SupplierRequestReceiptLinkDto[];
  possibleMatches: SupplierRequestPossibleMatchDto[];
  /** Оплаты и «оплачено» по валютам (суммы разных валют не складываются, R3-3) — пусто без finance.view. */
  payments: SupplierRequestPaymentLinkDto[];
  paid: Record<string, number>;
  possiblePayments: SupplierRequestPossiblePaymentDto[];
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
  /** Заказы строки в scope пользователя. */
  orders: SupplierRequestLineOrderDto[];
  /** Заказы строки вне scope — только числом (как в карточке документа 1С). */
  hiddenOrdersCount: number;
  /** Количество, заказанное для заказов вне scope (входит в quantity − stockQuantity). */
  hiddenOrdersQuantity: number;
  /** Заказы строки в корзине: не показываются, при сохранении черновика убираются из него. */
  deletedOrdersCount: number;
  deletedOrdersQuantity: number;
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
  /** Материалы строк — для списка («МДФ 16мм — 7 листов»); fulfilled — пришло по заказам строки. */
  lines: Array<{ name: string; quantity: number; unit: OnecUnitCode; fulfilled: number }>;
  /** Сверка «приход» по заказам заявки: нет / частично / всё заказанное для заказов пришло (ф.3б). */
  receiptState: 'none' | 'partial' | 'done';
  /** Сверка «оплата» (ф.3б-2): 'hidden' — нет finance.view; 'paid' — есть привязанные оплаты (полноты нет: в заявке нет цен). */
  paymentState: 'hidden' | 'none' | 'paid';
  /** Оплачено по валютам — только с finance.view. */
  paid: Record<string, number>;
  ordersCount: number;
  hiddenOrdersCount: number;
  /** Заказы в корзине (не блокируют команды над заявкой). */
  deletedOrdersCount: number;
  version: number;
  createdAt: string;
  createdByName: string | null;
  sentAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
}

export interface SupplierRequestCardDto extends SupplierRequestSummaryDto {
  lineItems: SupplierRequestLineDto[];
  /** Действия, доступные пользователю в текущем статусе. */
  actions: { edit: boolean; send: boolean; close: boolean; cancel: boolean };
}

export interface SupplierRequestsListQuery {
  status?: SupplierRequestStatus[];
  search?: string;
}

export interface SupplierRequestsListResponseDto {
  data: SupplierRequestSummaryDto[];
  counts: Record<SupplierRequestStatus, number>;
  truncated: boolean;
}

export interface UpdateSupplierRequestCommand {
  currentUser: CurrentUser;
  requestId: string;
  supplierRequestId: number;
  expectedVersion: number;
  comment?: string | null;
  expectedDate?: string | null;
  /** null — «Поставщик не указан»; число — поставщик из справочника. */
  supplierId?: number | null;
  /** Полная замена содержимого строк: строки и заказы, которых нет в списке, удаляются. */
  lines?: Array<{ lineId: number; quantity: number; orders: Array<{ lineOrderId: number; quantity: number }> }>;
}

export type SupplierRequestTransition = 'send' | 'close' | 'cancel';

export interface TransitionSupplierRequestCommand {
  currentUser: CurrentUser;
  requestId: string;
  supplierRequestId: number;
  expectedVersion: number;
  transition: SupplierRequestTransition;
}

export interface SupplierRequestCommandResultDto {
  changed: boolean;
  request: SupplierRequestCardDto;
}
