import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authSession } from './authSession';
import { httpClient } from './httpClient';
import { profileApi, resetProfilePreferencesCacheForTests } from './profileApi';
import type { UserPreferencesResponse } from './types/profileApi.types';

const preferencesResponse: UserPreferencesResponse = {
  preferences: {
    themeMode: 'light',
    uiSize: 'middle',
    orderDetailColumns: {},
  },
};

describe('profileApi preferences request sharing', () => {
  beforeEach(() => {
    resetProfilePreferencesCacheForTests();
    authSession.setUser({
      id: '7',
      username: 'manager',
      role: 'manager',
      permissions: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetProfilePreferencesCacheForTests();
    authSession.clear();
  });

  it('coalesces concurrent reads and reuses the fresh user-scoped response', async () => {
    const get = vi.spyOn(httpClient, 'get').mockResolvedValue(preferencesResponse);

    const first = profileApi.getPreferences();
    const second = profileApi.getPreferences();
    await expect(Promise.all([first, second])).resolves.toEqual([
      preferencesResponse,
      preferencesResponse,
    ]);
    await expect(profileApi.getPreferences()).resolves.toBe(preferencesResponse);

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/api/v1/me/preferences');
  });

  it('bypasses the response cache for an explicit focus refresh', async () => {
    const get = vi.spyOn(httpClient, 'get').mockResolvedValue(preferencesResponse);

    await profileApi.getPreferences();
    await profileApi.getPreferences({ force: true });

    expect(get).toHaveBeenCalledTimes(2);
  });

  it('stores mutation responses as the new shared preference snapshot', async () => {
    const updated: UserPreferencesResponse = {
      preferences: { ...preferencesResponse.preferences, uiSize: 'compact' },
    };
    const get = vi.spyOn(httpClient, 'get').mockResolvedValue(preferencesResponse);
    vi.spyOn(httpClient, 'patch').mockResolvedValue(updated);

    await profileApi.updatePreferences({ uiSize: 'compact' });
    await expect(profileApi.getPreferences()).resolves.toBe(updated);

    expect(get).not.toHaveBeenCalled();
  });
});
