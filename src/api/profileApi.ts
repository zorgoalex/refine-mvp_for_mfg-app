import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  ReferenceUsageRequest,
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

  promoteReferenceUsage(request: ReferenceUsageRequest): Promise<UserPreferencesResponse> {
    return httpClient.post<UserPreferencesResponse>(apiRoutes.profile.referenceUsage, request);
  },
};
