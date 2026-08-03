import { apiRoutes } from './apiRoutes';
import { authSession } from './authSession';
import { httpClient } from './httpClient';
import type {
  ReferenceUsageRequest,
  UpdateUserPreferencesRequest,
  UserPreferencesResponse,
} from './types/profileApi.types';

const PREFERENCES_CACHE_TTL_MS = 30_000;
const preferencesCache = new Map<string, { response: UserPreferencesResponse; expiresAt: number }>();
const preferencesRequests = new Map<string, Promise<UserPreferencesResponse>>();
const preferencesRevisions = new Map<string, number>();

export const profileApi = {
  getPreferences(options: { force?: boolean } = {}): Promise<UserPreferencesResponse> {
    const cacheKey = currentPreferencesCacheKey();
    const cached = preferencesCache.get(cacheKey);
    if (!options.force && cached && cached.expiresAt > Date.now()) {
      return Promise.resolve(cached.response);
    }

    const pending = preferencesRequests.get(cacheKey);
    if (pending) return pending;

    const revision = preferencesRevisions.get(cacheKey) ?? 0;
    const request = httpClient.get<UserPreferencesResponse>(apiRoutes.profile.preferences)
      .then((response) => {
        if ((preferencesRevisions.get(cacheKey) ?? 0) === revision) {
          cachePreferences(cacheKey, response);
        }
        return response;
      })
      .finally(() => {
        if (preferencesRequests.get(cacheKey) === request) {
          preferencesRequests.delete(cacheKey);
        }
      });
    preferencesRequests.set(cacheKey, request);
    return request;
  },

  updatePreferences(request: UpdateUserPreferencesRequest): Promise<UserPreferencesResponse> {
    const cacheKey = currentPreferencesCacheKey();
    invalidatePreferences(cacheKey);
    return httpClient.patch<UserPreferencesResponse>(apiRoutes.profile.preferences, request)
      .then((response) => {
        cachePreferences(cacheKey, response);
        return response;
      });
  },

  promoteReferenceUsage(request: ReferenceUsageRequest): Promise<UserPreferencesResponse> {
    const cacheKey = currentPreferencesCacheKey();
    invalidatePreferences(cacheKey);
    return httpClient.post<UserPreferencesResponse>(apiRoutes.profile.referenceUsage, request)
      .then((response) => {
        cachePreferences(cacheKey, response);
        return response;
      });
  },
};

export function resetProfilePreferencesCacheForTests(): void {
  preferencesCache.clear();
  preferencesRequests.clear();
  preferencesRevisions.clear();
}

function currentPreferencesCacheKey(): string {
  const userId = authSession.getUser()?.id;
  return userId == null
    ? `session:${authSession.getAccessTokenVersion()}`
    : `user:${String(userId)}`;
}

function cachePreferences(cacheKey: string, response: UserPreferencesResponse): void {
  preferencesCache.set(cacheKey, {
    response,
    expiresAt: Date.now() + PREFERENCES_CACHE_TTL_MS,
  });
}

function invalidatePreferences(cacheKey: string): void {
  preferencesRevisions.set(cacheKey, (preferencesRevisions.get(cacheKey) ?? 0) + 1);
  preferencesCache.delete(cacheKey);
  preferencesRequests.delete(cacheKey);
}
