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
