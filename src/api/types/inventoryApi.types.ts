export type StockDocType = 'receipt' | 'writeoff' | 'inventory';
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
}
export interface WarehouseCreateInput { name: string; refKey1c: string; workshopId?: number | null; responsibleEmployeeId?: number | null }
export interface WarehousePatch {
  version: string; name?: string; refKey1c?: string; workshopId?: number | null; responsibleEmployeeId?: number | null; isActive?: boolean;
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
  documentId: number; docType: StockDocType; status: StockDocStatus; warehouseId: number; docDate: string;
  source: 'manual' | 'import'; orderId: number | null; orderName: string | null; fileName: string | null;
  comment: string | null; linesCount: number; totalQuantity: number; version: number; createdAt: string;
  createdByName: string | null; postedAt: string | null; postedByName: string | null;
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
export interface InventoryPage<T> { total: number; items: T[]; totalQuantity?: number }
export interface InventoryDocumentQuery { type?: StockDocType; status?: StockDocStatus; from?: string; to?: string; filmId?: number; orderId?: number; offset?: number; limit?: number }
export interface InventoryBalanceQuery { warehouseId?: number; vendorId?: number; search?: string; nonZero?: boolean; negative?: boolean; offset?: number; limit?: number }
export interface ManualStockDocumentInput {
  docType: StockDocType; warehouseId: number; docDate: string; orderId?: number; comment?: string;
  lines: Array<{ filmId: number; quantity: number }>; post?: boolean; allowNegative?: boolean;
}
export interface StockImportInput {
  docType: 'receipt' | 'inventory'; warehouseId: number; docDate: string; fileName: string;
  fileSha256: string; sheetName: string;
  rows: Array<{ rowNo: number; name: string; supplier: string | null; quantity: string | number | null }>;
}
export interface StockLinePatch { version: number; filmId?: number; quantity?: number; confirmMatch?: boolean; confirmQuantity?: boolean; skip?: boolean }
export interface InventoryApiError { statusCode?: number; code?: string; message?: string; details?: unknown }
