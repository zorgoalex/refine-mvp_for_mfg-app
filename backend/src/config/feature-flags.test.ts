import { describe, expect, it } from 'vitest';
import { getBackendFeatureFlags } from './feature-flags';
import { validateEnv } from './env.validation';

describe('backend feature flags', () => {
  it('defaults risky modules to disabled/read-only before migration', () => {
    expect(getBackendFeatureFlags(validateEnv({}))).toEqual({
      auth: false,
      orders: false,
      orderExport: false,
      users: false,
      vlm: false,
      ordersReadOnly: true,
      exportDisabled: true,
      vlmDisabled: true,
    });
  });

  it('parses explicit feature flags', () => {
    expect(
      getBackendFeatureFlags(
        validateEnv({
          BACKEND_ENABLE_AUTH: 'true',
          BACKEND_ENABLE_ORDERS: 'true',
          BACKEND_ORDERS_READ_ONLY: 'false',
        }),
      ),
    ).toMatchObject({
      auth: true,
      orders: true,
      ordersReadOnly: false,
    });
  });
});
