import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';

export interface ClientScreenSettings {
  enabled: boolean;
  visibleCodes: string[];
  version: number;
  updatedAt: string;
}

export interface ClientScreenSettingsUpdate {
  enabled: boolean;
  visibleCodes: string[];
  expectedVersion: number;
}

export type ClientScreenSettingsUpdateResult = ClientScreenSettings & { changed: boolean };

export const clientScreenSettingsApi = {
  get(): Promise<ClientScreenSettings> {
    return httpClient.get<ClientScreenSettings>(apiRoutes.clientScreen.settings);
  },

  update(payload: ClientScreenSettingsUpdate): Promise<ClientScreenSettingsUpdateResult> {
    return httpClient.put<ClientScreenSettingsUpdateResult>(apiRoutes.clientScreen.settings, payload);
  },
};
