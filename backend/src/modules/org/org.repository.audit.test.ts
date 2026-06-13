import { describe, expect, it } from 'vitest';
import { buildDirectionAuditEvent } from './org.repository';

describe('direction audit events', () => {
  it('emits ORG_DIRECTION_CREATED with before/after and source', () => {
    const ev = buildDirectionAuditEvent('ORG_DIRECTION_CREATED', {
      directionId: 7,
      currentUser: { id: '3', username: 'admin', role: 'admin', permissions: [] } as any,
      requestId: 'req-1',
      before: null,
      after: { directionName: 'Покраска', description: null, isActive: true },
    });
    expect(ev.event).toBe('ORG_DIRECTION_CREATED');
    expect(ev.entityType).toBe('direction');
    expect(ev.entityId).toBe(7);
    expect(ev.source).toBe('org-management');
    expect(ev.actorUserId).toBe('3');
    expect(ev.after).toEqual({ directionName: 'Покраска', description: null, isActive: true });
  });

  it('falls back to the source as requestId when none is provided', () => {
    const ev = buildDirectionAuditEvent('ORG_DIRECTION_DELETED', {
      directionId: 9,
      currentUser: { id: '3', username: 'admin', role: 'admin', permissions: [] } as any,
      before: { directionName: 'X', isActive: true },
      after: null,
    });
    expect(ev.requestId).toBe('org-management');
  });
});
