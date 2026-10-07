import { describe, expect, it } from 'vitest';
import { currentUserFromAuthorization } from './current-user-from-authorization';
import { staticAuthorizationSnapshot } from './testing/static-authorization-snapshot';
import { evaluationUserFromSnapshot, parseAuthorizationSnapshot } from './user-authorization-snapshot';

describe('request user from the authorization snapshot', () => {
  it('carries role, grants, scalar scopes, scope sets and version of the same snapshot', () => {
    const snapshot = staticAuthorizationSnapshot({ userId: 4, username: 'manager', roleId: 10, version: 14 });
    const user = currentUserFromAuthorization(snapshot, { sessionId: 's-1' });
    expect(user).toMatchObject({ id: '4', username: 'manager', role: 'manager', roleId: 10, permissionsVersion: 14, sessionId: 's-1' });
    expect(user.permissions).toBe(snapshot.permissions);
    expect(user.policyScopes).toEqual(snapshot.scopes);
    expect(user.policyScopeSets).toEqual(snapshot.scopeSets);
  });

  it('refuses unknown, inactive and unmapped users', () => {
    expect(() => currentUserFromAuthorization(null, {})).toThrow(expect.objectContaining({ code: 'AUTH_USER_NOT_FOUND' }));
    expect(() => currentUserFromAuthorization(staticAuthorizationSnapshot({ userId: 1, roleId: 10, isActive: false }), {}))
      .toThrow(expect.objectContaining({ code: 'AUTH_USER_INACTIVE' }));
    expect(() => currentUserFromAuthorization(staticAuthorizationSnapshot({ userId: 1, roleId: 31 }), {}))
      .toThrow(expect.objectContaining({ code: 'UNKNOWN_ROLE' }));
    expect(evaluationUserFromSnapshot(staticAuthorizationSnapshot({ userId: 1, roleId: 10, isActive: false }))).toBeNull();
  });

  it('parses the SQL snapshot: sets normalized, scalar derived, version required', () => {
    const parsed = parseAuthorizationSnapshot({
      userId: 4, username: 'm', isActive: true, isServiceAccount: false, roleId: 10, roleCode: 'manager',
      roleIsActive: true, rowVersion: 3, accessGroupsEnabled: false, version: 9,
      permissions: ['orders.view'], scopes: { 'orders.view': ['assigned', 'own'], 'orders.delete': [] },
    });
    expect(parsed.scopeSets.orders.view).toEqual(['own', 'assigned']);
    expect(parsed.scopes.orders.view).toBe('own');
    expect(parsed.scopes.orders.delete).toBe('none');
    expect(parsed.role).toBe('manager');
    expect(() => parseAuthorizationSnapshot({ ...{
      userId: 4, username: 'm', isActive: true, isServiceAccount: false, roleId: 10, roleCode: 'manager',
      roleIsActive: true, rowVersion: 3, accessGroupsEnabled: false, permissions: [], scopes: {},
    }, version: 0 })).toThrow(expect.objectContaining({ code: 'PERMISSIONS_NOT_READY' }));
  });
});
