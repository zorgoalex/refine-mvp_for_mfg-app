import { describe, expect, it } from 'vitest';
import {
  applyFeatureFlags,
  featureFlags,
  getFeatureFlags,
  mergeRuntimeFeatureFlags,
  readBooleanFlag,
  readOptionalBooleanFlag,
} from './featureFlags';

describe('featureFlags', () => {
  it('defaults backend flows off and legacy Hasura on', () => {
    expect(getFeatureFlags({})).toEqual({
      useBackendAuth: false,
      useBackendPermissions: false,
      useBackendOrdersRead: false,
      useBackendOrdersWrite: false,
      useBackendPayments: false,
      useBackendClientPhones: false,
      useBackendProductionActions: false,
      useBackendOrderExport: false,
      useBackendUsers: false,
      useBackendVlm: false,
      useBackendReferences: false,
      enableLegacyHasura: true,
    });
  });

  it('supports split read/write orders flags', () => {
    expect(
      getFeatureFlags({
        VITE_USE_BACKEND_ORDERS_READ: 'true',
        VITE_USE_BACKEND_ORDERS_WRITE: 'false',
      }),
    ).toMatchObject({
      useBackendOrdersRead: true,
      useBackendOrdersWrite: false,
    });
  });

  it('keeps backward compatibility with VITE_USE_BACKEND_ORDERS', () => {
    expect(getFeatureFlags({ VITE_USE_BACKEND_ORDERS: 'true' })).toMatchObject({
      useBackendOrdersRead: true,
      useBackendOrdersWrite: true,
    });
  });

  it('parses boolean-like values with fallback', () => {
    expect(readBooleanFlag('1', false)).toBe(true);
    expect(readBooleanFlag('off', true)).toBe(false);
    expect(readBooleanFlag(undefined, true)).toBe(true);
    expect(readBooleanFlag('unknown', false)).toBe(false);
  });

  it('overrides build-time flags from runtime config only for provided keys', () => {
    expect(
      getFeatureFlags(
        {
          VITE_USE_BACKEND_AUTH: 'false',
          VITE_USE_BACKEND_ORDERS_READ: 'true',
          VITE_USE_BACKEND_ORDERS_WRITE: 'true',
          VITE_USE_BACKEND_PAYMENTS: 'false',
          VITE_USE_BACKEND_CLIENT_PHONES: 'false',
          VITE_USE_BACKEND_PRODUCTION_ACTIONS: 'false',
          VITE_USE_BACKEND_VLM: 'true',
        },
        {
          backendAuth: true,
          backendOrdersWrite: false,
          backendPayments: true,
          backendClientPhones: true,
          backendProductionActions: true,
        },
      ),
    ).toMatchObject({
      useBackendAuth: true,
      useBackendOrdersRead: true,
      useBackendOrdersWrite: false,
      useBackendPayments: true,
      useBackendClientPhones: true,
      useBackendProductionActions: true,
      useBackendVlm: true,
    });
  });

  it('supports runtime backendOrders compatibility flag for read and write', () => {
    expect(
      getFeatureFlags(
        {},
        {
          backendOrders: true,
        },
      ),
    ).toMatchObject({
      useBackendOrdersRead: true,
      useBackendOrdersWrite: true,
    });
  });

  it('fails closed for backend client phones until production actions are enabled', () => {
    expect(
      getFeatureFlags({
        VITE_USE_BACKEND_CLIENT_PHONES: 'true',
        VITE_USE_BACKEND_PRODUCTION_ACTIONS: 'false',
      }),
    ).toMatchObject({
      useBackendClientPhones: false,
      useBackendProductionActions: false,
    });

    expect(
      getFeatureFlags(
        { VITE_USE_BACKEND_PRODUCTION_ACTIONS: 'false' },
        { backendClientPhones: true },
      ),
    ).toMatchObject({
      useBackendClientPhones: false,
      useBackendProductionActions: false,
    });

    expect(
      getFeatureFlags(
        { VITE_USE_BACKEND_PRODUCTION_ACTIONS: 'true' },
        { backendClientPhones: true },
      ),
    ).toMatchObject({
      useBackendClientPhones: true,
      useBackendProductionActions: true,
    });
  });

  it('ignores invalid runtime boolean values and keeps fallback', () => {
    const fallback = getFeatureFlags({ VITE_USE_BACKEND_USERS: 'true' });

    expect(
      mergeRuntimeFeatureFlags(fallback, {
        backendUsers: 'not-a-boolean',
      }),
    ).toMatchObject({
      useBackendUsers: true,
    });
    expect(readOptionalBooleanFlag('not-a-boolean')).toBeUndefined();
  });

  it('can update the exported featureFlags object in place', () => {
    const original = { ...featureFlags };

    applyFeatureFlags({ ...original, useBackendVlm: true });

    expect(featureFlags.useBackendVlm).toBe(true);
    applyFeatureFlags(original);
  });
});
