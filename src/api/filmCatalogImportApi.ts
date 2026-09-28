import { backendApiPath } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';
import type {
  CatalogImportAction, CatalogImportBatchDto, CatalogImportMatchDto,
  CatalogImportRowDto, CatalogNameHistoryDto, CatalogPage, CatalogRowInput, SimilarFilmDto,
} from './types/filmCatalogImportApi.types';

const root = backendApiPath('/catalog-imports');
const commandOptions = (key: string) => ({ headers: { 'Idempotency-Key': key } });

export const filmCatalogImportApi = {
  list(status?: string) { return httpClient.get<{ items: CatalogImportBatchDto[] }>(withQuery(root, { kind: 'films', status })); },
  get(id: number) { return httpClient.get<CatalogImportBatchDto>(`${root}/${id}`); },
  rows(id: number, params: Record<string, string | number | boolean | undefined>) {
    return httpClient.get<CatalogPage<CatalogImportRowDto>>(withQuery(`${root}/${id}/rows`, params));
  },
  matches(id: number, params: Record<string, string | number | boolean | undefined>) {
    return httpClient.get<CatalogPage<CatalogImportMatchDto>>(withQuery(`${root}/${id}/matches`, params));
  },
  createFile(body: { kind: 'films'; source: 'file'; fileName: string; fileSha256: string; sheetName: string; rows: CatalogRowInput[] }, key: string) {
    return httpClient.post<CatalogImportBatchDto>(root, body, commandOptions(key));
  },
  createMirror(body: { kind: 'films'; source: 'onec_mirror'; onecSourceId: number; categoryKey: string }, key: string) {
    return httpClient.post<CatalogImportBatchDto>(root, body, commandOptions(key));
  },
  patch(id: number, version: number, actions: CatalogImportAction[], key: string) {
    return httpClient.patch<CatalogImportBatchDto>(`${root}/${id}`, { version, actions }, commandOptions(key));
  },
  apply(id: number, version: number, key: string) { return httpClient.post<CatalogImportBatchDto>(`${root}/${id}/apply`, { version }, commandOptions(key)); },
  cancel(id: number, version: number, key: string) { return httpClient.post<CatalogImportBatchDto>(`${root}/${id}/cancel`, { version }, commandOptions(key)); },
  revert(id: number, key: string) { return httpClient.post<CatalogImportBatchDto>(`${root}/${id}/revert`, {}, commandOptions(key)); },
  export(id: number) { return httpClient.download(`${root}/${id}/export.xlsx`); },
  onecSources() { return httpClient.get<{ items: Array<{ sourceId: number; name: string }> }>(`${root}/onec-sources`); },
  onecCategories(sourceId: number) { return httpClient.get<{ items: Array<{ key: string; name: string; itemsCount: number }> }>(withQuery(`${root}/onec-categories`, { onecSourceId: sourceId })); },
  nameHistory(filmId: number) { return httpClient.get<{ items: CatalogNameHistoryDto[] }>(backendApiPath(`/films/${filmId}/name-history`)); },
  similar(name: string, vendorId: number) { return httpClient.get<{ items: SimilarFilmDto[] }>(withQuery(backendApiPath('/films/similar'), { name, vendorId, limit: 10 })); },
};
