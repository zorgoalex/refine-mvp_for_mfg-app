import { describe, expect, it } from 'vitest';
import { getPermissionsForRole, type UserRole } from '../../../permissions/permissions';
import { bitrix24RequestScope } from './bitrix24-request-scope';

describe('Bitrix24 request scope by permissions (access groups 0A.3)', () => {
  const scopeOf = (role: UserRole) => {
    try {
      return bitrix24RequestScope({ id: '7', permissions: getPermissionsForRole(role) }).mode;
    } catch (error) {
      return (error as { statusCode?: number }).statusCode;
    }
  };

  it('keeps the former role-name behaviour for every role of the static matrix', () => {
    expect(Object.fromEntries((['superadmin', 'admin', 'top_manager', 'manager', 'operator', 'worker', 'packer', 'viewer', 'onec_operator'] as const)
      .map((role) => [role, scopeOf(role)]))).toEqual({
      superadmin: 'all', admin: 'all', top_manager: 'all', manager: 'assigned', operator: 'assigned',
      worker: 403, packer: 403, viewer: 403, onec_operator: 403,
    });
  });

  it('all wins over assigned; assigned carries the user id', () => {
    expect(bitrix24RequestScope({ id: '7', permissions: ['bitrix24.requests.view_assigned', 'bitrix24.requests.view_all'] })).toEqual({ mode: 'all' });
    expect(bitrix24RequestScope({ id: '7', permissions: ['bitrix24.requests.view_assigned'] })).toEqual({ mode: 'assigned', userId: 7 });
  });
});
