import { describe, expect, it, vi } from 'vitest';
import {
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
    timeoutMs: 50,
    ...overrides,
  };
}
