import type { CurrentUser } from '../../../permissions/current-user';

export interface OrderResourceDemandQuery {
  page: number;
  pageSize: number;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  sheetMaterialTypeId?: number;
  filmId?: number;
  supplierId?: number;
  vendorId?: number;
  /** Только заказы, у которых есть хотя бы один незакупленный материал. */
  unpurchasedOnly?: boolean;
  /** Только заказы, на которые распределён этот документ 1С (активные распределения). */
  onecDocumentId?: number;
}

export interface OrderSheetMaterialDemandDto {
  sheetMaterialTypeId: number;
  name: string;
  totalArea: number;
  detailsCount: number;
  supplierId: number | null;
  supplierName: string | null;
}

export interface OrderFilmDemandDto {
  filmId: number;
  name: string;
  totalArea: number;
  detailsCount: number;
  linearMeters: number;
  sheets: number;
  hasCutData: boolean;
  vendorId: number | null;
  vendorName: string | null;
}

export type OrderResourceKind = 'sheet_material' | 'film';
export type OrderResourceUnit = 'm2' | 'lm';
/** Откуда количество: готовый раскрой, площадь деталей или нет данных. */
export type OrderResourceSource = 'cut' | 'area' | 'none';

export interface OrderResourceProcurementDto {
  purchased: boolean;
  /** 0 — записи закупа ещё нет. */
  version: number;
  origin: 'manual' | 'onec' | null;
  markedAt: string | null;
  markedBy: { userId: number; name: string } | null;
  quantityAtMark: number | null;
  unitAtMark: OrderResourceUnit | null;
  /** Потребность изменилась после отметки «Закуплено». */
  changedSinceMark: boolean;
}

export interface OrderResourceDemandLineDto {
  resourceKey: string;
  kind: OrderResourceKind;
  refId: number;
  name: string;
  supplierName: string | null;
  /** null — количество не посчитано (нет готового раскроя у плёнки). */
  quantity: number | null;
  unit: OrderResourceUnit;
  areaM2: number;
  detailsCount: number;
  source: OrderResourceSource;
  demandFingerprint: string;
  /** Отметка закупа есть, а материал заказу больше не нужен. */
  orphan: boolean;
  procurement: OrderResourceProcurementDto;
  /** Документы 1С, распределённые на этот закуп (активные распределения). */
  onec: { receipts: OrderResourceOnecDocRefDto[]; payments: OrderResourceOnecDocRefDto[] };
  /** Снять «Закуплено» нельзя: есть приход из проведённого документа 1С. */
  lockedByOnec: boolean;
}

export interface OrderResourceOnecDocRefDto {
  documentId: number;
  allocationId: number;
  kind: 'purchase_receipt' | 'cash_outflow' | 'bank_outflow';
  number: string;
  date: string;
  quantity: number | null;
  /** null без права finance.view. */
  amount: number | null;
  linkOrigin: 'auto' | 'manual';
  posted: boolean;
  deletedInOnec: boolean;
}

export interface OrderProcurementSummaryDto {
  total: number;
  purchased: number;
  orphanPurchased: number;
}

export interface OrderResourceCapabilitiesDto {
  procurement: boolean;
  byMaterial: boolean;
  cardDetails: boolean;
  onecDocuments: boolean;
  /** Вкладка «Экран снабжения»: BACKEND_PROCUREMENT_WORKSPACE_ENABLED и флаг закупа. */
  supplyWorkspace: boolean;
}

export interface OrderResourceDemandDto {
  orderId: number;
  orderName: string;
  fullNumber: string;
  orderDate: string | null;
  projectCode: string;
  clientName: string | null;
  updatedAt: string;
  sheetMaterials: OrderSheetMaterialDemandDto[];
  films: OrderFilmDemandDto[];
  lines: OrderResourceDemandLineDto[];
  procurementSummary: OrderProcurementSummaryDto;
}

export interface OrderResourceDemandResponseDto {
  data: OrderResourceDemandDto[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  refreshedAt: string;
  capabilities: OrderResourceCapabilitiesDto;
}

export interface OrderResourceDetailRefDto {
  source: 'detail' | 'hdf';
  id: number;
  detailNumber: number | null;
  name: string | null;
  heightMm: number | null;
  widthMm: number | null;
  quantity: number | null;
}

export interface OrderResourceCardLineDto extends OrderResourceDemandLineDto {
  details: OrderResourceDetailRefDto[];
}

export interface OrderResourceCardDto extends Omit<OrderResourceDemandDto, 'lines'> {
  lines: OrderResourceCardLineDto[];
}

export interface OrderResourceCardResponseDto {
  data: OrderResourceCardDto;
  refreshedAt: string;
  capabilities: OrderResourceCapabilitiesDto;
}

export interface OrderResourceMaterialParticipantDto {
  orderId: number;
  orderName: string;
  purchased: boolean;
  version: number;
  demandFingerprint: string;
}

export interface OrderResourceMaterialAggregateDto {
  resourceKey: string;
  kind: OrderResourceKind;
  refId: number;
  name: string;
  supplierName: string | null;
  unit: OrderResourceUnit;
  totalQuantity: number;
  ordersCount: number;
  detailsCount: number;
  noDataOrders: number;
  purchasedOrders: number;
  participants: OrderResourceMaterialParticipantDto[];
}

export interface OrderResourceByMaterialResponseDto {
  data: OrderResourceMaterialAggregateDto[];
  ordersCount: number;
  refreshedAt: string;
  capabilities: OrderResourceCapabilitiesDto;
}

/** Документ 1С, распределённый на заказы текущей выборки списка потребностей. */
export interface OrderResourceOnecDocumentOptionDto {
  documentId: number;
  kind: 'purchase_receipt' | 'cash_outflow' | 'bank_outflow';
  number: string;
  date: string;
  ordersCount: number;
}

export interface OrderResourceOnecDocumentOptionsResponseDto {
  data: OrderResourceOnecDocumentOptionDto[];
  /** Документов больше лимита — показаны самые свежие. */
  truncated: boolean;
}

/** Лимит вариантов фильтра «Документ 1С». */
export const RESOURCE_ONEC_DOCUMENT_OPTIONS_LIMIT = 200;

export interface ListOrderResourceDemandsCommand {
  currentUser: CurrentUser;
  query: OrderResourceDemandQuery;
}

export interface GetOrderResourceCardCommand {
  currentUser: CurrentUser;
  orderId: number;
}

export interface OrderResourceReadOptions {
  /** Флаг BACKEND_RESOURCE_PROCUREMENT_ENABLED: без него таблица закупа не читается. */
  procurementEnabled: boolean;
  /** Право finance.view: суммы документов 1С. Без него — null. */
  canSeeAmounts?: boolean;
  /** Флаг BACKEND_PROCUREMENT_WORKSPACE_ENABLED (только для capabilities). */
  supplyWorkspaceEnabled?: boolean;
}

export interface OrderResourceDemandRepositoryPort {
  list(command: ListOrderResourceDemandsCommand, options: OrderResourceReadOptions): Promise<OrderResourceDemandResponseDto>;
  getCard(command: GetOrderResourceCardCommand, options: OrderResourceReadOptions): Promise<OrderResourceCardResponseDto>;
  listByMaterial(
    command: ListOrderResourceDemandsCommand,
    options: OrderResourceReadOptions,
  ): Promise<OrderResourceByMaterialResponseDto>;
  listOnecDocumentOptions(
    command: ListOrderResourceDemandsCommand,
    options: OrderResourceReadOptions,
  ): Promise<OrderResourceOnecDocumentOptionsResponseDto>;
}

/** Лимит заказов для агрегата «по материалам» (R1-8). */
export const RESOURCE_BY_MATERIAL_ORDER_LIMIT = 500;
/** Лимит заказов в групповой отметке закупа. */
export const RESOURCE_PROCUREMENT_BULK_LIMIT = 100;

export interface SetOrderResourceProcurementInput {
  purchased: boolean;
  expectedVersion: number;
  expectedDemandFingerprint: string;
}

export interface SetOrderResourceProcurementCommand extends SetOrderResourceProcurementInput {
  currentUser: CurrentUser;
  orderId: number;
  resourceKey: string;
  requestId: string;
}

export interface BulkOrderResourceProcurementCommand {
  currentUser: CurrentUser;
  resourceKey: string;
  purchased: boolean;
  items: Array<{ orderId: number; expectedVersion: number; expectedDemandFingerprint: string }>;
  requestId: string;
}

export interface OrderResourceProcurementResultDto {
  orderId: number;
  resourceKey: string;
  changed: boolean;
  line: OrderResourceDemandLineDto;
}

export interface BulkOrderResourceProcurementResultDto {
  results: OrderResourceProcurementResultDto[];
}
