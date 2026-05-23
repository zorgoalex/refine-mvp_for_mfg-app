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

  it('creates manual deadlines idempotently with lifecycle event, audit and outbox rows', async () => {
    const database = createDatabase();
    const repository = new PgDeadlineRepository(database.client);

    await expect(
      repository.createDeadlineInstance({
        currentUser: currentUser(),
        requestId: 'req-create-1',
        dto: {
          entityType: 'order',
          entityId: '100',
          orderId: 100,
          clientId: 5,
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
    expect(sql).toContain('idempotency_key');
    expect(sql).toContain('ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE');
    expect(sql).toContain('INSERT INTO deadline_events');
    expect(sql).toContain('INSERT INTO audit_log');
    expect(sql).toContain('INSERT INTO outbox_events');

    const createInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO deadline_instances'),
    );
    expect(createInsert?.params.at(-1)).toBe('deadline-create:req-create-1');

    const eventInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO deadline_events'),
    );
    expect(JSON.parse(String(eventInsert?.params[11]))).toMatchObject({
      source: 'backend-deadline-command',
      requestId: 'req-create-1',
      actorUserId: '42',
      afterStatus: 'active',
    });
    expect(eventInsert?.params[12]).toBe(
      'deadline-command:11111111-1111-4111-8111-111111111111:DEADLINE_CREATED:req-create-1',
    );

    const audit = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO audit_log'),
    );
    expect(audit?.params).toEqual([
      'deadlines.deadline_created',
      'deadline',
      '11111111-1111-4111-8111-111111111111',
      '42',
      'req-create-1',
      'backend-deadline-command',
      100,
      5,
      JSON.stringify({}),
      JSON.stringify({ status: 'active' }),
      JSON.stringify({ status: { from: null, to: 'active' } }),
      JSON.stringify({
        deadlineEventId: '22222222-2222-4222-8222-222222222222',
        eventType: 'DEADLINE_CREATED',
        entityType: 'order',
        entityId: '100',
        orderWorkshopId: null,
        reason: null,
        trigger: 'manual',
        workerId: null,
        schedulerRunId: null,
      }),
    ]);
  });

  it('creates manual deadlines without duplicate side effects for duplicate request ids', async () => {
    const database = createDatabase();
    const repository = new PgDeadlineRepository(database.client);
    const command = {
      currentUser: currentUser(),
      requestId: 'req-create-1',
      dto: {
        entityType: 'order' as const,
        entityId: '100',
        orderId: 100,
        clientId: 5,
        deadlineAt: '2026-05-02T10:00:00.000Z',
        source: 'manual' as const,
        metadata: { label: 'Manual' },
      },
    };

    const first = await repository.createDeadlineInstance(command);
    const second = await repository.createDeadlineInstance(command);

    expect(second.deadlineId).toBe(first.deadlineId);

    const createInserts = database.queries.filter((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO deadline_instances'),
    );
    expect(createInserts).toHaveLength(2);
    expect(createInserts.map((query) => query.params.at(-1))).toEqual([
      'deadline-create:req-create-1',
      'deadline-create:req-create-1',
    ]);
    expect(createInserts.every((query) =>
      normalizeSql(query.text).includes(
        'ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE',
      ),
    )).toBe(true);

    const eventInserts = database.queries.filter((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO deadline_events'),
    );
    expect(eventInserts).toHaveLength(2);
    expect(eventInserts.map((query) => query.params[12])).toEqual([
      'deadline-command:11111111-1111-4111-8111-111111111111:DEADLINE_CREATED:req-create-1',
      'deadline-command:11111111-1111-4111-8111-111111111111:DEADLINE_CREATED:req-create-1',
    ]);

    expect(database.queries.filter((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO audit_log'),
    )).toHaveLength(1);
    expect(database.queries.filter((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO outbox_events'),
    )).toHaveLength(1);
  });

  it('overrides deadlines with guarded supersede, replacement deadline, audit and outbox dimensions', async () => {
    const database = createDatabase();
    const repository = new PgDeadlineRepository(database.client);

    await expect(
      repository.overrideDeadline({
        currentUser: currentUser(),
        deadlineId: '11111111-1111-4111-8111-111111111111',
        requestId: 'req-override-1',
        dto: {
          deadlineAt: '2026-05-03T10:00:00.000Z',
          reason: 'Manual correction',
          metadata: { overrideBatch: 'manual-1' },
        },
      }),
    ).resolves.toMatchObject({
      deadlineId: '11111111-1111-4111-8111-111111111111',
      isManuallyOverridden: true,
    });

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).toContain(
      "WHERE deadline_id = $1 AND status NOT IN ('expired', 'completed_on_time', 'completed_late', 'cancelled', 'superseded')",
    );
    expect(sql).toContain('INSERT INTO deadline_instances');
    expect(sql).toContain('idempotency_key');
    expect(sql).toContain('ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE');
    expect(sql).toContain('INSERT INTO deadline_events');
    expect(sql).toContain('INSERT INTO audit_log');
    expect(sql).toContain('INSERT INTO outbox_events');

    const eventInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO deadline_events'),
    );
    expect(JSON.parse(String(eventInsert?.params[11]))).toMatchObject({
      previousDeadlineId: '11111111-1111-4111-8111-111111111111',
      previousDeadlineAt: '2026-05-02T10:00:00.000Z',
      reason: 'Manual correction',
      actorUserId: '42',
      requestId: 'req-override-1',
      source: 'backend-deadline-command',
      beforeStatus: 'active',
      afterStatus: 'active',
    });
    expect(eventInsert?.params[12]).toBe(
      'deadline-command:11111111-1111-4111-8111-111111111111:DEADLINE_UPDATED:req-override-1',
    );

    const audit = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO audit_log'),
    );
    expect(audit?.params[0]).toBe('deadlines.deadline_updated');
    expect(audit?.params[4]).toBe('req-override-1');
    expect(audit?.params[5]).toBe('backend-deadline-command');
    expect(JSON.parse(String(audit?.params[8]))).toMatchObject({
      status: 'active',
      deadlineAt: '2026-05-02T10:00:00.000Z',
    });
    expect(JSON.parse(String(audit?.params[9]))).toMatchObject({
      status: 'active',
      deadlineAt: '2026-05-03T10:00:00.000Z',
    });
    expect(JSON.parse(String(audit?.params[10]))).toMatchObject({
      deadlineAt: {
        from: '2026-05-02T10:00:00.000Z',
        to: '2026-05-03T10:00:00.000Z',
      },
    });
  });

  it('rejects stale override updates when the row became terminal before supersede', async () => {
    const database = createDatabase({ emptyOverrideSupersedeUpdate: true });
    const repository = new PgDeadlineRepository(database.client);

    await expect(
      repository.overrideDeadline({
        currentUser: currentUser(),
        deadlineId: '11111111-1111-4111-8111-111111111111',
        requestId: 'req-override-stale',
        dto: {
          deadlineAt: '2026-05-03T10:00:00.000Z',
          reason: 'Manual correction',
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEADLINE_INVALID_STATUS_TRANSITION',
    });

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).not.toContain('INSERT INTO deadline_events');
    expect(sql).not.toContain('INSERT INTO audit_log');
    expect(sql).not.toContain('INSERT INTO outbox_events');
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

  it('pauses deadlines with a guarded status transition, pause row, audit and outbox dimensions', async () => {
    const database = createDatabase();
    const repository = new PgDeadlineRepository(database.client);

    await expect(
      repository.pauseDeadline({
        currentUser: currentUser(),
        deadlineId: '11111111-1111-4111-8111-111111111111',
        requestId: 'req-pause-1',
        dto: {
          pauseMode: 'pause_and_shift_deadline',
          pauseReason: 'Ожидание клиента',
          notes: 'Client requested delay',
        },
      }),
    ).resolves.toMatchObject({
      deadlineId: '11111111-1111-4111-8111-111111111111',
      status: 'paused',
    });

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).toContain("WHERE deadline_id = $1 AND status = 'active'");
    expect(sql).toContain('INSERT INTO deadline_pauses');
    expect(sql).toContain('INSERT INTO deadline_events');
    expect(sql).toContain('INSERT INTO audit_log');
    expect(sql).toContain('INSERT INTO outbox_events');

    const pauseInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO deadline_pauses'),
    );
    expect(pauseInsert?.params).toEqual([
      '11111111-1111-4111-8111-111111111111',
      'Ожидание клиента',
      'pause_and_shift_deadline',
      42,
      'Client requested delay',
    ]);

    const eventInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO deadline_events'),
    );
    expect(JSON.parse(String(eventInsert?.params[11]))).toMatchObject({
      pauseMode: 'pause_and_shift_deadline',
      pauseReason: 'Ожидание клиента',
      notes: 'Client requested delay',
      actorUserId: '42',
      requestId: 'req-pause-1',
      source: 'backend-deadline-command',
      reason: 'Ожидание клиента',
      beforeStatus: 'active',
      afterStatus: 'paused',
    });

    const audit = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO audit_log'),
    );
    expect(audit?.params).toEqual([
      'deadlines.deadline_paused',
      'deadline',
      '11111111-1111-4111-8111-111111111111',
      '42',
      'req-pause-1',
      'backend-deadline-command',
      100,
      5,
      JSON.stringify({ status: 'active' }),
      JSON.stringify({ status: 'paused' }),
      JSON.stringify({ status: { from: 'active', to: 'paused' } }),
      JSON.stringify({
        deadlineEventId: '22222222-2222-4222-8222-222222222222',
        eventType: 'DEADLINE_PAUSED',
        entityType: 'order',
        entityId: '100',
        orderWorkshopId: null,
        reason: 'Ожидание клиента',
        trigger: 'manual',
        workerId: null,
        schedulerRunId: null,
      }),
    ]);

    const outbox = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO outbox_events'),
    );
    expect(JSON.parse(String(outbox?.params[2]))).toMatchObject({
      deadlineEventId: '22222222-2222-4222-8222-222222222222',
      eventType: 'DEADLINE_PAUSED',
      entityType: 'order',
      entityId: '100',
      orderId: 100,
      requestId: 'req-pause-1',
      actorUserId: '42',
      reason: 'Ожидание клиента',
      beforeStatus: 'active',
      afterStatus: 'paused',
      trigger: 'manual',
      workerId: null,
      schedulerRunId: null,
      source: 'backend-deadline-command',
    });
  });

  it('resumes deadlines with a guarded status transition, pause closeout, audit and outbox dimensions', async () => {
    const database = createDatabase({ deadlineStatusByIdSelect: 'paused' });
    const repository = new PgDeadlineRepository(database.client);

    await expect(
      repository.resumeDeadline({
        currentUser: currentUser(),
        deadlineId: '11111111-1111-4111-8111-111111111111',
        requestId: 'req-resume-1',
        dto: {
          notes: 'Client replied',
        },
      }),
    ).resolves.toMatchObject({
      deadlineId: '11111111-1111-4111-8111-111111111111',
      status: 'active',
    });

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).toContain("WHERE deadline_id = $1 AND status = 'paused'");
    expect(sql).toContain('UPDATE deadline_pauses');
    expect(sql).toContain('AND resumed_at IS NULL');
    expect(sql).toContain('INSERT INTO deadline_events');
    expect(sql).toContain('INSERT INTO audit_log');
    expect(sql).toContain('INSERT INTO outbox_events');

    const pauseUpdate = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('UPDATE deadline_pauses'),
    );
    expect(pauseUpdate?.params).toEqual([
      '11111111-1111-4111-8111-111111111111',
      42,
      'Client replied',
    ]);

    const eventInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO deadline_events'),
    );
    expect(JSON.parse(String(eventInsert?.params[11]))).toMatchObject({
      notes: 'Client replied',
      actorUserId: '42',
      requestId: 'req-resume-1',
      source: 'backend-deadline-command',
      beforeStatus: 'paused',
      afterStatus: 'active',
    });

    const audit = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO audit_log'),
    );
    expect(audit?.params).toEqual([
      'deadlines.deadline_resumed',
      'deadline',
      '11111111-1111-4111-8111-111111111111',
      '42',
      'req-resume-1',
      'backend-deadline-command',
      100,
      5,
      JSON.stringify({ status: 'paused' }),
      JSON.stringify({ status: 'active' }),
      JSON.stringify({ status: { from: 'paused', to: 'active' } }),
      JSON.stringify({
        deadlineEventId: '22222222-2222-4222-8222-222222222222',
        eventType: 'DEADLINE_RESUMED',
        entityType: 'order',
        entityId: '100',
        orderWorkshopId: null,
        reason: null,
        trigger: 'manual',
        workerId: null,
        schedulerRunId: null,
      }),
    ]);

    const outbox = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO outbox_events'),
    );
    expect(JSON.parse(String(outbox?.params[2]))).toMatchObject({
      deadlineEventId: '22222222-2222-4222-8222-222222222222',
      eventType: 'DEADLINE_RESUMED',
      entityType: 'order',
      entityId: '100',
      orderId: 100,
      requestId: 'req-resume-1',
      actorUserId: '42',
      reason: null,
      beforeStatus: 'paused',
      afterStatus: 'active',
      trigger: 'manual',
      workerId: null,
      schedulerRunId: null,
      source: 'backend-deadline-command',
    });
  });

  it('uses deadline-command request id fallback in pause event payload', async () => {
    const database = createDatabase();
    const repository = new PgDeadlineRepository(database.client);

    await repository.pauseDeadline({
      currentUser: currentUser(),
      deadlineId: '11111111-1111-4111-8111-111111111111',
      dto: {
        pauseMode: 'pause_and_shift_deadline',
        pauseReason: 'Ожидание клиента',
      },
    });

    const eventInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO deadline_events'),
    );
    expect(JSON.parse(String(eventInsert?.params[11]))).toMatchObject({
      requestId: 'deadline-command',
      reason: 'Ожидание клиента',
    });
  });

  it('uses deadline-command request id fallback in resume event payload', async () => {
    const database = createDatabase({ deadlineStatusByIdSelect: 'paused' });
    const repository = new PgDeadlineRepository(database.client);

    await repository.resumeDeadline({
      currentUser: currentUser(),
      deadlineId: '11111111-1111-4111-8111-111111111111',
      dto: {
        notes: 'Client replied',
      },
    });

    const eventInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO deadline_events'),
    );
    expect(JSON.parse(String(eventInsert?.params[11]))).toMatchObject({
      requestId: 'deadline-command',
      beforeStatus: 'paused',
      afterStatus: 'active',
    });
  });

  it('rejects stale pause updates when the row is no longer active', async () => {
    const database = createDatabase({ emptyPauseUpdate: true });
    const repository = new PgDeadlineRepository(database.client);

    await expect(
      repository.pauseDeadline({
        currentUser: currentUser(),
        deadlineId: '11111111-1111-4111-8111-111111111111',
        requestId: 'req-pause-stale',
        dto: {
          pauseMode: 'pause_without_shift',
          pauseReason: 'Ожидание клиента',
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEADLINE_INVALID_STATUS_TRANSITION',
    });

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).not.toContain('INSERT INTO deadline_pauses');
    expect(sql).not.toContain('INSERT INTO deadline_events');
    expect(sql).not.toContain('INSERT INTO audit_log');
    expect(sql).not.toContain('INSERT INTO outbox_events');
  });

  it('rejects stale resume updates when the row is no longer paused', async () => {
    const database = createDatabase({ emptyResumeUpdate: true });
    const repository = new PgDeadlineRepository(database.client);

    await expect(
      repository.resumeDeadline({
        currentUser: currentUser(),
        deadlineId: '11111111-1111-4111-8111-111111111111',
        requestId: 'req-resume-stale',
        dto: {},
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEADLINE_INVALID_STATUS_TRANSITION',
    });

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).not.toContain('UPDATE deadline_pauses');
    expect(sql).not.toContain('INSERT INTO deadline_events');
    expect(sql).not.toContain('INSERT INTO audit_log');
    expect(sql).not.toContain('INSERT INTO outbox_events');
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

function createDatabase(
  options: {
    deadlineStatusByIdSelect?: DeadlineTestRow['status'];
    eventWasInserted?: boolean;
    emptyOverrideSupersedeUpdate?: boolean;
    emptyPauseUpdate?: boolean;
    emptyResumeUpdate?: boolean;
  } = {},
) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  const insertedEventIdempotencyKeys = new Set<string>();
  const client = {
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });

      if (text.includes('COUNT(*)::int')) {
        return { rows: [{ total: 1 }] };
      }

      if (text.includes('RETURNING') && text.includes('deadline_events')) {
        const idempotencyKey = typeof params[12] === 'string' ? params[12] : null;
        const wasInserted = options.eventWasInserted ?? (
          idempotencyKey === null || !insertedEventIdempotencyKeys.has(idempotencyKey)
        );
        if (idempotencyKey !== null) {
          insertedEventIdempotencyKeys.add(idempotencyKey);
        }

        return { rows: [eventRow(params, wasInserted)] };
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

      if (
        options.emptyOverrideSupersedeUpdate &&
        text.includes('RETURNING') &&
        text.includes("SET status = 'superseded'")
      ) {
        return { rows: [] };
      }

      if (text.includes('RETURNING') && text.includes("SET status = 'superseded'")) {
        return {
          rows: [
            deadlineRow({
              status: 'superseded',
            }),
          ],
        };
      }

      if (
        options.emptyPauseUpdate &&
        text.includes('RETURNING') &&
        text.includes("SET status = 'paused'")
      ) {
        return { rows: [] };
      }

      if (text.includes('RETURNING') && text.includes("SET status = 'paused'")) {
        return {
          rows: [
            deadlineRow({
              status: 'paused',
            }),
          ],
        };
      }

      if (
        options.emptyResumeUpdate &&
        text.includes('RETURNING') &&
        text.includes("SET status = 'active'") &&
        text.includes("status = 'paused'")
      ) {
        return { rows: [] };
      }

      if (
        text.includes('RETURNING') &&
        text.includes('INSERT INTO deadline_instances') &&
        text.includes('is_manually_overridden')
      ) {
        return {
          rows: [
            deadlineRow({
              deadline_at: new Date('2026-05-03T10:00:00.000Z'),
              is_manually_overridden: true,
              metadata_json: { label: 'Manual', overrideBatch: 'manual-1', overrideReason: 'Manual correction' },
            }),
          ],
        };
      }

      if (
        options.deadlineStatusByIdSelect &&
        text.includes('SELECT') &&
        text.includes('FROM deadline_instances') &&
        text.includes('deadline_id = $1')
      ) {
        return { rows: [deadlineRow({ status: options.deadlineStatusByIdSelect })] };
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
    idempotency_key: null,
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
