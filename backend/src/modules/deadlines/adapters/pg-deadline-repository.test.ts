import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import { PgDeadlineRepository } from './pg-deadline-repository';

describe('PgDeadlineRepository', () => {
  it('lists deadlines with whitelisted sort, filters and pagination', async () => {
    const database = createDatabase();
    const repository = new PgDeadlineRepository(database.client);

    await expect(
      repository.listDeadlines({
        currentUser: currentUser(),
        query: {
          page: 2,
          pageSize: 10,
          sortBy: 'deadlineAt',
          sortOrder: 'asc',
          entityType: 'order',
          orderId: 100,
          status: 'active',
          onlyOverdue: true,
        },
      }),
    ).resolves.toMatchObject({
      data: [{ deadlineId: '11111111-1111-4111-8111-111111111111', orderId: 100 }],
      total: 1,
    });

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).toContain('d.entity_type = $1');
    expect(sql).toContain('d.order_id = $2');
    expect(sql).toContain("d.status = $3");
    expect(sql).toContain("d.status = 'expired' OR (d.status = 'active' AND d.deadline_at < now())");
    expect(sql).toContain('ORDER BY d.deadline_at ASC');
  });

  it('creates manual deadlines with lifecycle event, audit and outbox rows', async () => {
    const database = createDatabase();
    const repository = new PgDeadlineRepository(database.client);

    await expect(
      repository.createDeadlineInstance({
        currentUser: currentUser(),
        dto: {
          entityType: 'order',
          entityId: '100',
          orderId: 100,
          deadlineAt: '2026-05-02T10:00:00.000Z',
          source: 'manual',
          metadata: { label: 'Manual' },
        },
      }),
    ).resolves.toMatchObject({
      deadlineId: '11111111-1111-4111-8111-111111111111',
      source: 'manual',
    });

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).toContain('INSERT INTO deadline_instances');
    expect(sql).toContain('INSERT INTO deadline_events');
    expect(sql).toContain('INSERT INTO audit_log');
    expect(sql).toContain('INSERT INTO outbox_events');
  });

  it('uses row locks for due deadline worker scans and idempotent action executions', async () => {
    const database = createDatabase();
    const repository = new PgDeadlineRepository(database.client);

    await repository.findDueDeadlinesForUpdate({
      now: '2026-05-02T10:00:00.000Z',
      limit: 5,
      workerId: 'worker-1',
    });
    await repository.createActionExecution({
      deadlineEventId: '22222222-2222-4222-8222-222222222222',
      actionRuleId: null,
      actionType: 'write_audit',
      targetType: 'order',
      targetId: '100',
      status: 'executed',
      idempotencyKey: 'event:write_audit:order:100',
      executedAt: '2026-05-02T10:00:00.000Z',
    });

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('ON CONFLICT (idempotency_key)');
  });
});

function createDatabase() {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  const client = {
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });

      if (text.includes('COUNT(*)::int')) {
        return { rows: [{ total: 1 }] };
      }

      if (text.includes('RETURNING') && text.includes('deadline_events')) {
        return { rows: [eventRow()] };
      }

      if (text.includes('RETURNING') && text.includes('deadline_action_executions')) {
        return { rows: [executionRow()] };
      }

      if (text.includes('FROM deadline_instances') || text.includes('RETURNING')) {
        return { rows: [deadlineRow()] };
      }

      return { rows: [] };
    },
  } as unknown as DatabaseClient;

  return { client, queries };
}

function deadlineRow() {
  return {
    deadline_id: '11111111-1111-4111-8111-111111111111',
    policy_id: null,
    policy_version_id: null,
    entity_type: 'order',
    entity_id: '100',
    parent_entity_type: null,
    parent_entity_id: null,
    order_id: 100,
    order_workshop_id: null,
    client_id: 5,
    responsible_user_id: 42,
    deadline_at: new Date('2026-05-02T10:00:00.000Z'),
    status: 'active',
    source: 'manual',
    is_manually_overridden: false,
    policy_snapshot_json: null,
    metadata_json: { label: 'Manual' },
    started_at: null,
    completed_at: null,
    expired_at: null,
    cancelled_at: null,
    created_at: new Date('2026-05-01T10:00:00.000Z'),
    updated_at: new Date('2026-05-01T10:00:00.000Z'),
  };
}

function eventRow() {
  return {
    deadline_event_id: '22222222-2222-4222-8222-222222222222',
    deadline_id: '11111111-1111-4111-8111-111111111111',
    event_type: 'DEADLINE_CREATED',
    severity: 'info',
    entity_type: 'order',
    entity_id: '100',
    order_id: 100,
    order_workshop_id: null,
    client_id: 5,
    deadline_at: new Date('2026-05-02T10:00:00.000Z'),
    event_at: new Date('2026-05-01T10:00:00.000Z'),
    delay_minutes: null,
    payload_json: {},
    created_at: new Date('2026-05-01T10:00:00.000Z'),
  };
}

function executionRow() {
  return {
    action_execution_id: '33333333-3333-4333-8333-333333333333',
    deadline_event_id: '22222222-2222-4222-8222-222222222222',
    action_rule_id: null,
    action_type: 'write_audit',
    target_type: 'order',
    target_id: '100',
    status: 'executed',
    idempotency_key: 'event:write_audit:order:100',
    skip_reason: null,
    error_code: null,
    error_message: null,
    result_json: {},
    executed_at: new Date('2026-05-02T10:00:00.000Z'),
    created_at: new Date('2026-05-02T10:00:00.000Z'),
  };
}

function currentUser() {
  return {
    id: '42',
    username: 'admin',
    role: 'admin' as const,
    roleId: 1,
    permissions: [],
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}
