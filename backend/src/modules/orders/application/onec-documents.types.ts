import type { CurrentUser } from '../../../permissions/current-user';
import type { OrderResourceCapabilitiesDto, OrderResourceDemandLineDto, OrderResourceKind } from './order-resource-demand.types';

export type OnecDocKind = 'purchase_receipt' | 'cash_outflow' | 'bank_outflow';
export type OnecDocumentsTab = 'receipts' | 'payments';
export type OnecAllocationRole = 'receipt' | 'payment';
export type OnecUnitCode = 'sheet' | 'm2' | 'lm' | 'pcs' | 'set';

export interface OnecDocumentListQuery {
  tab: OnecDocumentsTab;
  page: number;
  pageSize: number;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
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
  date: string;
  counterpartyName: string | null;
  supplierName: string | null;
  /** null без права finance.view. */
  amount: number | null;
  currency: string;
  posted: boolean;
  deletedInOnec: boolean;
  linesCount: number;
  allocationState: 'none' | 'partial' | 'full';
  /** Заказы в scope пользователя; остальные — только счётчиком. */
  orders: OnecDocumentOrderRefDto[];
  hiddenOrdersCount: number;
  resourceKinds: OrderResourceKind[];
}

export interface OnecDocumentListResponseDto {
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
  createdAt: string;
  createdByName: string | null;
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
  material: { resourceKey: string; kind: OrderResourceKind; refId: number; name: string } | null;
  /** Сумма активных распределений (количество для прихода, сумма для оплаты; для оплаты без finance.view — null). */
  allocated: number | null;
  remaining: number | null;
  allocations: OnecAllocationDto[];
  hiddenAllocationsCount: number;
}

export interface OnecDocumentCardDto extends Omit<OnecDocumentListItemDto, 'orders' | 'hiddenOrdersCount' | 'linesCount'> {
  sourceCode: string;
  comment: string | null;
  loadedAt: string;
  lines: OnecDocumentLineDto[];
}

export interface OnecDocumentCardResponseDto {
  data: OnecDocumentCardDto;
  capabilities: OrderResourceCapabilitiesDto;
  amountsVisible: boolean;
}

export interface AddOnecAllocationCommand {
  currentUser: CurrentUser;
  documentId: number;
  lineId: number;
  orderId: number;
  resourceKey: string;
  quantity?: number;
  amount?: number;
  expectedVersion: number;
  expectedDemandFingerprint: string;
  requestId: string;
}

export interface RemoveOnecAllocationCommand {
  currentUser: CurrentUser;
  documentId: number;
  lineId: number;
  allocationId: number;
  expectedVersion: number;
  requestId: string;
}

export interface OnecAllocationResultDto {
  changed: boolean;
  allocationId: number;
  orderId: number;
  resourceKey: string;
  line: OrderResourceDemandLineDto;
}

export interface OnecDocumentReadOptions {
  procurementEnabled: boolean;
  canSeeAmounts: boolean;
}
