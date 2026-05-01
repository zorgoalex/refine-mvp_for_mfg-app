import { describe, expect, it } from 'vitest';
import { getFeatureFlags, readBooleanFlag } from './featureFlags';

describe('featureFlags', () => {
  it('defaults backend flows off and legacy Hasura on', () => {
    expect(getFeatureFlags({})).toEqual({
      useBackendAuth: false,
      useBackendPermissions: false,
      useBackendOrdersRead: false,
      useBackendOrdersWrite: false,
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
});
