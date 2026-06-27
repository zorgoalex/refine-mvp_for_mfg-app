import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  UpdateUserPreferencesRequest,
  UserPreferencesResponse,
} from './types/profileApi.types';

export const profileApi = {
  getPreferences(): Promise<UserPreferencesResponse> {
    return httpClient.get<UserPreferencesResponse>(apiRoutes.profile.preferences);
  },

  updatePreferences(request: UpdateUserPreferencesRequest): Promise<UserPreferencesResponse> {
    return httpClient.patch<UserPreferencesResponse>(apiRoutes.profile.preferences, request);
  },
};
