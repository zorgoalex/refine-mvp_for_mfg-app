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

export interface SupplierRequestLineOrderDto {
  lineOrderId: number;
  orderId: number;
  orderName: string;
  fullNumber: string;
  clientName: string | null;
  procurementId: number;
  quantity: number;
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
  lines: Array<{ name: string; quantity: number; unit: OnecUnitCode }>;
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
