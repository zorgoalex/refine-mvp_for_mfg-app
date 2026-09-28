import { backendApiPath } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';
import type {
  InventoryBalanceQuery, InventoryDocumentQuery, InventoryPage, ManualStockDocumentInput,
  OrderFilmStockDto, StockBalanceDto, StockDocumentDto, StockDocumentSummaryDto, StockImportInput,
  StockLinePatch, WarehouseDto,
} from './types/inventoryApi.types';

const root = backendApiPath('/inventory');
const commandOptions = (key: string) => ({ headers: { 'Idempotency-Key': key } });

export function createInventoryIdempotencyKey(): string {
  return crypto.randomUUID();
}

export const inventoryApi = {
  warehouses() { return httpClient.get<{ items: WarehouseDto[] }>(`${root}/warehouses`); },
  balances(params: InventoryBalanceQuery = {}) {
    return httpClient.get<InventoryPage<StockBalanceDto>>(withQuery(`${root}/balances`, params));
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
  orderFilmStock(orderId: number) {
    return httpClient.get<OrderFilmStockDto>(backendApiPath(`/orders/${orderId}/film-stock`));
  },
};
