import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../database/database.types';
import { AuditService } from './audit.service';

interface Captured {
  text: string;
  params: readonly unknown[];
}

function fakeClient(captured: Captured[], auditId = 'aud-1'): DatabaseClient {
  return {
    async query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<T>> {
      captured.push({ text, params: [...params] });
      return {
        rows: [{ audit_id: auditId } as unknown as T],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      };
    },
  };
}

describe('AuditService.record', () => {
  it('inserts a fully-dimensioned audit row and returns the audit id', async () => {
    const captured: Captured[] = [];
    const service = new AuditService();

    const id = await service.record(fakeClient(captured), {
      event: 'payments.create',
      entityType: 'payment',
      entityId: 42,
      actorUserId: '7',
      actorUsername: 'manager1',
      actorRole: 'manager',
      requestId: 'req_abc',
      source: 'backend-payments-command',
      relatedOrderId: 1001,
      relatedPaymentId: 42,
      after: { amount: 100 },
      metadata: { previousOrderId: null },
    });

    expect(id).toBe('aud-1');
    expect(captured).toHaveLength(1);
    const { text, params } = captured[0];
    expect(text).toMatch(/INSERT INTO audit_log/i);
    expect(text).toMatch(/related_payment_id/i);
    expect(text).toMatch(/related_deadline_id/i);
    expect(text).not.toMatch(/\baction\b/);
    expect(params.slice(0, 3)).toEqual(['payments.create', 'payment', '42']);
    expect(params).toContain('manager1');
    expect(params).toContain('backend-payments-command');
    expect(params).toContain(1001);
    expect(params).toContain(42);
  });

  it('redacts sensitive fields in before/after/diff/metadata JSON', async () => {
    const captured: Captured[] = [];
    const service = new AuditService();

    await service.record(fakeClient(captured), {
      event: 'users.change_password',
      entityType: 'user',
      entityId: 9,
      actorUserId: '1',
      requestId: 'req_x',
      source: 'backend-users-command',
      after: { username: 'bob', password: 'secret-pw', token: 'abc.def.ghi' },
    });

    const serialized = captured[0].params.map(String).join('|');
    expect(serialized).not.toContain('secret-pw');
    expect(serialized).not.toContain('abc.def.ghi');
    expect(serialized).toContain('bob');
  });

  it('defaults absent dimensions to null', async () => {
    const captured: Captured[] = [];
    const service = new AuditService();
    await service.record(fakeClient(captured), {
      event: 'users.create',
      entityType: 'user',
      entityId: 5,
      requestId: 'req_y',
      source: 'backend-users-command',
    });
    const { params } = captured[0];
    expect(params).toContain(null);
  });
});

describe('AuditService related_user_id dimension', () => {
  it('binds relatedUserId into the insert parameters', async () => {
    const captured: Captured[] = [];
    await new AuditService().record(fakeClient(captured), {
      event: 'ORG_WORKSHOP_HEAD_ADDED',
      entityType: 'workshop',
      entityId: 5,
      requestId: 'req-1',
      source: 'org-management',
      relatedUserId: 42,
    });
    const { text, params } = captured[0];
    expect(text).toMatch(/related_user_id/);
    expect(params).toContain(42);
  });

  it('defaults relatedUserId to null when omitted', async () => {
    const captured: Captured[] = [];
    await new AuditService().record(fakeClient(captured), {
      event: 'ORG_DIRECTION_CREATED',
      entityType: 'direction',
      entityId: 1,
      requestId: 'req-2',
      source: 'org-management',
    });
    const { params } = captured[0];
    // related_user_id must be present as a bind value (null), not undefined
    expect(params).toContain(null);
  });
});

describe('AuditService relatedEntities bridge writes', () => {
  const baseEvent = {
    event: 'order.update',
    entityType: 'order',
    entityId: 10,
    requestId: 'req-bridge',
    source: 'backend-orders-command',
  };

  it('fan-writes deduplicated bridge rows after the parent INSERT', async () => {
    const captured: Captured[] = [];
    const service = new AuditService();

    await service.record(fakeClient(captured), {
      ...baseEvent,
      relatedEntities: [
        { entityType: 'user', entityId: 7 },
        { entityType: 'user', entityId: 7 },       // duplicate — must be skipped
        { entityType: 'employee', entityId: 3 },
      ],
    });

    // First captured query is the audit_log INSERT
    expect(captured[0].text).toMatch(/INSERT INTO audit_log/i);

    // Exactly 2 bridge queries after dedup
    const bridge = captured.filter(q =>
      q.text.includes('INSERT INTO audit_log_related_entity'),
    );
    expect(bridge).toHaveLength(2);
    expect(bridge[0].params).toEqual(['aud-1', 'user', 7]);
    expect(bridge[1].params).toEqual(['aud-1', 'employee', 3]);
  });

  it('skips entities with non-finite entityId (NaN, Infinity)', async () => {
    const captured: Captured[] = [];
    await new AuditService().record(fakeClient(captured), {
      ...baseEvent,
      relatedEntities: [
        { entityType: 'order', entityId: NaN },
        { entityType: 'order', entityId: Infinity },
        { entityType: 'order', entityId: 5 },
      ],
    });

    const bridge = captured.filter(q =>
      q.text.includes('INSERT INTO audit_log_related_entity'),
    );
    expect(bridge).toHaveLength(1);
    expect(bridge[0].params).toEqual(['aud-1', 'order', 5]);
  });

  it('writes no bridge rows when relatedEntities is empty', async () => {
    const captured: Captured[] = [];
    await new AuditService().record(fakeClient(captured), {
      ...baseEvent,
      relatedEntities: [],
    });

    const bridge = captured.filter(q =>
      q.text.includes('INSERT INTO audit_log_related_entity'),
    );
    expect(bridge).toHaveLength(0);
  });

  it('writes no bridge rows when relatedEntities is absent', async () => {
    const captured: Captured[] = [];
    await new AuditService().record(fakeClient(captured), { ...baseEvent });

    const bridge = captured.filter(q =>
      q.text.includes('INSERT INTO audit_log_related_entity'),
    );
    expect(bridge).toHaveLength(0);
  });
});

describe('AuditService.recordDenied', () => {
  it('writes a denied audit row with denied metadata', async () => {
    const captured: Captured[] = [];
    const service = new AuditService();
    const id = await service.recordDenied(fakeClient(captured, 'aud-denied'), {
      event: 'production.action_denied',
      entityType: 'order',
      entityId: 1001,
      actorUserId: '7',
      requestId: 'req_d',
      source: 'backend-production-command',
      relatedOrderId: 1001,
      relatedClientId: 55,
      reason: 'order_scope_denied',
      requiredPermissions: ['production.change_status'],
    });
    expect(id).toBe('aud-denied');
    const serialized = captured[0].params.map(String).join('|');
    expect(serialized).toContain('order_scope_denied');
    expect(serialized).toContain('production.change_status');
    expect(serialized.toLowerCase()).toContain('denied');
  });
});
