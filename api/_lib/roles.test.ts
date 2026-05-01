import { describe, expect, it } from 'vitest';
import { getAllowedRoles, mapRoleIdToSystemRole } from './roles';

describe('legacy API role mapping', () => {
  it('maps role_id=2 to superadmin', () => {
    expect(mapRoleIdToSystemRole(2)).toBe('superadmin');
  });

  it('grants superadmin the full legacy Hasura role hierarchy', () => {
    expect(getAllowedRoles('superadmin')).toEqual([
      'superadmin',
      'admin',
      'top_manager',
      'manager',
      'operator',
      'worker',
      'viewer',
    ]);
  });

  it('does not grant admin the superadmin role', () => {
    expect(getAllowedRoles('admin')).not.toContain('superadmin');
  });
});
