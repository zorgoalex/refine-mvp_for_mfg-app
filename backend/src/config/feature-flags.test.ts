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
      deadlines: false,
      ordersReadOnly: true,
      exportDisabled: true,
      vlmDisabled: true,
      deadlinesReadOnly: true,
      deadlineWorker: false,
      deadlineActions: false,
      deadlineNotifications: false,
    });
  });

  it('parses explicit feature flags', () => {
    expect(
      getBackendFeatureFlags(
        validateEnv({
          BACKEND_ENABLE_AUTH: 'true',
          BACKEND_ENABLE_ORDERS: 'true',
          BACKEND_ORDERS_READ_ONLY: 'false',
          BACKEND_ENABLE_DEADLINES: 'true',
          BACKEND_DEADLINES_READ_ONLY: 'false',
          BACKEND_ENABLE_DEADLINE_WORKER: 'true',
          BACKEND_DEADLINE_ACTIONS_ENABLED: 'true',
          BACKEND_DEADLINE_NOTIFICATIONS_ENABLED: 'true',
        }),
      ),
    ).toMatchObject({
      auth: true,
      orders: true,
      ordersReadOnly: false,
      deadlines: true,
      deadlinesReadOnly: false,
      deadlineWorker: true,
      deadlineActions: true,
      deadlineNotifications: true,
    });
  });
});
