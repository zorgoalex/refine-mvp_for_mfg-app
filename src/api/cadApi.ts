import { backendApiPath } from './apiRoutes';
import { httpClient } from './httpClient';
import type { CadGroup, CadRecipeRef, CadSourceSnapshot, CadVariant } from '@shared/cad-workspace';
import { cadCatalogSchema, type CadJob, type CadPreview, type CadExportReview, type CadApprovalCommand } from '@shared/cad-api';

const path = (value: string) => backendApiPath(`/cad${value}`);
const post = <T>(value: string, body: unknown = {}, key: string = crypto.randomUUID()) => httpClient.post<T>(path(value), body, { headers: { 'Idempotency-Key': key } });
export interface CadRunResponse { run: { id: string; status: string; lastError: string | null; packageId: string | null; packageRequested: boolean } | null; job: CadJob | null }
export interface CadMapping { milling_type_id: number; milling_type_name: string; recipe: CadRecipeRef | null; revision: number | null }
export const cadApi = {
  capabilities: () => httpClient.get<{ enabled: boolean; editorEnabled?: boolean }>(path('/capabilities')),
  workspace: (orderId: number) => httpClient.get<{ workspaceId: string | null; variants: CadVariant[] }>(path(`/orders/${orderId}`)),
  create: (orderId: number) => post<{ workspaceId: string }>(`/orders/${orderId}/render`),
  source: (orderId: number) => post<CadSourceSnapshot>(`/orders/${orderId}/source`),
  sourceStatus: (id: string) => httpClient.get<Array<{ orderId: number; stale: boolean; changedDetailIds: number[] }>>(path(`/variants/${id}/source-status`)),
  save: (variant: CadVariant, groups: CadGroup[], sourceIds: string[], key?: string) => post<CadVariant>(`/variants/${variant.id}/save`, { version: variant.version, groups, sourceIds }, key),
  fork: (variant: CadVariant, groups: CadGroup[], sourceIds: string[], name: string, key: string) => post<CadVariant>(`/variants/${variant.id}/fork`, { version: variant.version, groups, sourceIds, name }, key),
  preview: (variant: CadVariant, groups: CadGroup[]) => post<CadPreview>(`/variants/${variant.id}/preview`, { version: variant.version, groups }),
  clone: (id: string, name: string, refresh = false) => post<CadVariant>(`/variants/${id}/clone`, { name, refresh }),
  render: (variant: CadVariant) => post<{ runId: string }>(`/variants/${variant.id}/render`, { version: variant.version }),
  run: (id: string, version: number) => httpClient.get<CadRunResponse>(path(`/variants/${id}/runs/${version}`)),
  preflight: (variant: CadVariant, key?: string) => post<CadExportReview>(`/variants/${variant.id}/preflight`, { version: variant.version }, key),
  package: (variant: CadVariant, reviewId?: string, acknowledgeStale = false, key?: string) => post<{ runId: string }>(`/variants/${variant.id}/package`, { version: variant.version, reviewId, acknowledgeStale }, key),
  approve: (variant: CadVariant, groupId: string, manufacturingHash: string, reason: string, key: string) => post<CadApprovalCommand>(`/variants/${variant.id}/approve`, { version: variant.version, groupId, manufacturingHash, reason }, key),
  approval: (id: string) => httpClient.get<CadApprovalCommand>(path(`/approval-commands/${id}`)),
  catalog: async () => cadCatalogSchema.parse(await httpClient.get(path('/recipes'))),
  mappings: () => httpClient.get<CadMapping[]>(path('/mappings')),
  map: (id: number, recipe: CadRecipeRef, revision: number) => post(`/mappings/${id}`, { recipe, revision }),
  async download(runId: string, artifactId: string, fileName: string, reviewId?: string) {
    const { blob } = await httpClient.download(path(`/runs/${runId}/artifacts/${artifactId}?reviewId=${encodeURIComponent(reviewId ?? '')}`));
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName;
    anchor.hidden = true; document.body.append(anchor); anchor.click(); anchor.remove();
    // Browser may schedule the actual download after the click task, especially
    // on a loaded tablet. Keep the blob alive long enough to retain its filename.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  },
};
