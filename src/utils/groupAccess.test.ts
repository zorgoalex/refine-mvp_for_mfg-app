import { describe, expect, it } from 'vitest';
import { canViewGroupsPage } from './groupAccess';

describe('group frontend access', () => {
  it('requires the backend groups flag before enabling route and resource wiring', () => {
    expect(
      canViewGroupsPage(
        { useBackendGroups: false, useBackendPermissions: false },
        { permissions: ['groups.view'] },
      ),
    ).toBe(false);
  });

  it('requires groups.view when backend permissions are enforced', () => {
    expect(
      canViewGroupsPage(
        { useBackendGroups: true, useBackendPermissions: true },
        { permissions: ['orders.view'] },
      ),
    ).toBe(false);
    expect(
      canViewGroupsPage(
        { useBackendGroups: true, useBackendPermissions: true },
        { permissions: ['groups.view'] },
      ),
    ).toBe(true);
  });

  it('keeps legacy permission behavior when backend permissions are disabled', () => {
    expect(
      canViewGroupsPage(
        { useBackendGroups: true, useBackendPermissions: false },
        null,
      ),
    ).toBe(true);
  });
});
