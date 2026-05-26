import { describe, expect, it } from 'vitest';
import { canUseBackendProjects } from './projectAccess';

describe('project frontend access', () => {
  it('requires the backend projects flag before enabling route and resource wiring', () => {
    expect(
      canUseBackendProjects(
        { useBackendProjects: false, useBackendPermissions: false },
        { permissions: ['projects.view'] },
      ),
    ).toBe(false);
  });

  it('requires projects.view when backend permissions are enforced', () => {
    expect(
      canUseBackendProjects(
        { useBackendProjects: true, useBackendPermissions: true },
        { permissions: ['orders.view'] },
      ),
    ).toBe(false);
    expect(
      canUseBackendProjects(
        { useBackendProjects: true, useBackendPermissions: true },
        { permissions: ['projects.view'] },
      ),
    ).toBe(true);
  });

  it('keeps legacy permission behavior when backend permissions are disabled', () => {
    expect(
      canUseBackendProjects(
        { useBackendProjects: true, useBackendPermissions: false },
        null,
      ),
    ).toBe(true);
  });
});
