import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';
import type {
  ProcurementSavedView,
  ProcurementSettings,
  ProcurementSettingsUpdate,
  ProcurementWorklistParams,
  ProcurementWorklistResponse,
} from './types/procurementWorkspaceApi.types';

export const procurementWorkspaceApi = {
  worklist(params: ProcurementWorklistParams, options?: { signal?: AbortSignal }): Promise<ProcurementWorklistResponse> {
    return httpClient.get<ProcurementWorklistResponse>(withQuery(apiRoutes.procurement.worklist, params), options);
  },

  async savedViews(): Promise<ProcurementSavedView[]> {
    return (await httpClient.get<{ views: ProcurementSavedView[] }>(apiRoutes.procurement.savedViews)).views;
  },

  async replaceSavedViews(views: ProcurementSavedView[]): Promise<ProcurementSavedView[]> {
    return (await httpClient.put<{ views: ProcurementSavedView[] }>(apiRoutes.procurement.savedViews, { views })).views;
  },

  settings(): Promise<ProcurementSettings> {
    return httpClient.get<ProcurementSettings>(apiRoutes.procurement.settings);
  },

  updateSettings(body: ProcurementSettingsUpdate): Promise<ProcurementSettings & { changed: boolean }> {
    return httpClient.put<ProcurementSettings & { changed: boolean }>(apiRoutes.procurement.settings, body);
  },
};
