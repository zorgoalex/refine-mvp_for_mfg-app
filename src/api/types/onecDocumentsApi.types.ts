import type { DateOnlyString, IsoDateTimeString, OrderResourceCapabilitiesDto, OrderResourceDemandLineDto, OrderResourceKind } from './orderApi.types';

export type OnecDocKind = 'purchase_receipt' | 'cash_outflow' | 'bank_outflow';
export type OnecDocumentsTab = 'receipts' | 'payments';
export type OnecAllocationRole = 'receipt' | 'payment';
export type OnecUnitCode = 'sheet' | 'm2' | 'lm' | 'pcs' | 'set';
export type OnecAllocationState = 'none' | 'partial' | 'full';

export interface OnecDocumentListParams {
  tab: OnecDocumentsTab;
  page?: number;
  pageSize?: number;
  search?: string;
  dateFrom?: DateOnlyString;
  dateTo?: DateOnlyString;
  /** Только документы без активных распределений. */
  unlinkedOnly?: boolean;
  /** Только проведённые и не удалённые в 1С. */
  postedOnly?: boolean;
}

export interface OnecDocumentOrderRefDto {
  orderId: number;
  orderName: string;
}

export interface OnecDocumentListItemDto {
  documentId: number;
  kind: OnecDocKind;
  number: string;
  date: DateOnlyString;
  counterpartyName: string | null;
  supplierName: string | null;
  /** null без права finance.view. */
  amount: number | null;
  currency: string;
  posted: boolean;
  deletedInOnec: boolean;
  linesCount: number;
  allocationState: OnecAllocationState;
  /** Заказы в scope пользователя; остальные — только счётчиком. */
  orders: OnecDocumentOrderRefDto[];
  hiddenOrdersCount: number;
  resourceKinds: OrderResourceKind[];
}

export interface OnecDocumentListResponse {
  data: OnecDocumentListItemDto[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  capabilities: OrderResourceCapabilitiesDto;
  amountsVisible: boolean;
}

export interface OnecAllocationDto {
  allocationId: number;
  orderId: number;
  orderName: string;
  resourceKey: string;
  role: OnecAllocationRole;
  quantity: number | null;
  /** null без права finance.view. */
  amount: number | null;
  origin: 'auto' | 'manual';
  /** Версия закупа материала заказа — expectedVersion для снятия распределения. */
  procurementVersion: number;
  createdAt: IsoDateTimeString;
  createdByName: string | null;
}

export interface OnecDocumentLineMaterialRefDto {
  resourceKey: string;
  kind: OrderResourceKind;
  refId: number;
  name: string;
}

export interface OnecDocumentLineDto {
  lineId: number;
  lineNo: number;
  nomenclatureName: string | null;
  quantity: number;
  unitName: string | null;
  unitCode: OnecUnitCode | null;
  price: number | null;
  amount: number | null;
  isDocumentTotal: boolean;
  material: OnecDocumentLineMaterialRefDto | null;
  /** Сумма активных распределений (количество для прихода, сумма для оплаты; для оплаты без finance.view — null). */
  allocated: number | null;
  remaining: number | null;
  allocations: OnecAllocationDto[];
  hiddenAllocationsCount: number;
}

export interface OnecDocumentCardDto extends Omit<OnecDocumentListItemDto, 'orders' | 'hiddenOrdersCount' | 'linesCount'> {
  sourceCode: string;
  comment: string | null;
  loadedAt: IsoDateTimeString;
  lines: OnecDocumentLineDto[];
}

export interface OnecDocumentCardResponse {
  data: OnecDocumentCardDto;
  capabilities: OrderResourceCapabilitiesDto;
  amountsVisible: boolean;
}

export interface AddOnecAllocationRequest {
  orderId: number;
  resourceKey: string;
  quantity?: number;
  amount?: number;
  expectedVersion: number;
  expectedDemandFingerprint: string;
}

export interface RemoveOnecAllocationRequest {
  expectedVersion: number;
}

export interface OnecAllocationResultDto {
  changed: boolean;
  allocationId: number;
  orderId: number;
  resourceKey: string;
  line: OrderResourceDemandLineDto;
}
