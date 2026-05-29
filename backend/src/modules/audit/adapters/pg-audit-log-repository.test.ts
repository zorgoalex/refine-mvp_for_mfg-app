import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import { PgAuditLogRepository } from './pg-audit-log-repository';

function db(results: Array<{ rows: QueryResultRow[] }>): { client: DatabaseClient; calls: Array<{ text: string; params: readonly unknown[] }> } {
  const calls: Array<{ text: string; params: readonly unknown[] }> = [];
  const queue = [...results];
  const client: DatabaseClient = {
    async query<T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
      calls.push({ text, params: [...params] });
      const next = queue.shift() ?? { rows: [] };
      return { rows: next.rows as T[], rowCount: next.rows.length, command: 'SELECT', oid: 0, fields: [] };
    },
  };
  return { client, calls };
}

describe('PgAuditLogRepository.list', () => {
  it('builds a parameterized WHERE from filters and paginates', async () => {
    const { client, calls } = db([
      { rows: [{ total: 3 }] },
      { rows: [{
        audit_id: 'a1', event: 'payments.create', entity_type: 'payment', entity_id: '42',
        user_id: 7, username: 'm1', role: 'manager', source: 'backend-payments-command',
        related_order_id: 1001, related_client_id: null, related_payment_id: 42,
        related_deadline_id: null, related_production_event_id: null,
        status_field: null, status_id: null, status_name: null, status_code: null, stage_code: null,
        request_id: 'req1', ip_address: null, user_agent: null,
        before_json: null, after_json: { amount: 100 }, diff_json: null, metadata_json: { previousOrderId: null },
        created_at: '2026-05-29T10:00:00.000Z',
      }] },
    ]);
    const repo = new PgAuditLogRepository(client);
    const res = await repo.list({ currentUser: undefined, filters: { relatedOrderId: 1001, event: 'payments.create' }, page: 1, pageSize: 50, requestId: 'rq' });
    expect(calls).toHaveLength(2);
    expect(calls[0].text).toMatch(/COUNT\(\*\)/i);
    expect(calls[0].text).toMatch(/related_order_id = \$/);
    expect(calls[0].text).toMatch(/event = \$/);
    expect(calls[0].params).toContain(1001);
    expect(calls[0].params).toContain('payments.create');
    expect(calls[1].text).toMatch(/ORDER BY created_at DESC/i);
    expect(calls[1].text).toMatch(/LIMIT \$\d+ OFFSET \$\d+/i);
    expect(res.pagination).toEqual({ page: 1, pageSize: 50, total: 3, totalPages: 1 });
    expect(res.data[0]).toMatchObject({ auditId: 'a1', event: 'payments.create', relatedOrderId: 1001, relatedPaymentId: 42 });
  });

  it('redacts sensitive keys in JSON columns on read', async () => {
    const { client } = db([
      { rows: [{ total: 1 }] },
      { rows: [{
        audit_id: 'a2', event: 'users.create', entity_type: 'user', entity_id: '9',
        user_id: 1, username: 'admin', role: 'admin', source: 'backend-users-command',
        related_order_id: null, related_client_id: null, related_payment_id: null,
        related_deadline_id: null, related_production_event_id: null,
        status_field: null, status_id: null, status_name: null, status_code: null, stage_code: null,
        request_id: 'req2', ip_address: null, user_agent: null,
        before_json: null, after_json: { username: 'bob', password: 'leaked-pw' }, diff_json: null, metadata_json: null,
        created_at: '2026-05-29T10:00:00.000Z',
      }] },
    ]);
    const repo = new PgAuditLogRepository(client);
    const res = await repo.list({ currentUser: undefined, filters: {}, page: 1, pageSize: 50, requestId: 'rq' });
    expect(JSON.stringify(res.data[0].after)).not.toContain('leaked-pw');
    expect(JSON.stringify(res.data[0].after)).toContain('bob');
  });

  it('emits no WHERE when no filters are set and computes offset', async () => {
    const { client, calls } = db([{ rows: [{ total: 0 }] }, { rows: [] }]);
    const repo = new PgAuditLogRepository(client);
    await repo.list({ currentUser: undefined, filters: {}, page: 2, pageSize: 25, requestId: 'rq' });
    expect(calls[0].text).not.toMatch(/WHERE/i);
    expect(calls[1].params).toContain(25); // offset = (2-1)*25
  });
});
