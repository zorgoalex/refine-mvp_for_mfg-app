import { describe, expect, it } from 'vitest';
import { buildUserDeniedEvent, USERS_AUDIT_SOURCE, USER_PERMISSION_DENIED } from './users-audit';
import type { CurrentUser } from '../../../permissions/current-user';

function actor(id: string): CurrentUser {
  return { id, username: 'testuser', role: 'admin', roleId: 1, permissions: [] };
}

describe('buildUserDeniedEvent', () => {
  it('maps numeric string targetUserId to relatedUserId', () => {
    const event = buildUserDeniedEvent({
      actor: actor('5'),
      requestId: 'req-1',
      action: 'update',
      targetUserId: '42',
      reason: 'role_hierarchy_denied',
    });
    expect(event.event).toBe(USER_PERMISSION_DENIED);
    expect(event.entityType).toBe('user');
    expect(event.entityId).toBe('42');
    expect(event.relatedUserId).toBe(42);
    expect(event.actorUserId).toBe('5');
    expect(event.source).toBe(USERS_AUDIT_SOURCE);
    expect(event.reason).toBe('role_hierarchy_denied');
    expect(event.requiredPermissions).toEqual(['users.update']);
  });

  it('uses "users" as entityId when targetUserId is null', () => {
    const event = buildUserDeniedEvent({
      actor: actor('1'),
      requestId: 'req-2',
      action: 'create',
      targetUserId: null,
      reason: 'role_assignment_denied',
    });
    expect(event.entityId).toBe('users');
    expect(event.relatedUserId).toBeNull();
  });

  it('guards non-finite targetUserId', () => {
    const event = buildUserDeniedEvent({
      actor: actor('1'),
      requestId: 'req-3',
      action: 'activate',
      targetUserId: 'not-a-number',
      reason: 'role_hierarchy_denied',
    });
    expect(event.relatedUserId).toBeNull();
  });
});
