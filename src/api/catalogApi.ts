import { backendApiPath } from './apiRoutes';
import { httpClient } from './httpClient';

export type CatalogKind = 'made_to_order' | 'stock_item' | 'service';
export interface CatalogInput {
  name: string; sku: string | null; kind: CatalogKind; unitId: number;
  basePrice: string | null; description: string; isActive: boolean;
}
export interface CatalogItem extends CatalogInput {
  id: number; version: number; currency: 'KZT'; unitName: string; unitSymbol: string | null;
  createdAt: string; updatedAt: string;
}
export interface CatalogUnit { id: number; name: string; code: string; symbol: string | null }
const path = backendApiPath('/catalog-items');
export const catalogApi = {
  list(query: { q: string; kind?: CatalogKind; active: 'true' | 'false' | 'all'; offset: number; limit: number }) {
    const params = new URLSearchParams({ q: query.q, active: query.active, offset: String(query.offset), limit: String(query.limit) });
    if (query.kind) params.set('kind', query.kind);
    return httpClient.get<{ items: CatalogItem[]; total: number }>(`${path}?${params}`);
  },
  units: () => httpClient.get<CatalogUnit[]>(`${path}/units`),
  get: (id: number) => httpClient.get<CatalogItem>(`${path}/${id}`),
  create: (input: CatalogInput, key: string) => httpClient.post<CatalogItem>(path, input, { headers: { 'Idempotency-Key': key } }),
  update: (id: number, input: CatalogInput & { expectedVersion: number }, key: string) => httpClient.put<CatalogItem>(`${path}/${id}`, input, { headers: { 'Idempotency-Key': key } }),
};
