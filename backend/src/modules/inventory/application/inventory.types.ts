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

export interface StockDocumentSummaryDto {
  documentId: number; docType: StockDocType; status: StockDocStatus; warehouseId: number; docDate: string;
  source: 'manual' | 'import'; orderId: number | null; orderName: string | null;
  fileName: string | null; comment: string | null; linesCount: number; totalQuantity: number;
  version: number; createdAt: string; createdByName: string | null; postedAt: string | null; postedByName: string | null;
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
}

export interface CreateManualDocumentInput {
  docType: StockDocType; warehouseId: number; docDate: string; orderId: number | null; comment: string | null;
  lines: Array<{ filmId: number; quantity: number }>; post: boolean; allowNegative: boolean;
}

export interface CreateImportDocumentInput {
  docType: 'receipt' | 'inventory'; warehouseId: number; docDate: string;
  fileName: string; fileSha256: string; sheetName: string;
  rows: Array<{ rowNo: number; name: string; supplier: string | null; quantity: string | number | null }>;
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
  type: StockDocType | null; status: StockDocStatus | null; from: string | null; to: string | null;
  filmId: number | null; orderId: number | null; offset: number; limit: number;
}
