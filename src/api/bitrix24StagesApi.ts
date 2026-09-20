import { httpClient } from './httpClient';
import { apiRoutes } from './apiRoutes';

export interface DealStage {
  id: string;
  name: string;
  sort: number;
  color: string;
  semantics: '' | 'S' | 'F';
}
export interface StageSettingsInput {
  version: number;
  categoryId: number;
  completedStatusId: number;
  enabled: boolean;
  mappings: Array<{ orderStatusId: number; stageId: string }>;
}
export interface StageState {
  jobs?: Array<{ job_id: string; kind: string; created_at: string }>;
  config: {
    member_id: string | null;
    category_id: number | null;
    completed_status_id: number | null;
    enabled: boolean;
    binding_locked: boolean;
    version: number;
    epoch: number;
  };
  statuses: Array<{
    id: number;
    name: string;
    code: string;
    color: string;
    active: boolean;
    used: boolean;
  }>;
  catalogs: Array<{
    member_id: string;
    category_id: number;
    category_name: string;
    stages: DealStage[];
    fetched_at: string;
  }>;
  mappings: Array<{ order_status_id: number; stage_id: string }>;
  counts: Array<{ status: string; count: string }>;
  runtime: { forward: string; reverse: string };
}
export interface StagePreviewRow {
  orderId: string;
  orderName: string;
  bitrixId: string;
  oldName?: string;
  newName?: string;
  change?: boolean;
  error: string | null;
}
export interface StageJob {
  job_id: string;
  kind: 'settings' | 'provision' | 'reconcile';
  expires_at: string;
  results: Record<string, string>;
  payload: {
    settings?: StageSettingsInput;
    affectedOrderIds?: string[];
    rows?: Array<
      StagePreviewRow & {
        statusId?: number;
        name?: string;
        id?: string;
        sort?: number;
      }
    >;
    nextCursor?: string;
    hasMore?: boolean;
  };
}
const base = apiRoutes.bitrix24.orderStages;
export const bitrix24StagesApi = {
  state: () => httpClient.get<StageState>(base),
  refresh: () => httpClient.post<StageState>(`${base}/catalog/refresh`, {}),
  previewSettings: (input: StageSettingsInput) =>
    httpClient.post<StageJob>(`${base}/settings/preview`, input),
  applySettings: (id: string) =>
    httpClient.post<StageState>(
      `${base}/settings/${encodeURIComponent(id)}/apply`,
      {}
    ),
  previewProvision: (statusIds: number[]) =>
    httpClient.post<StageJob>(`${base}/provision/preview`, { statusIds }),
  applyProvision: (id: string) =>
    httpClient.post<StageJob>(
      `${base}/provision/${encodeURIComponent(id)}/apply`,
      {}
    ),
  previewReconcile: (afterId = 0) =>
    httpClient.post<StageJob>(`${base}/reconcile/preview`, {
      afterId,
      limit: 25,
    }),
  applyReconcile: (id: string, orderIds: string[]) =>
    httpClient.post<StageJob>(
      `${base}/reconcile/${encodeURIComponent(id)}/apply`,
      { orderIds }
    ),
  job: (id: string) =>
    httpClient.get<StageJob>(`${base}/jobs/${encodeURIComponent(id)}`),
  retry: (orderId: string) =>
    httpClient.post(`${base}/orders/${encodeURIComponent(orderId)}/retry`, {}),
};
