import { afterEach, describe, expect, it } from 'vitest';
import { applyFeatureFlags, featureFlags } from '../config/featureFlags';
import { canQueryAppSettingsResource, canQueryUsersResource } from './resourcePermissions';

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

  it('allows app_settings Hasura queries only for roles with metadata select permission', () => {
    applyFeatureFlags({ ...featureFlags, useBackendPermissions: true });

    expect(canQueryAppSettingsResource({ role: 'superadmin', permissions: [] })).toBe(true);
    expect(canQueryAppSettingsResource({ role: 'top_manager', permissions: [] })).toBe(true);
    expect(canQueryAppSettingsResource({ role: 'manager', permissions: [] })).toBe(true);
    expect(canQueryAppSettingsResource({ role: 'packer', permissions: ['orders.view'] })).toBe(false);
    expect(canQueryAppSettingsResource({ roleId: 30, permissions: ['orders.view'] })).toBe(false);
    expect(canQueryAppSettingsResource(null)).toBe(false);
  });
});
