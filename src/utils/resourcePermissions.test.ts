import { afterEach, describe, expect, it } from 'vitest';
import { applyFeatureFlags, featureFlags } from '../config/featureFlags';
import {
  canMutateHasuraResource,
  canQueryAppSettingsResource,
  canQueryHasuraResource,
  canQueryUsersResource,
} from './resourcePermissions';

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

  it('allows authenticated roles to read their navigation visibility setting', () => {
    applyFeatureFlags({ ...featureFlags, useBackendPermissions: true });

    expect(canQueryAppSettingsResource({ role: 'superadmin', permissions: [] })).toBe(true);
    expect(canQueryAppSettingsResource({
      role: 'admin',
      permissions: ['settings.view', 'settings.manage'],
    })).toBe(true);
    expect(canQueryAppSettingsResource({ role: 'top_manager', permissions: [] })).toBe(true);
    expect(canQueryAppSettingsResource({ role: 'manager', permissions: [] })).toBe(true);
    expect(canQueryAppSettingsResource({ role: 'operator', permissions: ['orders.view'] })).toBe(true);
    expect(canQueryAppSettingsResource({ role: 'worker', permissions: ['orders.view'] })).toBe(true);
    expect(canQueryAppSettingsResource({ role: 'packer', permissions: ['orders.view'] })).toBe(true);
    expect(canQueryAppSettingsResource({ roleId: 30, permissions: ['orders.view'] })).toBe(true);
    expect(canQueryAppSettingsResource({ role: 'viewer', permissions: ['orders.view'] })).toBe(true);
    expect(canQueryAppSettingsResource(null)).toBe(false);
  });

  it('allows packer visibility reads but blocks anonymous backend sessions before runtime flags apply', () => {
    applyFeatureFlags({ ...featureFlags, useBackendAuth: true, useBackendPermissions: false });

    expect(canQueryAppSettingsResource({ role: 'packer', permissions: ['orders.view'] })).toBe(true);
    expect(canQueryAppSettingsResource(null)).toBe(false);
  });

  it('keeps legacy app_settings behavior before backend auth is enabled', () => {
    applyFeatureFlags({ ...featureFlags, useBackendAuth: false, useBackendPermissions: false });

    expect(canQueryAppSettingsResource(null)).toBe(true);
  });

  it('limits packer Hasura reads to resources granted in metadata', () => {
    applyFeatureFlags({ ...featureFlags, useBackendAuth: true, useBackendPermissions: true });
    const packer = { role: 'packer', permissions: ['orders.view'] };

    expect(canQueryHasuraResource('order_statuses', packer)).toBe(true);
    expect(canQueryHasuraResource('production_statuses', packer)).toBe(true);
    expect(canQueryHasuraResource('production_status_events', packer)).toBe(true);
    expect(canQueryHasuraResource('app_settings', packer)).toBe(true);
    for (const resource of [
      'materials',
      'films',
      'milling_types',
      'edge_types',
      'payment_types',
      'orders_view',
    ]) {
      expect(canQueryHasuraResource(resource, packer), resource).toBe(false);
    }
  });

  it('blocks direct packer Hasura mutations even on readable resources', () => {
    applyFeatureFlags({ ...featureFlags, useBackendAuth: true, useBackendPermissions: true });

    expect(canMutateHasuraResource('order_statuses', { roleId: 30, permissions: ['orders.view'] })).toBe(false);
  });
});
