import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  BroadcastCatalog,
  BroadcastControl,
  BroadcastEnvelope,
  BroadcastInput,
  BroadcastManualSendInput,
  BroadcastPreview,
  BroadcastReplanInput,
  BroadcastRetryInput,
  BroadcastRunDetail,
  BroadcastRunResponse,
  BroadcastRunsResponse,
  BroadcastsListResponse,
  BroadcastUpdateInput,
  LegacyDigestRunsResponse,
} from './broadcastsApiTypes';

const routes = apiRoutes.whatsapp.broadcasts;

export const broadcastsApi = {
  list: () => httpClient.get<BroadcastsListResponse>(routes.list),
  create: (body: BroadcastInput) => httpClient.post<BroadcastEnvelope>(routes.list, body),
  control: () => httpClient.get<BroadcastControl>(routes.control),
  setControl: (body: { version: number; paused: boolean }) =>
    httpClient.post<BroadcastControl>(routes.control, body),
  catalog: () => httpClient.get<BroadcastCatalog>(routes.catalog),
  legacyDigestRuns: () => httpClient.get<LegacyDigestRunsResponse>(routes.legacyDigestRuns),
  get: (id: number) => httpClient.get<BroadcastEnvelope>(routes.byId(id)),
  update: (id: number, body: BroadcastUpdateInput) =>
    httpClient.patch<BroadcastEnvelope>(routes.byId(id), body),
  archive: (id: number, body: { version: number }) =>
    httpClient.post<BroadcastEnvelope>(routes.archive(id), body),
  preview: (id: number) => httpClient.post<BroadcastPreview>(routes.preview(id), {}),
  send: (id: number, body: BroadcastManualSendInput) =>
    httpClient.post<BroadcastRunResponse>(routes.runs(id), body),
  runs: (id: number) => httpClient.get<BroadcastRunsResponse>(routes.runs(id)),
  replanToday: (id: number, body: BroadcastReplanInput) =>
    httpClient.post<BroadcastEnvelope>(routes.replanToday(id), body),
  run: (runId: string) => httpClient.get<BroadcastRunDetail>(routes.runById(runId)),
  messageImage: async (runId: string, seq: number) =>
    (await httpClient.download(routes.messageImage(runId, seq))).blob,
  retry: (runId: string, body: BroadcastRetryInput) =>
    httpClient.post<BroadcastRunResponse>(routes.retry(runId), body),
};
