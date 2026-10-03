export type StockDocType = 'receipt' | 'writeoff' | 'inventory';
/** Тип в журнале: + 'onec' — документ-дельта расхода из 1С (создаёт backend, вручную не создаётся). */
export type StockDocKind = StockDocType | 'onec';
export type StockDocStatus = 'draft' | 'posted' | 'cancelled';
export type LineMatchStatus = 'alias' | 'exact' | 'suggested' | 'confirmed' | 'manual' | 'unmatched' | 'skipped';
export type LineQuantityStatus = 'ok' | 'needs_review' | 'missing' | 'confirmed';

export interface WarehouseDto {
  warehouseId: number; name: string; isActive: boolean;
  workshopId: number | null; workshopName: string | null;
  responsibleEmployeeId: number | null; responsibleEmployeeName: string | null;
  refKey1c: string | null; filmsWithStock: number; totalQuantity: number; draftDocuments: number;
  /** Токен версии для PATCH. */
  version: string;
  /** linked — найден в данных 1С, missing — ключа нет в 1С, unlinked — не привязан, unknown — данные 1С недоступны. */
  onecStatus: 'linked' | 'missing' | 'unlinked' | 'unknown';
  onecName: string | null;
  onecCode: string | null;
  /** Момент начала расхода из документов 1С (ISO); null — расход 1С по складу не ведётся. */
  onecConsumptionSince?: string | null;
}
export interface WarehouseCreateInput { name: string; refKey1c: string; workshopId?: number | null; responsibleEmployeeId?: number | null }
export interface WarehousePatch {
  version: string; name?: string; refKey1c?: string; workshopId?: number | null; responsibleEmployeeId?: number | null; isActive?: boolean;
  onecConsumptionSince?: string | null;
}
export interface OnecWarehouseOptionDto {
  refKey: string; code: string | null; name: string; linkedWarehouseId: number | null; linkedWarehouseName: string | null;
}
export interface WarehouseSyncResultDto {
  created: WarehouseDto[]; linked: WarehouseDto[]; skipped: Array<{ refKey: string; name: string; reason: 'name_taken' }>;
}
export interface StockBalanceDto {
  warehouseId: number; filmId: number; filmName: string; vendorId: number | null; vendorName: string | null;
  quantity: number; lastMovementAt: string | null;
}
export interface StockDocumentSummaryDto {
  documentId: number; docType: StockDocKind; status: StockDocStatus; warehouseId: number; docDate: string;
  source: 'manual' | 'import' | 'onec'; orderId: number | null; orderName: string | null; fileName: string | null;
  comment: string | null; linesCount: number; totalQuantity: number; version: number; createdAt: string;
  createdByName: string | null; postedAt: string | null; postedByName: string | null;
  /** Момент подсчёта инвентаризации (отсечка расхода 1С). */
  countedAt?: string | null;
  /** Документ-дельта расхода 1С: какой документ 1С и какая по счёту дельта. */
  onec?: { documentId: number; refKey: string | null; revision: number | null; projectionSeq: number | null } | null;
}
export interface StockDocumentLineDto {
  lineId: number; lineNo: number; rawName: string | null; rawSupplier: string | null; rawQuantity: string | null;
  filmId: number | null; filmName: string | null; quantity: number | null; matchStatus: LineMatchStatus;
  quantityStatus: LineQuantityStatus; suggestions: Array<{ filmId: number; filmName: string; score: number }>;
  issue: string | null; balanceBefore: number | null; balanceAfter: number | null;
}
export interface StockDocumentDto extends StockDocumentSummaryDto {
  previousPostedDocumentId: number | null;
  lines: StockDocumentLineDto[];
  movements: Array<{ filmId: number; filmName: string; movementType: string; delta: number; balanceBefore: number; balanceAfter: number }>;
  unresolved: Array<{ lineId: number; lineNo: number; reason: 'match' | 'quantity' }>;
  negativeAfter: Array<{ filmId: number; filmName: string; after: number }>;
}
export interface OrderFilmStockDto {
  items: Array<{ filmId: number; canonicalFilmId: number; canonicalName: string; vendorName: string | null; stockLm: number | null; demandLm: number | null; status: 'enough' | 'short' | 'none' | 'unknown_demand' }>;
}
/** Остатки листовых материалов заказа по данным 1С (своего учёта листов в ERP нет). */
export interface OrderSheetStockDto {
  items: Array<{
    sheetMaterialTypeId: number; name: string; refKey1c: string | null; onecName: string | null; unitName: string | null;
    quantity: number | null; quantityM2: number | null; demandM2: number | null;
    warehouses: Array<{ warehouseId: number; name: string; quantity: number }>;
    status: 'enough' | 'short' | 'none' | 'unknown_demand' | 'unlinked' | 'unknown_unit' | 'unavailable' | 'incomplete';
  }>;
  /** Склады, остатки 1С которых не прочитаны: количество частичное, покрытие не определено. */
  incompleteWarehouses?: Array<{ warehouseId: number; name: string; reason: string }>;
  snapshotVersion: string | null;
}
export interface InventoryPage<T> { total: number; items: T[]; totalQuantity?: number }
export interface InventoryDocumentQuery { type?: StockDocKind; status?: StockDocStatus; from?: string; to?: string; filmId?: number; orderId?: number; offset?: number; limit?: number }
export interface InventoryBalanceQuery { warehouseId?: number; vendorId?: number; search?: string; nonZero?: boolean; negative?: boolean; offset?: number; limit?: number }
export interface ManualStockDocumentInput {
  docType: StockDocType; warehouseId: number; docDate: string; orderId?: number; comment?: string;
  lines: Array<{ filmId: number; quantity: number }>; post?: boolean; allowNegative?: boolean;
  /** Только инвентаризация: момент подсчёта (ISO со смещением). */
  countedAt?: string;
}
export interface StockImportInput {
  docType: 'receipt' | 'inventory'; warehouseId: number; docDate: string; fileName: string;
  fileSha256: string; sheetName: string;
  rows: Array<{ rowNo: number; name: string; supplier: string | null; quantity: string | number | null }>;
  /** Только инвентаризация: момент подсчёта (ISO со смещением). */
  countedAt?: string;
}
export interface StockLinePatch { version: number; filmId?: number; quantity?: number; confirmMatch?: boolean; confirmQuantity?: boolean; skip?: boolean }
export interface InventoryApiError { statusCode?: number; code?: string; message?: string; details?: unknown }

/** «Остатки на складах»: вкладка — all | film | film_unlinked | no_type | unlinked | material:<id>. */
export interface WarehouseStockQuery {
  warehouseId: number;
  group?: string;
  search?: string;
  nonZero?: boolean;
  negative?: boolean;
  /** GUID категории 1С или 'none' — строки 1С без категории; не задано — без фильтра. */
  categoryKey?: string;
  offset?: number;
  limit?: number;
}
export type OnecStockUnavailableReason =
  | 'onec_disabled' | 'warehouse_unlinked' | 'warehouse_not_in_onec' | 'ambiguous_source' | 'not_loaded' | 'revoked';
export interface WarehouseStockItemDto {
  source: 'erp' | '1c';
  group: string;
  groupLabel: string;
  filmId: number | null;
  itemRefKey: string | null;
  code: string | null;
  name: string;
  vendorName: string | null;
  categoryKey: string | null;
  categoryName: string | null;
  unitName: string | null;
  quantity: number;
  sheetMaterialTypeId: number | null;
  ambiguousLink: boolean;
}
export interface WarehouseStockOnecDto {
  available: boolean;
  reason: OnecStockUnavailableReason | null;
  onecWarehouseName: string | null;
  snapshotVersion: string | null;
  rejectedReason: string | null;
  completeness: string | null;
  directoriesRevoked: boolean;
}
export interface WarehouseStockDto {
  warehouseId: number;
  warehouseName: string;
  onec: WarehouseStockOnecDto;
  tabs: Array<{ key: string; label: string; count: number }>;
  categories: Array<{ key: string; name: string; count: number }>;
  total: number;
  items: WarehouseStockItemDto[];
}

/** Строка 1С, не учтённая в остатках склада, с причиной (расход 1С). */
export type OnecIssueCode =
  | 'FILM_UNLINKED' | 'UNIT_PACKAGE' | 'UNIT_MISMATCH' | 'WAREHOUSE_UNLINKED' | 'NO_CUTOFF' | 'NO_BASELINE'
  | 'BEFORE_CUTOFF' | 'AMBIGUOUS_SOURCE' | 'LINE_CONFLICT' | 'MISSING_IN_SOURCE' | 'NO_DOC_AT';
export interface OnecIssueDto {
  issueId: number; onecDocumentId: number; onecLineId: number | null; code: OnecIssueCode | string; warehouseId: number | null;
  nomenclatureRefKey: string | null; quantity: number | null; docKind: string | null; docNumber: string | null;
  docDate: string | null; docAt: string | null; filmId: number | null; filmName: string | null; updatedAt: string;
}
export interface OnecIssuesPage { total: number; items: OnecIssueDto[]; counts: Array<{ code: string; count: number }> }
export interface OnecIssuesQuery { warehouseId?: number; code?: string; includeBeforeCutoff?: boolean; offset?: number; limit?: number }
export type OnecConsumptionRunDto =
  | { status: 'skipped'; reason: 'disabled' | 'onec_unavailable' | 'busy' }
  | { status: 'done'; candidates: number; processed: number; documents: number; failed: number };
export interface OnecCompensateDto { documents: number; remaining: number }
