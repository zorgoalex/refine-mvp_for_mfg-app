import { backendApiPath } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';
import type {
  InventoryBalanceQuery, InventoryDocumentQuery, InventoryPage, ManualStockDocumentInput,
  OrderFilmStockDto, OrderSheetStockDto, StockBalanceDto, StockDocumentDto, StockDocumentSummaryDto, StockImportInput,
  OnecCompensateDto, OnecConsumptionRunDto, OnecIssuesPage, OnecIssuesQuery, OnecWarehouseOptionDto, StockLinePatch, WarehouseCreateInput, WarehouseDto, WarehousePatch, WarehouseSyncResultDto,
  WarehouseStockDto, WarehouseStockQuery,
  OnecSnapshotCardDto, OnecSnapshotDto, OnecSnapshotsPage, OnecSnapshotStatus, OnecSnapshotStockDto, OnecSnapshotStockQuery,
} from './types/inventoryApi.types';

const root = backendApiPath('/inventory');
const commandOptions = (key: string) => ({ headers: { 'Idempotency-Key': key } });

export function createInventoryIdempotencyKey(): string {
  return crypto.randomUUID();
}

export const inventoryApi = {
  warehouses(params: { includeInactive?: boolean } = {}) {
    return httpClient.get<{ items: WarehouseDto[] }>(withQuery(`${root}/warehouses`, params.includeInactive ? { includeInactive: true } : {}));
  },
  createWarehouse(body: WarehouseCreateInput, key = createInventoryIdempotencyKey()) {
    return httpClient.post<WarehouseDto>(`${root}/warehouses`, body, commandOptions(key));
  },
  updateWarehouse(id: number, body: WarehousePatch, key = createInventoryIdempotencyKey()) {
    return httpClient.patch<WarehouseDto>(`${root}/warehouses/${id}`, body, commandOptions(key));
  },
  onecWarehouses() {
    return httpClient.get<{ available: boolean; items: OnecWarehouseOptionDto[] }>(`${root}/warehouses/onec`);
  },
  syncWarehouses(key = createInventoryIdempotencyKey()) {
    return httpClient.post<WarehouseSyncResultDto>(`${root}/warehouses/sync-onec`, {}, commandOptions(key));
  },
  balances(params: InventoryBalanceQuery = {}) {
    return httpClient.get<InventoryPage<StockBalanceDto>>(withQuery(`${root}/balances`, params));
  },
  /** Остатки склада по вкладкам: плёнка — учёт ERP, прочие материалы — остатки 1С (только чтение). */
  stock(params: WarehouseStockQuery) {
    return httpClient.get<WarehouseStockDto>(withQuery(`${root}/stock`, params));
  },
  documents(params: InventoryDocumentQuery = {}) {
    return httpClient.get<InventoryPage<StockDocumentSummaryDto>>(withQuery(`${root}/documents`, params));
  },
  document(id: number) { return httpClient.get<StockDocumentDto>(`${root}/documents/${id}`); },
  create(body: ManualStockDocumentInput, key = createInventoryIdempotencyKey()) {
    return httpClient.post<StockDocumentDto>(`${root}/documents`, body, commandOptions(key));
  },
  createImport(body: StockImportInput, key = createInventoryIdempotencyKey()) {
    return httpClient.post<StockDocumentDto>(`${root}/imports`, body, commandOptions(key));
  },
  patchLine(id: number, lineId: number, body: StockLinePatch, key = createInventoryIdempotencyKey()) {
    return httpClient.patch<StockDocumentDto>(`${root}/documents/${id}/lines/${lineId}`, body, commandOptions(key));
  },
  post(id: number, version: number, allowNegative = false, key = createInventoryIdempotencyKey()) {
    return httpClient.post<StockDocumentDto>(`${root}/documents/${id}/post`, { version, ...(allowNegative ? { allowNegative: true } : {}) }, commandOptions(key));
  },
  cancel(id: number, version: number, key = createInventoryIdempotencyKey()) {
    return httpClient.post<StockDocumentDto>(`${root}/documents/${id}/cancel`, { version }, commandOptions(key));
  },
  /** Строки расхода 1С, не попавшие в остатки (причины). */
  onecIssues(params: OnecIssuesQuery = {}) {
    return httpClient.get<OnecIssuesPage>(withQuery(`${root}/onec-consumption/issues`, params));
  },
  runOnecConsumption() {
    return httpClient.post<OnecConsumptionRunDto>(`${root}/onec-consumption/run`, {});
  },
  /**
   * Откат: всё применённое на складе по документам 1С (расход и приход) возвращается в 0, дата начала очищается.
   * `includesReceipts` — подтверждение, что пользователю показано предупреждение о снятии поступлений: без него
   * backend с включённым приходом откат не выполняет.
   */
  compensateOnecConsumption(warehouseId: number, key = createInventoryIdempotencyKey()) {
    return httpClient.post<OnecCompensateDto>(`${root}/warehouses/${warehouseId}/onec-consumption/compensate`, { includesReceipts: true }, commandOptions(key));
  },
  /** Срезы остатков 1С на дату: возможности сервера и страница срезов (от новых). */
  onecSnapshots(params: { status?: OnecSnapshotStatus; offset?: number; limit?: number } = {}) {
    return httpClient.get<OnecSnapshotsPage>(withQuery(`${root}/onec-snapshots`, params));
  },
  /** Запросить срез на момент (местное время базы 1С); без `force` вернётся уже существующий срез этого момента. */
  requestOnecSnapshot(body: { momentLocal: string; force?: boolean }, key = createInventoryIdempotencyKey()) {
    return httpClient.post<OnecSnapshotDto>(`${root}/onec-snapshots`, body, commandOptions(key));
  },
  onecSnapshot(id: number) {
    return httpClient.get<OnecSnapshotCardDto>(`${root}/onec-snapshots/${id}`);
  },
  onecSnapshotStock(id: number, params: OnecSnapshotStockQuery = {}) {
    return httpClient.get<OnecSnapshotStockDto>(withQuery(`${root}/onec-snapshots/${id}/stock`, params));
  },
  /** Сравнение среза с текущими остатками 1С (`current`) или с другим срезом; разница — вторая сторона минус срез. */
  compareOnecSnapshot(id: number, other: 'current' | number, params: OnecSnapshotStockQuery = {}) {
    return httpClient.get<OnecSnapshotStockDto>(withQuery(`${root}/onec-snapshots/${id}/compare`, { ...params, with: String(other) }));
  },
  /** Готовые срезы той же базы 1С, с которыми можно сравнить срез (поиск по номеру или дате). */
  comparableOnecSnapshots(id: number, params: { search?: string; offset?: number; limit?: number } = {}) {
    return httpClient.get<{ items: OnecSnapshotDto[]; total: number }>(withQuery(`${root}/onec-snapshots/${id}/comparable`, params));
  },
  deleteOnecSnapshot(id: number, key = createInventoryIdempotencyKey()) {
    return httpClient.delete<void>(`${root}/onec-snapshots/${id}`, commandOptions(key));
  },
  /** Остатки листовых материалов заказа по данным 1С. */
  orderSheetStock(orderId: number) {
    return httpClient.get<OrderSheetStockDto>(backendApiPath(`/orders/${orderId}/sheet-stock`));
  },
  orderFilmStock(orderId: number) {
    return httpClient.get<OrderFilmStockDto>(backendApiPath(`/orders/${orderId}/film-stock`));
  },
};
