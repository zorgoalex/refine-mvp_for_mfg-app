import { afterEach, describe, expect, it, vi } from 'vitest';
import { featureFlags } from './featureFlags';
import {
  applyRuntimeConfig,
  getLoadedRuntimeConfig,
  getRuntimeApiUrl,
  initializeRuntimeConfig,
  resetRuntimeConfigForTests,
} from './runtimeConfig';

describe('runtimeConfig', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetRuntimeConfigForTests();
  });

  it('applies runtime apiUrl and feature overrides over build-time env', () => {
    applyRuntimeConfig(
      {
        apiUrl: 'https://api.example.test/',
        features: {
          backendAuth: true,
          backendOrdersRead: true,
          backendOrdersWrite: false,
          backendPayments: true,
          backendProductionActions: true,
          backendVlm: true,
        },
      },
      {
        VITE_USE_BACKEND_AUTH: 'false',
        VITE_USE_BACKEND_ORDERS_READ: 'false',
        VITE_USE_BACKEND_ORDERS_WRITE: 'true',
        VITE_USE_BACKEND_PAYMENTS: 'false',
        VITE_USE_BACKEND_PRODUCTION_ACTIONS: 'false',
        VITE_USE_BACKEND_VLM: 'false',
      },
    );

    expect(getRuntimeApiUrl()).toBe('https://api.example.test');
    expect(featureFlags).toMatchObject({
      useBackendAuth: true,
      useBackendOrdersRead: true,
      useBackendOrdersWrite: false,
      useBackendPayments: true,
      useBackendProductionActions: true,
      useBackendVlm: true,
    });
  });

  it('falls back to build-time env when runtime config is missing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }));

    const config = await initializeRuntimeConfig({
      fetchImpl: fetchMock,
      env: { VITE_USE_BACKEND_USERS: 'true' },
      timeoutMs: 10,
    });

    expect(config).toBeNull();
    expect(getLoadedRuntimeConfig()).toBeNull();
    expect(getRuntimeApiUrl()).toBeNull();
    expect(featureFlags.useBackendUsers).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/runtime-config.json',
      expect.objectContaining({
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      }),
    );
  });

  it('ignores malformed runtime config and keeps env fallback', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(['not', 'an', 'object']), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const config = await initializeRuntimeConfig({
      fetchImpl: fetchMock,
      env: { VITE_USE_BACKEND_ORDER_EXPORT: 'true' },
      timeoutMs: 10,
    });

    expect(config).toBeNull();
    expect(featureFlags.useBackendOrderExport).toBe(true);
  });

  it('uses VITE_RUNTIME_CONFIG_URL when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ features: { backendVlm: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await initializeRuntimeConfig({
      fetchImpl: fetchMock,
      env: { VITE_RUNTIME_CONFIG_URL: '/config/frontend.json' },
      timeoutMs: 10,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/config/frontend.json',
      expect.any(Object),
    );
    expect(featureFlags.useBackendVlm).toBe(true);
  });

  it('accepts only boolean UI rollout values and preserves them for bootstrap', () => {
    applyRuntimeConfig({
      ui: { evolutionEnabled: true, forceLegacy: false },
    });

    expect(getLoadedRuntimeConfig()?.ui).toEqual({
      evolutionEnabled: true,
      forceLegacy: false,
    });
  });

  it('preserves a valid lifecycle rollout and observability contract', () => {
    applyRuntimeConfig({
      build: { sha: 'abcdef123456' },
      observability: { performanceRum: true },
      rollouts: {
        orderLifecycleV2: {
          enabled: true,
          percent: 25,
          allocationSalt: 'salt-v1',
          configVersion: 'lifecycle-v1',
        },
      },
    });

    expect(getLoadedRuntimeConfig()).toMatchObject({
      build: { sha: 'abcdef123456' },
      observability: { performanceRum: true },
      rollouts: { orderLifecycleV2: { enabled: true, percent: 25 } },
    });
  });

  it('rejects enabled lifecycle rollout without safe version and salt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        rollouts: {
          orderLifecycleV2: {
            enabled: true,
            percent: 25,
            allocationSalt: '',
            configVersion: 'v1',
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    expect(await initializeRuntimeConfig({ fetchImpl: fetchMock, timeoutMs: 10 })).toBeNull();
  });

  it('fails closed when UI runtime shape is malformed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ui: { evolutionEnabled: 'true' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const config = await initializeRuntimeConfig({
      fetchImpl: fetchMock,
      env: { VITE_UI_EVOLUTION: 'true' },
      timeoutMs: 10,
    });

    expect(config).toBeNull();
    expect(getLoadedRuntimeConfig()).toBeNull();
  });
});
