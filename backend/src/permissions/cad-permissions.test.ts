import { expect, it } from 'vitest';
import { getPermissionsForRole, USER_ROLES } from './permissions';

it('grants CAD defaults only to admin and superadmin', () => {
  for (const role of USER_ROLES) {
    for (const permission of ['cad.view', 'cad.edit', 'cad.export'] as const) {
      expect(getPermissionsForRole(role).includes(permission), `${role}:${permission}`).toBe(role === 'admin' || role === 'superadmin');
    }
  }
});
