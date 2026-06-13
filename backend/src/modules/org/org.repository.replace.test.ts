import { describe, expect, it } from 'vitest';
import { computeIdDelta, buildHeadAuditEvents } from './org.repository';

describe('replace delta + head audit', () => {
  it('computes added and removed id sets', () => {
    expect(computeIdDelta([1, 2, 3], [2, 3, 4])).toEqual({ added: [4], removed: [1] });
  });

  it('emits one ORG_DIRECTION_HEAD_ADDED/REMOVED row per user with related_user_id', () => {
    const events = buildHeadAuditEvents({
      scope: 'direction',
      entityId: 9,
      currentUser: { id: '3', username: 'a', role: 'admin', permissions: [] } as any,
      requestId: 'r1',
      idempotencyKey: 'k1',
      added: [10],
      removed: [11],
    });
    expect(events).toHaveLength(2);
    const added = events.find((e) => e.event === 'ORG_DIRECTION_HEAD_ADDED')!;
    expect(added.entityType).toBe('direction');
    expect(added.entityId).toBe(9);
    expect(added.relatedUserId).toBe(10);
    expect(added.source).toBe('org-management');
    const removed = events.find((e) => e.event === 'ORG_DIRECTION_HEAD_REMOVED')!;
    expect(removed.relatedUserId).toBe(11);
  });

  it('uses workshop event names + entityType for workshop scope', () => {
    const [ev] = buildHeadAuditEvents({
      scope: 'workshop',
      entityId: 2,
      currentUser: { id: '3', username: 'a', role: 'admin', permissions: [] } as any,
      requestId: 'r1',
      idempotencyKey: 'k1',
      added: [10],
      removed: [],
    });
    expect(ev.event).toBe('ORG_WORKSHOP_HEAD_ADDED');
    expect(ev.entityType).toBe('workshop');
  });
});
