import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/apiError';
import {
  isConfirmedSignedOutError,
  isUiVariantFromDeviceHint,
  resolveInitialUiVariant,
  type UiVariantBootstrapDependencies,
} from './uiVariantBootstrap';

describe('UI variant bootstrap', () => {
  it('restores auth and resolves a confirmed server preference before paint', async () => {
    const calls: string[] = [];
    const setCached = vi.fn();
    const dependencies = makeDependencies({
      restoreSession: async () => {
        calls.push('restore');
      },
      getPreferences: async () => {
        calls.push('preferences');
        return { preferences: { uiVariant: 'line' } };
      },
      setCached,
    });

    await expect(resolveInitialUiVariant(
      { evolutionEnabled: true, forceLegacy: false },
      dependencies,
    )).resolves.toBe('line');
    expect(calls).toEqual(['restore', 'preferences']);
    expect(setCached).toHaveBeenCalledWith('7', 'line');
  });

  it('skips auth and preferences when rollout is unavailable or force-disabled', async () => {
    const restoreSession = vi.fn(async () => undefined);
    const dependencies = makeDependencies({ restoreSession });

    await expect(resolveInitialUiVariant(
      { evolutionEnabled: false },
      dependencies,
    )).resolves.toBe('legacy');
    await expect(resolveInitialUiVariant(
      { evolutionEnabled: true, forceLegacy: true },
      dependencies,
    )).resolves.toBe('legacy');
    expect(restoreSession).not.toHaveBeenCalled();
  });

  it('resolves a confirmed workbench preference on desktop and keeps the kill-switch stronger', async () => {
    const setCached = vi.fn();
    await expect(resolveInitialUiVariant(
      { evolutionEnabled: true, forceLegacy: false },
      makeDependencies({ getPreferences: async () => ({ preferences: { uiVariant: 'workbench' } }), setCached }),
    )).resolves.toBe('workbench');
    expect(setCached).toHaveBeenCalledWith('7', 'workbench');
    await expect(resolveInitialUiVariant(
      { evolutionEnabled: true, forceLegacy: true },
      makeDependencies({ getPreferences: async () => ({ preferences: { uiVariant: 'workbench' } }) }),
    )).resolves.toBe('legacy');
  });

  it('keeps the tablet shell on Evolution for a saved workbench preference (phase 1: desktop/phone only)', async () => {
    await expect(resolveInitialUiVariant(
      { evolutionEnabled: true, forceLegacy: false },
      makeDependencies({ isTabletDevice: () => true, getCached: () => 'workbench' }),
    )).resolves.toBe('evolution');
    const setCached = vi.fn();
    await expect(resolveInitialUiVariant(
      { evolutionEnabled: true, forceLegacy: false },
      makeDependencies({
        getPreferences: async () => ({ preferences: { uiVariant: 'workbench', tabletMode: true } }),
        setCached,
      }),
    )).resolves.toBe('evolution');
    // the stored choice is not overwritten by the tablet override
    expect(setCached).not.toHaveBeenCalled();
  });

  it('falls back to the same-user cached workbench choice when preferences cannot be read', async () => {
    await expect(resolveInitialUiVariant(
      { evolutionEnabled: true, forceLegacy: false },
      makeDependencies({ getPreferences: async () => { throw new Error('offline'); }, getCached: () => 'workbench' }),
    )).resolves.toBe('workbench');
  });

  it('forces Evolution before preference lookup on a physical tablet', async () => {
    const restoreSession = vi.fn(async () => undefined);
    const getPreferences = vi.fn(async () => ({ preferences: { uiVariant: 'legacy' } }));
    const dependencies = makeDependencies({
      isTabletDevice: () => true,
      restoreSession,
      getPreferences,
      getCached: () => 'air',
    });

    await expect(resolveInitialUiVariant(
      { evolutionEnabled: true, forceLegacy: false },
      dependencies,
    )).resolves.toBe('evolution');
    expect(restoreSession).not.toHaveBeenCalled();
    expect(getPreferences).not.toHaveBeenCalled();
  });

  it('keeps forceLegacy stronger than the tablet override', async () => {
    await expect(resolveInitialUiVariant(
      { evolutionEnabled: true, forceLegacy: true },
      makeDependencies({ isTabletDevice: () => true }),
    )).resolves.toBe('legacy');
  });

  it('forces Evolution from the confirmed cross-device tablet preference', async () => {
    const setTabletModeCached = vi.fn();
    const dependencies = makeDependencies({
      getPreferences: async () => ({
        preferences: { uiVariant: 'legacy', tabletMode: true },
      }),
      setTabletModeCached,
    });

    await expect(resolveInitialUiVariant(
      { evolutionEnabled: true, forceLegacy: false },
      dependencies,
    )).resolves.toBe('evolution');
    expect(setTabletModeCached).toHaveBeenCalledWith('7', true);
  });

  it('uses the same-user tablet cache during a mixed frontend/backend rollout', async () => {
    const dependencies = makeDependencies({
      getPreferences: async () => ({ preferences: { uiVariant: 'legacy' } }),
      getTabletModeCached: () => true,
    });

    await expect(resolveInitialUiVariant(
      { evolutionEnabled: true, forceLegacy: false },
      dependencies,
    )).resolves.toBe('evolution');
  });

  it('uses only the same-user confirmed cache when preferences are unavailable', async () => {
    const dependencies = makeDependencies({
      getPreferences: async () => {
        throw new Error('offline');
      },
      getCached: () => 'air',
    });

    await expect(resolveInitialUiVariant(
      { evolutionEnabled: true },
      dependencies,
    )).resolves.toBe('air');
  });

  it('uses evolution default when an old backend returns 200 without uiVariant', async () => {
    const dependencies = makeDependencies({
      getPreferences: async () => ({ preferences: {} }),
      getCached: () => 'legacy',
    });

    await expect(resolveInitialUiVariant(
      { evolutionEnabled: true },
      dependencies,
    )).resolves.toBe('evolution');
  });

  it('uses the default when the authenticated user changes during the request', async () => {
    let userId = '7';
    const dependencies = makeDependencies({
      getCurrentUserId: () => userId,
      getCached: () => 'legacy',
      getPreferences: async () => {
        userId = '8';
        return { preferences: { uiVariant: 'legacy' } };
      },
    });

    await expect(resolveInitialUiVariant(
      { evolutionEnabled: true },
      dependencies,
    )).resolves.toBe('evolution');
  });

  it('bounds boot waiting and falls back to evolution when runtime allows it', async () => {
    const dependencies = makeDependencies({
      restoreSession: () => new Promise<void>(() => undefined),
      timeoutMs: 5,
    });

    await expect(resolveInitialUiVariant(
      { evolutionEnabled: true },
      dependencies,
    )).resolves.toBe('evolution');
  });

  it('shows the signed-out login in the variant last used on this device', async () => {
    const config = { evolutionEnabled: true, forceLegacy: false };
    await expect(resolveInitialUiVariant(config, makeDependencies({
      getCurrentUserId: () => null,
      getDeviceHint: () => 'workbench',
    }))).resolves.toBe('workbench');
    await expect(resolveInitialUiVariant(config, makeDependencies({
      restoreSession: async () => { throw new Error('401'); },
      isSignedOutError: () => true,
      getDeviceHint: () => 'workbench',
    }))).resolves.toBe('workbench');
    await expect(resolveInitialUiVariant(config, makeDependencies({
      getCurrentUserId: () => null,
    }))).resolves.toBe('evolution');
    // the kill-switch stays stronger than the device hint
    await expect(resolveInitialUiVariant({ evolutionEnabled: true, forceLegacy: true }, makeDependencies({
      getCurrentUserId: () => null,
      getDeviceHint: () => 'workbench',
    }))).resolves.toBe('legacy');
  });

  it('treats only a refresh 401 as a confirmed sign-out', () => {
    expect(isConfirmedSignedOutError(new ApiError({ code: 'UNAUTHORIZED', message: 'x', status: 401 }))).toBe(true);
    expect(isConfirmedSignedOutError(new ApiError({ code: 'UNAVAILABLE', message: 'x', status: 503 }))).toBe(false);
    expect(isConfirmedSignedOutError(new ApiError({ code: 'AUTH_REFRESH_SUPERSEDED', message: 'x', status: 409 }))).toBe(false);
    expect(isConfirmedSignedOutError(new TypeError('Failed to fetch'))).toBe(false);
  });

  it('marks a hint-derived document so the authenticated shell reboots it', async () => {
    const config = { evolutionEnabled: true, forceLegacy: false };
    await resolveInitialUiVariant(config, makeDependencies({ getCurrentUserId: () => null, getDeviceHint: () => 'workbench' }));
    expect(isUiVariantFromDeviceHint()).toBe(true);
    await resolveInitialUiVariant(config, makeDependencies({ getCurrentUserId: () => null }));
    expect(isUiVariantFromDeviceHint()).toBe(false);
    await resolveInitialUiVariant({ evolutionEnabled: true, forceLegacy: true }, makeDependencies({ getCurrentUserId: () => null, getDeviceHint: () => 'workbench' }));
    expect(isUiVariantFromDeviceHint()).toBe(false);
    await resolveInitialUiVariant(config, makeDependencies({ getDeviceHint: () => 'workbench' }));
    expect(isUiVariantFromDeviceHint()).toBe(false);
  });

  it('never lets the device hint decide a signed-in shell', async () => {
    const config = { evolutionEnabled: true, forceLegacy: false };
    await expect(resolveInitialUiVariant(config, makeDependencies({
      getDeviceHint: () => 'workbench',
    }))).resolves.toBe('legacy');
    // a failed refresh (network, 5xx) is unknown session state, not "signed out":
    // the session may come back on retry and must not get the device hint's shell
    for (const error of [new TypeError('Failed to fetch'), Object.assign(new Error('503'), { status: 503 })]) {
      await expect(resolveInitialUiVariant(config, makeDependencies({
        restoreSession: async () => { throw error; },
        isSignedOutError: (candidate) => (candidate as { status?: number }).status === 401,
        getDeviceHint: () => 'workbench',
      }))).resolves.toBe('evolution');
    }
    // a slow session restore is not "signed out"
    await expect(resolveInitialUiVariant(config, makeDependencies({
      restoreSession: () => new Promise<void>(() => undefined),
      getDeviceHint: () => 'workbench',
      timeoutMs: 5,
    }))).resolves.toBe('evolution');
  });

  it('remembers the resolved signed-in variant as the device hint', async () => {
    const config = { evolutionEnabled: true, forceLegacy: false };
    const setDeviceHint = vi.fn();
    await resolveInitialUiVariant(config, makeDependencies({
      getPreferences: async () => ({ preferences: { uiVariant: 'workbench' } }),
      setDeviceHint,
    }));
    await resolveInitialUiVariant(config, makeDependencies({
      getPreferences: async () => { throw new Error('offline'); },
      getCached: () => 'air',
      setDeviceHint,
    }));
    await resolveInitialUiVariant(config, makeDependencies({
      getPreferences: async () => ({ preferences: { uiVariant: 'workbench', tabletMode: true } }),
      setDeviceHint,
    }));
    expect(setDeviceHint.mock.calls).toEqual([['workbench'], ['air'], ['evolution']]);

    const untouched = vi.fn();
    let userId = '7';
    await resolveInitialUiVariant(config, makeDependencies({
      getCurrentUserId: () => userId,
      getPreferences: async () => {
        userId = '8';
        return { preferences: { uiVariant: 'workbench' } };
      },
      setDeviceHint: untouched,
    }));
    await resolveInitialUiVariant(config, makeDependencies({
      getCurrentUserId: () => null,
      getDeviceHint: () => 'workbench',
      setDeviceHint: untouched,
    }));
    expect(untouched).not.toHaveBeenCalled();
  });
});

function makeDependencies(
  overrides: Partial<UiVariantBootstrapDependencies> = {},
): UiVariantBootstrapDependencies {
  return {
    restoreSession: async () => undefined,
    getCurrentUserId: () => '7',
    hasAccessToken: () => true,
    getPreferences: async () => ({ preferences: { uiVariant: 'legacy' } }),
    getCached: () => null,
    setCached: () => undefined,
    getTabletModeCached: () => null,
    setTabletModeCached: () => undefined,
    timeoutMs: 50,
    ...overrides,
  };
}
