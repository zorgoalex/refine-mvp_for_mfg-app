import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  DailyDigestPreview,
  DailyDigestRetryInput,
  DailyDigestRunDetail,
  DailyDigestRunResponse,
  DailyDigestRunsResponse,
  DailyDigestSettingsEnvelope,
  DailyDigestSettingsInput,
} from './dailyOrderDigestTypes';

export const dailyOrderDigestApi = {
  settings: () =>
    httpClient.get<DailyDigestSettingsEnvelope>(apiRoutes.whatsapp.dailyDigest.settings),
  saveSettings: (body: DailyDigestSettingsInput) =>
    httpClient.put<DailyDigestSettingsEnvelope>(apiRoutes.whatsapp.dailyDigest.settings, body),
  preview: () =>
    httpClient.post<DailyDigestPreview>(apiRoutes.whatsapp.dailyDigest.preview, {}),
  send: (body: { settingsVersion: number; idempotencyKey: string; confirmed: true }) =>
    httpClient.post<DailyDigestRunResponse>(apiRoutes.whatsapp.dailyDigest.runs, body),
  runs: () =>
    httpClient.get<DailyDigestRunsResponse>(apiRoutes.whatsapp.dailyDigest.runs),
  run: (runId: string) =>
    httpClient.get<DailyDigestRunDetail>(apiRoutes.whatsapp.dailyDigest.runById(runId)),
  pageImage: async (runId: string, pageIndex: number) =>
    (await httpClient.download(apiRoutes.whatsapp.dailyDigest.pageImage(runId, pageIndex))).blob,
  retry: (runId: string, body: DailyDigestRetryInput) =>
    httpClient.post<DailyDigestRunResponse>(apiRoutes.whatsapp.dailyDigest.retry(runId), body),
};
