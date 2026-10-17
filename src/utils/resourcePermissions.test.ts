import { afterEach, describe, expect, it } from 'vitest';
import { applyFeatureFlags, featureFlags } from '../config/featureFlags';
import {
  canMutateHasuraResource,
  canQuickCreateReference,
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

  it('checks the permission Hasura requires for a direct write before sending it (access groups 0Б)', () => {
    applyFeatureFlags({ ...featureFlags, useBackendAuth: true, useBackendPermissions: true });
    const manager = { role: 'manager', permissions: ['references.view', 'references.quick_create', 'clients.create'] };
    const topManager = { role: 'top_manager', permissions: ['references.view', 'references.manage'] };

    expect(canMutateHasuraResource('edge_types', manager, 'insert')).toBe(true);
    expect(canMutateHasuraResource('edge_types', manager, 'update')).toBe(false);
    expect(canMutateHasuraResource('edge_types', manager, 'delete')).toBe(false);
    expect(canMutateHasuraResource('film_types', manager, 'insert')).toBe(false);
    expect(canMutateHasuraResource('clients', manager, 'insert')).toBe(true);
    expect(canMutateHasuraResource('clients', manager, 'delete')).toBe(false);
    expect(canMutateHasuraResource('app_settings', topManager, 'update')).toBe(false);
    expect(canMutateHasuraResource('edge_types', topManager, 'update')).toBe(true);
    // A resource without a write rule keeps the previous behaviour.
    expect(canMutateHasuraResource('unknown_resource', manager, 'update')).toBe(true);
  });

  it('shows the quick add of references with references.manage or references.quick_create', () => {
    applyFeatureFlags({ ...featureFlags, useBackendPermissions: true });

    expect(canQuickCreateReference({ permissions: ['references.quick_create'] })).toBe(true);
    expect(canQuickCreateReference({ permissions: ['references.manage'] })).toBe(true);
    expect(canQuickCreateReference({ permissions: ['references.view'] })).toBe(false);
    applyFeatureFlags({ ...featureFlags, useBackendPermissions: false });
    expect(canQuickCreateReference({ permissions: [] })).toBe(true);
  });

  it('blocks direct packer Hasura mutations even on readable resources', () => {
    applyFeatureFlags({ ...featureFlags, useBackendAuth: true, useBackendPermissions: true });

    expect(canMutateHasuraResource('order_statuses', { roleId: 30, permissions: ['orders.view'] })).toBe(false);
  });
});
