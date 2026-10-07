import { describe, it, expect } from 'vitest';
import { buildBatchLinkRoleDeniedEvent } from './group-batch-link-audit';

describe('buildBatchLinkRoleDeniedEvent', () => {
  it('builds a batch-link denial event naming the required permission', () => {
    const e = buildBatchLinkRoleDeniedEvent({
      currentUser: { id: 4, role: 'manager' } as any, requestId: 'req_b',
      groupId: 12
    });
    expect(e).toMatchObject({
      event: 'group_batch_link.role_denied', entityType: 'group', entityId: 12,
      source: 'backend-groups-command', reason: 'role_denied',
      requiredPermissions: ['groups.manage_links', 'groups.batch_link'],
    });
    expect(e.metadata).toBeUndefined();
  });

  it('falls back to string entity id when groupId is null', () => {
    const e = buildBatchLinkRoleDeniedEvent({
      currentUser: { id: 7, role: 'manager' } as any, requestId: 'req_c',
      groupId: null
    });
    expect(e.entityId).toBe('group_batch_link');
  });

  it('includes actorUserId, actorRole, requestId', () => {
    const e = buildBatchLinkRoleDeniedEvent({
      currentUser: { id: 9, role: 'director', username: 'zorgo' } as any,
      requestId: 'req_d', groupId: '42'
    });
    expect(e.actorUserId).toBe(9);
    expect(e.actorRole).toBe('director');
    expect(e.requestId).toBe('req_d');
    expect(e.actorUsername).toBe('zorgo');
  });
});
