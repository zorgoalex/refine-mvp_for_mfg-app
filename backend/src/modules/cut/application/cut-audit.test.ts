import { describe, expect, it } from 'vitest';
import {
  CUT_AUDIT_EVENTS,
  buildCutAuditEvent,
  buildCutDeniedEvent,
} from './cut-audit';

const actor = { id: 7, username: 'operator-1', role: 'operator' };

describe('cut audit contract (§11)', () => {
  it('exposes the full cut event set', () => {
    expect(CUT_AUDIT_EVENTS).toMatchObject({
      created: 'cut_job.created',
      itemAdded: 'cut_job.item_added',
      itemRemoved: 'cut_job.item_removed',
      calculated: 'cut_job.calculated',
      archived: 'cut_job.archived',
      calculateFailed: 'cut_job.calculate_failed',
      permissionDenied: 'cut_job.permission_denied',
    });
  });

  it('writes cut_job as the primary entity with the originating request id', () => {
    const event = buildCutAuditEvent({
      event: CUT_AUDIT_EVENTS.created,
      cutJobId: 42,
      actor,
      requestId: 'req_abc',
      source: 'manual',
    });

    expect(event.entityType).toBe('cut_job');
    expect(event.entityId).toBe(42);
    expect(event.actorUserId).toBe(7);
    expect(event.actorUsername).toBe('operator-1');
    expect(event.actorRole).toBe('operator');
    expect(event.requestId).toBe('req_abc');
    expect(event.source).toBe('manual');
  });

  it('normalizes related dimensions into typed, de-duplicated bridge rows', () => {
    const event = buildCutAuditEvent({
      event: CUT_AUDIT_EVENTS.calculated,
      cutJobId: 42,
      actor,
      requestId: 'req_abc',
      source: 'manual',
      related: {
        orderIds: [101, 101, 102],
        materialIds: [5],
        sheetMaterialTypeIds: [9, 9],
        cutGroupIds: [777],
      },
    });

    expect(event.relatedEntities).toEqual(
      expect.arrayContaining([
        { entityType: 'order', entityId: 101 },
        { entityType: 'order', entityId: 102 },
        { entityType: 'material', entityId: 5 },
        { entityType: 'sheet_material_type', entityId: 9 },
        { entityType: 'cut_group', entityId: 777 },
      ]),
    );
    // de-duplicated: order 101 once, sheet_material_type 9 once
    expect(event.relatedEntities).toHaveLength(5);
  });

  it('keeps the first affected order in relatedOrderId for the legacy column', () => {
    const event = buildCutAuditEvent({
      event: CUT_AUDIT_EVENTS.itemAdded,
      cutJobId: 42,
      actor,
      requestId: 'req_abc',
      source: 'manual',
      related: { orderIds: [101, 102] },
    });

    expect(event.relatedOrderId).toBe(101);
  });

  it('builds a permission-denied event carrying the required permission', () => {
    const denied = buildCutDeniedEvent({
      cutJobId: 42,
      actor,
      requestId: 'req_abc',
      source: 'manual',
      reason: 'missing cut.manage',
      requiredPermissions: ['cut.manage'],
    });

    expect(denied.event).toBe('cut_job.permission_denied');
    expect(denied.entityType).toBe('cut_job');
    expect(denied.requiredPermissions).toEqual(['cut.manage']);
    expect(denied.reason).toBe('missing cut.manage');
  });
});
