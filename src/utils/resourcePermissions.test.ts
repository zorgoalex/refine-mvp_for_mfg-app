import { afterEach, describe, expect, it } from 'vitest';
import { applyFeatureFlags, featureFlags } from '../config/featureFlags';
import { canQueryUsersResource } from './resourcePermissions';

describe('resourcePermissions', () => {
  const originalFlags = { ...featureFlags };

  afterEach(() => {
    applyFeatureFlags(originalFlags);
  });

  it('allows users resource queries when backend permissions are not enforced', () => {
    applyFeatureFlags({ ...featureFlags, useBackendPermissions: false });

    expect(canQueryUsersResource({ permissions: [] })).toBe(true);
    expect(canQueryUsersResource(null)).toBe(true);
  });

  it('requires users.view when backend permissions are enforced', () => {
    applyFeatureFlags({ ...featureFlags, useBackendPermissions: true });

    expect(canQueryUsersResource({ permissions: ['orders.view'] })).toBe(false);
    expect(canQueryUsersResource({ permissions: ['users.view'] })).toBe(true);
  });
});
