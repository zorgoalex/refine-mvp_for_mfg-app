import { backendApiPath } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';
import type {
  InventoryBalanceQuery, InventoryDocumentQuery, InventoryPage, ManualStockDocumentInput,
  OrderFilmStockDto, OrderSheetStockDto, StockBalanceDto, StockDocumentDto, StockDocumentSummaryDto, StockImportInput,
  OnecCompensateDto, OnecConsumptionRunDto, OnecIssuesPage, OnecIssuesQuery, OnecWarehouseOptionDto, StockLinePatch, WarehouseCreateInput, WarehouseDto, WarehousePatch, WarehouseSyncResultDto,
  WarehouseStockDto, WarehouseStockQuery,
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
  /** Остатки листовых материалов заказа по данным 1С. */
  orderSheetStock(orderId: number) {
    return httpClient.get<OrderSheetStockDto>(backendApiPath(`/orders/${orderId}/sheet-stock`));
  },
  orderFilmStock(orderId: number) {
    return httpClient.get<OrderFilmStockDto>(backendApiPath(`/orders/${orderId}/film-stock`));
  },
};
