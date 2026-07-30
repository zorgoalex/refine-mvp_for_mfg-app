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
      resultArchived: 'cut_job.result_archived',
      resultUnarchived: 'cut_job.result_unarchived',
      currentResultChanged: 'cut_job.current_result_changed',
      calculateFailed: 'cut_job.calculate_failed',
      permissionDenied: 'cut_job.permission_denied',
      nameChanged: 'cut_job.name_changed',
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
        sheetMaterialTypeIds: [9, 9],
        cutGroupIds: [777],
        cutResultIds: [12, 12],
      },
    });

    expect(event.relatedEntities).toEqual(
      expect.arrayContaining([
        { entityType: 'order', entityId: 101 },
        { entityType: 'order', entityId: 102 },
        { entityType: 'sheet_material_type', entityId: 9 },
        { entityType: 'cut_group', entityId: 777 },
        { entityType: 'cut_result', entityId: 12 },
      ]),
    );
    // de-duplicated: order 101 once, sheet_material_type 9 once
    expect(event.relatedEntities).toHaveLength(5);
  });

  it('Variant B audit: emits sheet_material_type related entity and ZERO material entities', () => {
    const event = buildCutAuditEvent({
      event: CUT_AUDIT_EVENTS.calculated,
      cutJobId: 10,
      actor,
      requestId: 'req_vb',
      source: 'manual',
      related: {
        orderIds: [200],
        sheetMaterialTypeIds: [3, 3, 5],
      },
    });

    const materialEntities = event.relatedEntities.filter((e) => e.entityType === 'material');
    expect(materialEntities).toHaveLength(0);

    const smtEntities = event.relatedEntities.filter((e) => e.entityType === 'sheet_material_type');
    expect(smtEntities).toHaveLength(2); // de-duplicated 3,3,5 → 3,5
    expect(smtEntities).toEqual(
      expect.arrayContaining([
        { entityType: 'sheet_material_type', entityId: 3 },
        { entityType: 'sheet_material_type', entityId: 5 },
      ]),
    );
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

  it('buildCutDeniedEvent enriches denied event with cut_group and order relatedEntities bridge rows', () => {
    const denied = buildCutDeniedEvent({
      cutJobId: 10,
      actor,
      requestId: 'req-denied-bridge',
      source: 'manual',
      reason: 'missing cut.manage',
      requiredPermissions: ['cut.manage'],
      related: { orderIds: [7], cutGroupIds: [42] },
    });

    expect(denied.event).toBe(CUT_AUDIT_EVENTS.permissionDenied);
    expect(denied.relatedEntities).toEqual(
      expect.arrayContaining([
        { entityType: 'order', entityId: 7 },
        { entityType: 'cut_group', entityId: 42 },
      ]),
    );
    expect(denied.relatedEntities).toHaveLength(2);
  });
});
