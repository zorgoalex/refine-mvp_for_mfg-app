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

  it('cancels deadlines through a row lock with queryable audit and outbox dimensions', async () => {
    const database = createDatabase();
    const repository = new PgDeadlineRepository(database.client);

    await expect(
      repository.getDeadlineByIdForUpdate('11111111-1111-4111-8111-111111111111'),
    ).resolves.toMatchObject({
      deadlineId: '11111111-1111-4111-8111-111111111111',
    });
    await expect(
      repository.cancelDeadline({
        currentUser: currentUser(),
        deadlineId: '11111111-1111-4111-8111-111111111111',
        requestId: 'req-cancel-1',
        dto: { reason: 'Заказ отменен' },
      }),
    ).resolves.toMatchObject({ deadlineId: '11111111-1111-4111-8111-111111111111' });

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toContain(
      "WHERE deadline_id = $1 AND status NOT IN ('expired', 'completed_on_time', 'completed_late', 'cancelled', 'superseded')",
    );
    expect(sql).toContain('INSERT INTO deadline_events');
    expect(sql).toContain('INSERT INTO audit_log');
    expect(sql).toContain('user_id, request_id, source, related_order_id, related_client_id');
    expect(sql).toContain('before_json, after_json, diff_json, metadata_json');
    expect(sql).toContain('INSERT INTO outbox_events');
    expect(sql).toContain('payload_json, idempotency_key');
    expect(sql).toContain('ON CONFLICT (idempotency_key) DO NOTHING');

    const audit = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO audit_log'),
    );
    expect(audit?.params).toEqual([
      'deadlines.deadline_cancelled',
      'deadline',
      '11111111-1111-4111-8111-111111111111',
      '42',
      'req-cancel-1',
      'backend-deadline-command',
      100,
      5,
      JSON.stringify({ status: 'active' }),
      JSON.stringify({ status: 'cancelled' }),
      JSON.stringify({ status: { from: 'active', to: 'cancelled' } }),
      JSON.stringify({
        deadlineEventId: '22222222-2222-4222-8222-222222222222',
        eventType: 'DEADLINE_CANCELLED',
        entityType: 'order',
        entityId: '100',
        orderWorkshopId: null,
        reason: 'Заказ отменен',
        trigger: 'manual',
        workerId: null,
        schedulerRunId: null,
      }),
    ]);
    const outbox = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO outbox_events'),
    );
    expect(outbox?.params).toEqual([
      'deadline.event.created',
      '11111111-1111-4111-8111-111111111111',
      JSON.stringify({
        deadlineEventId: '22222222-2222-4222-8222-222222222222',
        eventType: 'DEADLINE_CANCELLED',
        entityType: 'order',
        entityId: '100',
        orderId: 100,
        requestId: 'req-cancel-1',
        actorUserId: '42',
        reason: 'Заказ отменен',
        beforeStatus: 'active',
        afterStatus: 'cancelled',
        trigger: 'manual',
        workerId: null,
        schedulerRunId: null,
        source: 'backend-deadline-command',
      }),
      'deadline-event:22222222-2222-4222-8222-222222222222:outbox',
    ]);
  });

  it('preserves orders.sync source in audit and outbox rows for sync-created events', async () => {
    const database = createDatabase();
    const repository = new PgDeadlineRepository(database.client);

    await repository.createDeadlineEvent({
      deadlineId: '11111111-1111-4111-8111-111111111111',
      eventType: 'DEADLINE_COMPLETED_ON_TIME',
      severity: 'info',
      entityType: 'order',
      entityId: '100',
      orderId: 100,
      clientId: 5,
      deadlineAt: '2026-05-02T10:00:00.000Z',
      eventAt: '2026-05-01T10:00:00.000Z',
      payload: {
        source: 'orders.sync',
        actorUserId: '42',
        completedAt: '2026-05-01T09:00:00.000Z',
      },
    });

    const audit = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO audit_log'),
    );
    expect(audit?.params[5]).toBe('orders.sync');

    const outbox = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO outbox_events'),
    );
    expect(JSON.parse(String(outbox?.params[2]))).toMatchObject({
      source: 'orders.sync',
      actorUserId: '42',
    });
  });

  it('does not label worker-style deadline events as backend commands', async () => {
    const database = createDatabase();
    const repository = new PgDeadlineRepository(database.client);

    await repository.createDeadlineEvent({
      deadlineId: '11111111-1111-4111-8111-111111111111',
      eventType: 'DEADLINE_EXPIRED',
      severity: 'critical',
      entityType: 'order',
      entityId: '100',
      orderId: 100,
      clientId: 5,
      deadlineAt: '2026-05-02T10:00:00.000Z',
      eventAt: '2026-05-03T10:00:00.000Z',
      delayMinutes: 1440,
      payload: { status: 'expired' },
    });

    const audit = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO audit_log'),
    );
    expect(audit?.params[5]).toBe('deadline-engine-manual');

    const outbox = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO outbox_events'),
    );
    expect(JSON.parse(String(outbox?.params[2]))).toMatchObject({
      source: 'deadline-engine',
      actorUserId: null,
      requestId: null,
      trigger: 'manual',
      workerId: null,
      schedulerRunId: null,
    });
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

  it('writes worker-created event audit and outbox with deadline-engine source and worker context', async () => {
    const database = createDatabase();
    const repository = new PgDeadlineRepository(database.client);

    await repository.createDeadlineEvent({
      deadlineId: '11111111-1111-4111-8111-111111111111',
      eventType: 'DEADLINE_EXPIRED',
      severity: 'critical',
      entityType: 'order',
      entityId: '100',
      orderId: 100,
      clientId: 5,
      deadlineAt: '2026-05-02T10:00:00.000Z',
      eventAt: '2026-05-03T10:00:00.000Z',
      delayMinutes: 1440,
      payload: {
        status: 'expired',
        source: 'deadline-engine',
        trigger: 'scheduler',
        workerId: 'worker-a',
        schedulerRunId: 'scheduler-run-1',
        actorUserId: '42',
        requestId: 'req-worker-1',
      },
      idempotencyKey: 'deadline-terminal:11111111-1111-4111-8111-111111111111:DEADLINE_EXPIRED:deadline-engine',
    });

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).toContain('deadline_id, event_type, severity, entity_type, entity_id, order_id, order_workshop_id, client_id, deadline_at, event_at, delay_minutes, payload_json, idempotency_key');
    expect(sql).toContain('ON CONFLICT (idempotency_key)');
    expect(sql).toContain('WHERE idempotency_key IS NOT NULL DO UPDATE');

    const audit = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO audit_log'),
    );
    expect(audit?.params[5]).toBe('deadline-engine-scheduler');
    expect(JSON.parse(String(audit?.params[11]))).toMatchObject({
      trigger: 'scheduler',
      workerId: 'worker-a',
      schedulerRunId: 'scheduler-run-1',
    });

    const outbox = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO outbox_events'),
    );
    expect(JSON.parse(String(outbox?.params[2]))).toMatchObject({
      source: 'deadline-engine',
      trigger: 'scheduler',
      actorUserId: '42',
      requestId: 'req-worker-1',
      workerId: 'worker-a',
      schedulerRunId: 'scheduler-run-1',
    });
    const deadlineEventInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO deadline_events'),
    );
    expect(deadlineEventInsert?.params.at(-1)).toBe(
      'deadline-terminal:11111111-1111-4111-8111-111111111111:DEADLINE_EXPIRED:deadline-engine',
    );
  });

  it('does not write audit or outbox side effects when an idempotent event already exists', async () => {
    const database = createDatabase({ eventWasInserted: false });
    const repository = new PgDeadlineRepository(database.client);

    await expect(
      repository.createDeadlineEvent({
        deadlineId: '11111111-1111-4111-8111-111111111111',
        eventType: 'DEADLINE_EXPIRED',
        severity: 'critical',
        entityType: 'order',
        entityId: '100',
        orderId: 100,
        clientId: 5,
        deadlineAt: '2026-05-02T10:00:00.000Z',
        eventAt: '2026-05-03T10:00:00.000Z',
        payload: { source: 'deadline-engine', trigger: 'scheduler' },
        idempotencyKey: 'deadline-terminal:11111111-1111-4111-8111-111111111111:DEADLINE_EXPIRED:deadline-engine',
      }),
    ).resolves.toMatchObject({
      created: false,
      event: {
        deadlineEventId: '22222222-2222-4222-8222-222222222222',
      },
    });

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).toContain('(xmax = 0) AS was_inserted');
    expect(sql).not.toContain('INSERT INTO audit_log');
    expect(sql).not.toContain('INSERT INTO outbox_events');
  });

  it('reports newly inserted deadline events as created', async () => {
    const database = createDatabase({ eventWasInserted: true });
    const repository = new PgDeadlineRepository(database.client);

    await expect(
      repository.createDeadlineEvent({
        deadlineId: '11111111-1111-4111-8111-111111111111',
        eventType: 'DEADLINE_EXPIRED',
        severity: 'critical',
        entityType: 'order',
        entityId: '100',
        orderId: 100,
        clientId: 5,
        deadlineAt: '2026-05-02T10:00:00.000Z',
        eventAt: '2026-05-03T10:00:00.000Z',
        payload: { source: 'deadline-engine', trigger: 'scheduler' },
        idempotencyKey: 'deadline-terminal:11111111-1111-4111-8111-111111111111:DEADLINE_EXPIRED:deadline-engine',
      }),
    ).resolves.toMatchObject({
      created: true,
      event: {
        deadlineEventId: '22222222-2222-4222-8222-222222222222',
      },
    });
  });

  it('caps due worker scan with FOR UPDATE SKIP LOCKED and configured limit', async () => {
    const database = createDatabase();
    const repository = new PgDeadlineRepository(database.client);

    await repository.findDueDeadlinesForUpdate({
      now: '2026-05-02T10:00:00.000Z',
      limit: 25,
      workerId: 'worker-acceptance',
    });

    const query = database.queries.find((item) =>
      normalizeSql(item.text).includes('FOR UPDATE SKIP LOCKED'),
    );
    expect(normalizeSql(query?.text ?? '')).toContain('LIMIT $2 FOR UPDATE SKIP LOCKED');
    expect(query?.params).toEqual(['2026-05-02T10:00:00.000Z', 25]);
  });
});

function createDatabase(options: { eventWasInserted?: boolean } = {}) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  const client = {
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });

      if (text.includes('COUNT(*)::int')) {
        return { rows: [{ total: 1 }] };
      }

      if (text.includes('RETURNING') && text.includes('deadline_events')) {
        return { rows: [eventRow(params, options.eventWasInserted ?? true)] };
      }

      if (text.includes('RETURNING') && text.includes('deadline_action_executions')) {
        return { rows: [executionRow()] };
      }

      if (text.includes('RETURNING') && text.includes("SET status = 'cancelled'")) {
        return {
          rows: [
            deadlineRow({
              status: 'cancelled',
              cancelled_at: new Date('2026-05-01T10:00:00.000Z'),
            }),
          ],
        };
      }

      if (text.includes('FROM deadline_instances') || text.includes('RETURNING')) {
        return { rows: [deadlineRow()] };
      }

      return { rows: [] };
    },
  } as unknown as DatabaseClient;

  return { client, queries };
}

type DeadlineTestRow = ReturnType<typeof baseDeadlineRow>;

function deadlineRow(overrides: Partial<DeadlineTestRow> = {}) {
  return {
    ...baseDeadlineRow(),
    ...overrides,
  };
}

function baseDeadlineRow() {
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

function eventRow(params: readonly unknown[] = [], wasInserted = true) {
  return {
    deadline_event_id: '22222222-2222-4222-8222-222222222222',
    deadline_id: String(params[0] ?? '11111111-1111-4111-8111-111111111111'),
    event_type: String(params[1] ?? 'DEADLINE_CREATED'),
    severity: String(params[2] ?? 'info'),
    entity_type: String(params[3] ?? 'order'),
    entity_id: String(params[4] ?? '100'),
    order_id: (params[5] as number | null | undefined) ?? 100,
    order_workshop_id: (params[6] as number | null | undefined) ?? null,
    client_id: (params[7] as number | null | undefined) ?? 5,
    deadline_at:
      params[8] instanceof Date
        ? params[8]
        : new Date(String(params[8] ?? '2026-05-02T10:00:00.000Z')),
    event_at:
      params[9] instanceof Date
        ? params[9]
        : new Date(String(params[9] ?? '2026-05-01T10:00:00.000Z')),
    delay_minutes: (params[10] as number | null | undefined) ?? null,
    payload_json:
      typeof params[11] === 'string'
        ? (JSON.parse(params[11]) as Record<string, unknown>)
        : {},
    idempotency_key: (params[12] as string | null | undefined) ?? null,
    was_inserted: wasInserted,
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
