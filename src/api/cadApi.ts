import { backendApiPath } from './apiRoutes';
import { httpClient } from './httpClient';
import type { CadGroup, CadRecipeRef, CadSourceSnapshot, CadVariant } from '@shared/cad-workspace';
import { cadCatalogSchema, type CadJob } from '@shared/cad-api';

const path = (value: string) => backendApiPath(`/cad${value}`);
const post = <T>(value: string, body: unknown = {}) => httpClient.post<T>(path(value), body, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
export interface CadRunResponse { run: { id: string; status: string; lastError: string | null; packageId: string | null; packageRequested: boolean } | null; job: CadJob | null }
export interface CadMapping { milling_type_id: number; milling_type_name: string; recipe: CadRecipeRef | null; revision: number | null }
export const cadApi = {
  capabilities: () => httpClient.get<{ enabled: boolean }>(path('/capabilities')),
  workspace: (orderId: number) => httpClient.get<{ workspaceId: string | null; variants: CadVariant[] }>(path(`/orders/${orderId}`)),
  create: (orderId: number) => post<{ workspaceId: string }>(`/orders/${orderId}/render`),
  source: (orderId: number) => post<CadSourceSnapshot>(`/orders/${orderId}/source`),
  sourceStatus: (id: string) => httpClient.get<Array<{ orderId: number; stale: boolean; changedDetailIds: number[] }>>(path(`/variants/${id}/source-status`)),
  save: (variant: CadVariant, groups: CadGroup[], sourceIds: string[]) => post<CadVariant>(`/variants/${variant.id}/save`, { version: variant.version, groups, sourceIds }),
  clone: (id: string, name: string, refresh = false) => post<CadVariant>(`/variants/${id}/clone`, { name, refresh }),
  render: (variant: CadVariant) => post<{ runId: string }>(`/variants/${variant.id}/render`, { version: variant.version }),
  run: (id: string, version: number) => httpClient.get<CadRunResponse>(path(`/variants/${id}/runs/${version}`)),
  package: (variant: CadVariant) => post<{ runId: string }>(`/variants/${variant.id}/package`, { version: variant.version }),
  catalog: async () => cadCatalogSchema.parse(await httpClient.get(path('/recipes'))),
  mappings: () => httpClient.get<CadMapping[]>(path('/mappings')),
  map: (id: number, recipe: CadRecipeRef, revision: number) => post(`/mappings/${id}`, { recipe, revision }),
  async download(runId: string, artifactId: string, fileName: string) {
    const { blob } = await httpClient.download(path(`/runs/${runId}/artifacts/${artifactId}`));
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
