import type { CurrentUser } from '../../../permissions/current-user';
import type { LineMatchStatus, LineQuantityStatus, StockDocType } from '../domain/stock-posting';

export type StockDocStatus = 'draft' | 'posted' | 'cancelled';

export interface WarehouseDto {
  warehouseId: number;
  name: string;
  isActive: boolean;
  workshopId: number | null;
  workshopName: string | null;
  responsibleEmployeeId: number | null;
  responsibleEmployeeName: string | null;
  refKey1c: string | null;
  /** Момент начала расхода из документов 1С (ISO) или null — склад не участвует. */
  onecConsumptionSince: string | null;
  /** Плёнок с ненулевым остатком. */
  filmsWithStock: number;
  totalQuantity: number;
  draftDocuments: number;
  /** Токен версии (updated_at) для защиты от устаревшей записи. */
  version: string;
  /** Склад 1С по ключу: linked — найден в зеркале, missing — нет в зеркале, unlinked — ключа нет, unknown — зеркало недоступно. */
  onecStatus: 'linked' | 'missing' | 'unlinked' | 'unknown';
  onecName: string | null;
  onecCode: string | null;
}

export interface CreateWarehouseInput {
  name: string;
  refKey1c: string;
  workshopId: number | null;
  responsibleEmployeeId: number | null;
}

export interface UpdateWarehouseInput {
  warehouseId: number;
  version: string;
  name?: string;
  refKey1c?: string;
  workshopId?: number | null;
  responsibleEmployeeId?: number | null;
  isActive?: boolean;
  /** Момент начала расхода 1С (ISO с поясом) или null — выключить. */
  onecConsumptionSince?: string | null;
}

/** Склад 1С для выбора в справочнике: к какому складу ERP уже привязан. */
export interface OnecWarehouseOptionDto {
  refKey: string;
  code: string | null;
  name: string;
  linkedWarehouseId: number | null;
  linkedWarehouseName: string | null;
}

export interface WarehouseSyncResultDto {
  created: WarehouseDto[];
  linked: WarehouseDto[];
  skipped: Array<{ refKey: string; name: string; reason: 'name_taken' }>;
}

export interface StockBalanceDto {
  warehouseId: number; filmId: number; filmName: string; vendorId: number | null; vendorName: string | null;
  quantity: number; lastMovementAt: string | null;
}

/** Вид документа в журнале: команды создают receipt/writeoff/inventory, проекция расхода 1С — onec. */
export type StockDocKind = StockDocType | 'onec';

export interface StockDocumentSummaryDto {
  documentId: number; docType: StockDocKind; status: StockDocStatus; warehouseId: number; docDate: string;
  source: 'manual' | 'import' | 'onec'; orderId: number | null; orderName: string | null;
  fileName: string | null; comment: string | null; linesCount: number; totalQuantity: number;
  version: number; createdAt: string; createdByName: string | null; postedAt: string | null; postedByName: string | null;
  /** Момент подсчёта инвентаризации (отсечка расхода 1С). */
  countedAt: string | null;
  /** Документ-дельта проекции расхода 1С: какой документ 1С, ревизия, порядковый номер применения. */
  onec: { documentId: number; refKey: string | null; revision: number | null; projectionSeq: number | null } | null;
}

export interface StockDocumentLineDto {
  lineId: number; lineNo: number; rawName: string | null; rawSupplier: string | null; rawQuantity: string | null;
  filmId: number | null; filmName: string | null; quantity: number | null;
  matchStatus: LineMatchStatus; quantityStatus: LineQuantityStatus;
  suggestions: Array<{ filmId: number; filmName: string; score: number }>; issue: string | null;
  balanceBefore: number | null; balanceAfter: number | null;
}

export interface StockDocumentDto extends StockDocumentSummaryDto {
  /** Ранее проведённый документ с тем же SHA файла (повторная загрузка). */
  previousPostedDocumentId: number | null;
  lines: StockDocumentLineDto[];
  movements: Array<{ filmId: number; filmName: string; movementType: string; delta: number; balanceBefore: number; balanceAfter: number }>;
  unresolved: Array<{ lineId: number; lineNo: number; reason: 'match' | 'quantity' }>;
  negativeAfter: Array<{ filmId: number; filmName: string; after: number }>;
}

export interface OrderFilmStockItemDto {
  filmId: number; canonicalFilmId: number; canonicalName: string; vendorName: string | null;
  stockLm: number | null; demandLm: number | null;
  status: 'enough' | 'short' | 'none' | 'unknown_demand';
}

export interface CommandContext {
  currentUser: CurrentUser;
  requestId: string;
  idempotencyKey: string;
  /** Источник команды в аудите/outbox; по умолчанию `erp_ui` (действие пользователя). */
  source?: string;
  /** Корреляция с внешним процессом (например run 1С); по умолчанию requestId. */
  correlationId?: string;
  /** Роль исполнителя в аудите, если она не из USER_ROLES (служебный пользователь). */
  actorRole?: string;
}

export interface CreateManualDocumentInput {
  docType: StockDocType; warehouseId: number; docDate: string; orderId: number | null; comment: string | null;
  lines: Array<{ filmId: number; quantity: number }>; post: boolean; allowNegative: boolean;
  /** Момент подсчёта инвентаризации (ISO с поясом); только для inventory, по умолчанию — момент проведения. */
  countedAt?: string | null;
}

export interface CreateImportDocumentInput {
  docType: 'receipt' | 'inventory'; warehouseId: number; docDate: string;
  fileName: string; fileSha256: string; sheetName: string;
  rows: Array<{ rowNo: number; name: string; supplier: string | null; quantity: string | number | null }>;
  /** Момент подсчёта инвентаризации (ISO с поясом); только для inventory. */
  countedAt?: string | null;
}

export interface UpdateLineInput {
  documentId: number; lineId: number; version: number;
  filmId?: number; quantity?: number; confirmMatch?: boolean; confirmQuantity?: boolean; skip?: boolean;
}

export interface BalancesFilter {
  warehouseId: number | null; vendorId: number | null; search: string | null;
  nonZero: boolean; negative: boolean; offset: number; limit: number;
}

export interface DocumentsFilter {
  type: StockDocKind | null; status: StockDocStatus | null; from: string | null; to: string | null;
  filmId: number | null; orderId: number | null; offset: number; limit: number;
}

/** Почему остатки 1С склада недоступны (вкладки 1С показывают причину, «Плёнка» работает). */
export type OnecStockUnavailableReason =
  | 'onec_disabled' | 'warehouse_unlinked' | 'warehouse_not_in_onec' | 'ambiguous_source' | 'not_loaded' | 'revoked';

export interface WarehouseStockFilter {
  warehouseId: number;
  /** all | film | film_unlinked | no_type | unlinked | material:<id> */
  group: string;
  search: string | null;
  nonZero: boolean;
  negative: boolean;
  /** Категория 1С (фильтр в группах 1С). */
  categoryKey: string | null;
  offset: number;
  limit: number;
}

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

export interface WarehouseStockDto {
  warehouseId: number;
  warehouseName: string;
  onec: {
    available: boolean;
    reason: OnecStockUnavailableReason | null;
    onecWarehouseName: string | null;
    snapshotVersion: string | null;
    rejectedReason: string | null;
    completeness: string | null;
    /** Отозван справочник позиций/единиц/категорий: у строк нет названий, остатки на месте. */
    directoriesRevoked: boolean;
  };
  tabs: Array<{ key: string; label: string; count: number }>;
  /** Категории 1С строк текущей группы (фильтр). */
  categories: Array<{ key: string; name: string; count: number }>;
  total: number;
  items: WarehouseStockItemDto[];
}
