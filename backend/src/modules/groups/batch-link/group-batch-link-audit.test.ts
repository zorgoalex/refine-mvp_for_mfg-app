import { describe, it, expect } from 'vitest';
import { buildBatchLinkRoleDeniedEvent } from './group-batch-link-audit';

describe('buildBatchLinkRoleDeniedEvent', () => {
  it('builds a role-denied batch-link event with allowedRoles', () => {
    const e = buildBatchLinkRoleDeniedEvent({
      currentUser: { id: 4, role: 'manager' } as any, requestId: 'req_b',
      groupId: 12, allowedRoles: ['admin', 'top_manager'],
    });
    expect(e).toMatchObject({
      event: 'group_batch_link.role_denied', entityType: 'group', entityId: 12,
      source: 'backend-groups-command', reason: 'role_denied',
      metadata: { allowedRoles: ['admin', 'top_manager'] },
    });
  });

  it('falls back to string entity id when groupId is null', () => {
    const e = buildBatchLinkRoleDeniedEvent({
      currentUser: { id: 7, role: 'manager' } as any, requestId: 'req_c',
      groupId: null, allowedRoles: ['admin'],
    });
    expect(e.entityId).toBe('group_batch_link');
  });

  it('includes actorUserId, actorRole, requestId', () => {
    const e = buildBatchLinkRoleDeniedEvent({
      currentUser: { id: 9, role: 'director', username: 'zorgo' } as any,
      requestId: 'req_d', groupId: '42', allowedRoles: ['admin', 'top_manager'],
    });
    expect(e.actorUserId).toBe(9);
    expect(e.actorRole).toBe('director');
    expect(e.requestId).toBe('req_d');
    expect(e.actorUsername).toBe('zorgo');
  });
});
