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

  it('creates policies with an initial version and queryable audit dimensions', async () => {
    const database = createDatabase();
    const repository = new PgDeadlineRepository(database.client);

    await expect(
      repository.createPolicy({
        currentUser: currentUser(),
        requestId: 'req-policy-create',
        dto: {
          policyCode: 'order.final',
          policyName: 'Final order deadline',
          scopeType: 'order',
          durationValue: 10,
          durationUnit: 'working_day',
          config: { calendar: 'production' },
        },
      }),
    ).resolves.toMatchObject({
      policyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      policyCode: 'order.final',
    });

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).toContain('INSERT INTO deadline_policies');
    expect(sql).toContain('INSERT INTO deadline_policy_versions');
    expect(sql).toContain('INSERT INTO audit_log');
    expect(sql).not.toContain('INSERT INTO outbox_events');

    const versionInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO deadline_policy_versions'),
    );
    expect(versionInsert?.params).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      1,
      JSON.stringify({ calendar: 'production' }),
      42,
    ]);

    const audit = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO audit_log'),
    );
    expect(audit?.params.slice(0, 8)).toEqual([
      'deadlines.policy.created',
      'deadline_policy',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '42',
      'req-policy-create',
      'backend-deadline-command',
      null,
      null,
    ]);
    expect(JSON.parse(String(audit?.params[9]))).toMatchObject({
      policyCode: 'order.final',
      policyName: 'Final order deadline',
      scopeType: 'order',
      durationValue: 10,
      durationUnit: 'working_day',
      isEnabled: true,
    });
    expect(JSON.parse(String(audit?.params[11]))).toMatchObject({
      policyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      policyCode: 'order.final',
      scopeType: 'order',
      versionNumber: 1,
    });
  });

  it('updates policies by appending a version and auditing before/after diff', async () => {
    const database = createDatabase();
    const repository = new PgDeadlineRepository(database.client);

    await expect(
      repository.updatePolicy({
        currentUser: currentUser(),
        requestId: 'req-policy-update',
        policyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        dto: {
          policyName: 'Updated final deadline',
          durationValue: 15,
          isEnabled: false,
          config: { calendar: 'updated' },
        },
      }),
    ).resolves.toMatchObject({
      policyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      policyName: 'Updated final deadline',
      durationValue: 15,
      isEnabled: false,
    });

    const versionInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO deadline_policy_versions'),
    );
    expect(versionInsert?.params).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      3,
      JSON.stringify({ calendar: 'updated' }),
      42,
    ]);

    const audit = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO audit_log'),
    );
    expect(audit?.params.slice(0, 8)).toEqual([
      'deadlines.policy.updated',
      'deadline_policy',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '42',
      'req-policy-update',
      'backend-deadline-command',
      null,
      null,
    ]);
    expect(JSON.parse(String(audit?.params[8]))).toMatchObject({
      policyName: 'Final order deadline',
      durationValue: 10,
      isEnabled: true,
    });
    expect(JSON.parse(String(audit?.params[9]))).toMatchObject({
      policyName: 'Updated final deadline',
      durationValue: 15,
      isEnabled: false,
    });
    expect(JSON.parse(String(audit?.params[10]))).toMatchObject({
      policyName: { from: 'Final order deadline', to: 'Updated final deadline' },
      durationValue: { from: 10, to: 15 },
      isEnabled: { from: true, to: false },
    });
  });

  it('updates settings idempotently through action-rule upserts and audits changed settings', async () => {
    const database = createDatabase();
    const repository = new PgDeadlineRepository(database.client);

    await expect(
      repository.updateSettings({
        currentUser: currentUser(),
        requestId: 'req-settings-update',
        dto: { notifyAssigneeEnabled: true },
      }),
    ).resolves.toMatchObject({ notifyAssigneeEnabled: true });

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).toContain('SELECT action_rule_id FROM deadline_action_rules');
    expect(sql).toContain('UPDATE deadline_action_rules SET is_enabled = $2');
    expect(sql).toContain('INSERT INTO audit_log');
    expect(sql).not.toContain('INSERT INTO outbox_events');

    const audit = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO audit_log'),
    );
    expect(audit?.params.slice(0, 8)).toEqual([
      'deadlines.settings.updated',
      'deadline_settings',
      'global',
      '42',
      'req-settings-update',
      'backend-deadline-command',
      null,
      null,
    ]);
    expect(JSON.parse(String(audit?.params[8]))).toMatchObject({
      notifyAssigneeEnabled: false,
    });
    expect(JSON.parse(String(audit?.params[9]))).toMatchObject({
      notifyAssigneeEnabled: true,
    });
    expect(JSON.parse(String(audit?.params[10]))).toMatchObject({
      notifyAssigneeEnabled: { from: false, to: true },
    });
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
      deadlineId: '44444444-4444-4444-8444-444444444444',
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
      'deadline-command:44444444-4444-4444-8444-444444444444:DEADLINE_UPDATED:req-override-1',
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

    const outbox = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO outbox_events'),
    );
    expect(JSON.parse(String(outbox?.params[2]))).toMatchObject({
      deadlineEventId: '22222222-2222-4222-8222-222222222222',
      eventType: 'DEADLINE_UPDATED',
      beforeDeadlineAt: '2026-05-02T10:00:00.000Z',
      afterDeadlineAt: '2026-05-03T10:00:00.000Z',
      deadlineAt: '2026-05-03T10:00:00.000Z',
    });
  });

  it('returns the existing override replacement without duplicate side effects for duplicate request ids', async () => {
    const database = createDatabase();
    const repository = new PgDeadlineRepository(database.client);
    const command = {
      currentUser: currentUser(),
      deadlineId: '11111111-1111-4111-8111-111111111111',
      requestId: 'req-override-1',
      dto: {
        deadlineAt: '2026-05-03T10:00:00.000Z',
        reason: 'Manual correction',
      },
    };

    const first = await repository.overrideDeadline(command);
    const second = await repository.overrideDeadline(command);

    expect(first.deadlineId).toBe('44444444-4444-4444-8444-444444444444');
    expect(second.deadlineId).toBe(first.deadlineId);

    const supersedeUpdates = database.queries.filter((query) =>
      normalizeSql(query.text).includes("SET status = 'superseded'"),
    );
    expect(supersedeUpdates).toHaveLength(2);

    const replacementInserts = database.queries.filter((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO deadline_instances'),
    );
    expect(replacementInserts).toHaveLength(1);
    expect(replacementInserts[0]?.params[15]).toBe(
      'deadline-override:11111111-1111-4111-8111-111111111111:req-override-1',
    );

    const eventInserts = database.queries.filter((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO deadline_events'),
    );
    expect(eventInserts).toHaveLength(1);
    expect(eventInserts[0]?.params[12]).toBe(
      'deadline-command:44444444-4444-4444-8444-444444444444:DEADLINE_UPDATED:req-override-1',
    );

    expect(database.queries.filter((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO audit_log'),
    )).toHaveLength(1);
    expect(database.queries.filter((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO outbox_events'),
    )).toHaveLength(1);
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

  it('lists action rules in deterministic priority order and maps priority', async () => {
    const database = createDatabase();
    const repository = new PgDeadlineRepository(database.client);

    await expect(
      repository.listActionRules({
        scopeType: 'order',
        eventType: 'DEADLINE_EXPIRED',
      }),
    ).resolves.toMatchObject([
      {
        actionRuleId: 'rule-notify-assignee',
        priority: 50,
      },
    ]);

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).toContain('priority');
    expect(sql).toContain('ORDER BY priority ASC, created_at ASC, action_rule_id ASC');
  });

  it('persists action execution snapshot, order and target status evidence', async () => {
    const database = createDatabase();
    const repository = new PgDeadlineRepository(database.client);

    await expect(
      repository.createActionExecution({
        deadlineEventId: '22222222-2222-4222-8222-222222222222',
        actionRuleId: 'rule-change-status',
        actionType: 'change_order_status',
        targetType: 'order',
        targetId: '100',
        status: 'skipped',
        idempotencyKey: 'event:change_order_status:order:100',
        skipReason: 'preview_only',
        ruleConfigSnapshot: {
          actionRuleId: 'rule-change-status',
          priority: 10,
          eventType: 'DEADLINE_EXPIRED',
          actionType: 'change_order_status',
          conditions: {
            excludeCompletedOrders: true,
            requireCurrentDeadlineEvent: true,
          },
          actionConfig: { targetOrderStatusId: 7 },
          createdAt: '2026-05-01T10:00:00.000Z',
          updatedAt: '2026-05-01T10:05:00.000Z',
          snapshotHash: 'sha256:rule-change-status',
        },
        ruleVersionId: null,
        orderId: 100,
        targetStatusId: 7,
      }),
    ).resolves.toMatchObject({
      ruleConfigSnapshot: {
        actionRuleId: 'rule-change-status',
        priority: 10,
      },
      orderId: 100,
      targetStatusId: 7,
    });

    const insert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO deadline_action_executions'),
    );
    expect(normalizeSql(insert?.text ?? '')).toContain('rule_config_snapshot_json');
    expect(normalizeSql(insert?.text ?? '')).toContain('rule_version_id');
    expect(normalizeSql(insert?.text ?? '')).toContain('order_id');
    expect(normalizeSql(insert?.text ?? '')).toContain('target_status_id');
    expect(insert?.params).toContain(JSON.stringify({
      actionRuleId: 'rule-change-status',
      priority: 10,
      eventType: 'DEADLINE_EXPIRED',
      actionType: 'change_order_status',
      conditions: {
        excludeCompletedOrders: true,
        requireCurrentDeadlineEvent: true,
      },
      actionConfig: { targetOrderStatusId: 7 },
      createdAt: '2026-05-01T10:00:00.000Z',
      updatedAt: '2026-05-01T10:05:00.000Z',
      snapshotHash: 'sha256:rule-change-status',
    }));
    expect(insert?.params).toContain(100);
    expect(insert?.params).toContain(7);
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

  it('batch-loads active order action-rule overrides by candidate rule ids', async () => {
    const database = createDatabase();
    const repository = new PgDeadlineRepository(database.client);

    await expect(
      repository.listOrderActionRuleOverrides(100, [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ]),
    ).resolves.toEqual([expect.objectContaining({ orderId: 100 })]);

    const query = database.queries.find((item) =>
      normalizeSql(item.text).includes('FROM deadline_order_overrides') &&
      normalizeSql(item.text).includes('action_rule_id = ANY'),
    );
    expect(query?.params).toEqual([
      100,
      ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
    ]);
    expect(normalizeSql(query?.text ?? '')).toContain('retired_at IS NULL');
    expect(normalizeSql(query?.text ?? '')).toContain('policy_id IS NULL');
  });

  it('creates order overrides with created audit evidence and active uniqueness', async () => {
    const database = createDatabase({ noExistingOverride: true });
    const repository = new PgDeadlineRepository(database.client);

    await expect(
      repository.upsertOrderOverride({
        currentUser: currentUser(),
        requestId: 'req-order-override',
        dto: {
          orderId: 100,
          targetType: 'action_rule',
          actionRuleId: 'rule-change-status',
          isDisabled: true,
          reason: 'Customer approved exception',
        },
        audit: {
          event: 'deadline.order_override_updated',
          source: 'admin-ui',
          actorUserId: 42,
          requestId: 'req-order-override',
          timerRuleId: null,
          actionRuleId: 'rule-change-status',
          orderId: 100,
          before: {},
          after: { isDisabled: true },
          diff: { isDisabled: { from: null, to: true } },
          reason: 'Customer approved exception',
          comment: null,
          executionEvidence: null,
        },
      }),
    ).resolves.toMatchObject({
      orderId: 100,
      actionRuleId: 'rule-change-status',
      isDisabled: true,
      reason: 'Customer approved exception',
    });

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).toContain('INSERT INTO deadline_order_overrides');
    expect(sql).toContain('ON CONFLICT (order_id, action_rule_id) WHERE retired_at IS NULL AND action_rule_id IS NOT NULL DO UPDATE');
    expect(sql).toContain('INSERT INTO audit_log');

    const audit = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO audit_log'),
    );
    expect(audit?.params.slice(0, 8)).toEqual([
      'deadline.order_override_created',
      'deadline_order_override',
      'override-action',
      '42',
      'req-order-override',
      'admin-ui',
      100,
      null,
    ]);
    expect(JSON.parse(String(audit?.params[8]))).toEqual({});
    expect(JSON.parse(String(audit?.params[9]))).toMatchObject({
      isDisabled: true,
      reason: 'Customer approved exception',
      retiredAt: null,
    });
    expect(JSON.parse(String(audit?.params[10]))).toMatchObject({
      isDisabled: { from: null, to: true },
      reason: { from: null, to: 'Customer approved exception' },
    });
    expect(JSON.parse(String(audit?.params[11]))).toMatchObject({
      reason: 'Customer approved exception',
      actionRuleId: 'rule-change-status',
      orderId: 100,
    });
  });

  it('updates order overrides with real before after diff audit evidence', async () => {
    const database = createDatabase({
      existingOverride: orderOverrideRow({
        is_disabled: false,
        reason: 'Initial reason',
        override_config_json: { timerConfig: { durationValue: 1 } },
      }),
    });
    const repository = new PgDeadlineRepository(database.client);

    await repository.upsertOrderOverride({
      currentUser: currentUser(),
      requestId: 'req-order-override-update',
      dto: {
        orderId: 100,
        targetType: 'action_rule',
        actionRuleId: 'rule-change-status',
        isDisabled: true,
        overrideConfig: { timerConfig: { durationValue: 2 } },
        reason: 'Updated reason',
      },
      audit: {
        event: 'deadline.order_override_updated',
        source: 'admin-ui',
        actorUserId: 42,
        requestId: 'req-order-override-update',
        timerRuleId: null,
        actionRuleId: 'rule-change-status',
        orderId: 100,
        before: {},
        after: {},
        diff: {},
        reason: 'Updated reason',
        comment: null,
        executionEvidence: null,
      },
    });

    const audit = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO audit_log'),
    );
    expect(audit?.params[0]).toBe('deadline.order_override_updated');
    expect(audit?.params[5]).toBe('admin-ui');
    expect(audit?.params[6]).toBe(100);
    expect(JSON.parse(String(audit?.params[8]))).toMatchObject({
      isDisabled: false,
      reason: 'Initial reason',
      overrideConfig: { timerConfig: { durationValue: 1 } },
    });
    expect(JSON.parse(String(audit?.params[9]))).toMatchObject({
      isDisabled: true,
      reason: 'Updated reason',
      overrideConfig: { timerConfig: { durationValue: 2 } },
    });
    expect(JSON.parse(String(audit?.params[10]))).toMatchObject({
      isDisabled: { from: false, to: true },
      reason: { from: 'Initial reason', to: 'Updated reason' },
      overrideConfig: {
        from: { timerConfig: { durationValue: 1 } },
        to: { timerConfig: { durationValue: 2 } },
      },
    });
    expect(JSON.parse(String(audit?.params[11]))).toMatchObject({
      reason: 'Updated reason',
      orderId: 100,
    });
  });

  it('soft-retires order overrides and writes remove audit evidence', async () => {
    const database = createDatabase();
    const repository = new PgDeadlineRepository(database.client);

    await expect(
      repository.retireOrderOverride({
        currentUser: currentUser(),
        requestId: 'req-remove-override',
        orderId: 100,
        overrideId: 'override-action',
        reason: 'Exception cleared',
        audit: {
          event: 'deadline.order_override_removed',
          source: 'admin-ui',
          actorUserId: 42,
          requestId: 'req-remove-override',
          timerRuleId: null,
          actionRuleId: 'rule-change-status',
          orderId: 100,
          before: { isDisabled: true },
          after: { retiredAt: 'now' },
          diff: { retiredAt: { from: null, to: 'now' } },
          reason: 'Exception cleared',
          comment: null,
          executionEvidence: null,
        },
      }),
    ).resolves.toMatchObject({
      overrideId: 'override-action',
      retiredAt: '2026-05-25T10:00:00.000Z',
    });

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).toContain('UPDATE deadline_order_overrides');
    expect(sql).toContain('override_id = $1 AND order_id = $2');
    expect(sql).toContain('retired_at = now()');
    expect(sql).not.toContain('DELETE FROM deadline_order_overrides');
    expect(sql).toContain('INSERT INTO audit_log');

    const update = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('UPDATE deadline_order_overrides'),
    );
    expect(update?.params).toEqual(['override-action', 100, 42]);

    const audit = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO audit_log'),
    );
    expect(audit?.params[0]).toBe('deadline.order_override_removed');
    expect(audit?.params[5]).toBe('admin-ui');
    expect(audit?.params[6]).toBe(100);
    expect(JSON.parse(String(audit?.params[8]))).toMatchObject({
      overrideId: 'override-action',
      retiredAt: null,
    });
    expect(JSON.parse(String(audit?.params[9]))).toMatchObject({
      overrideId: 'override-action',
      retiredAt: '2026-05-25T10:00:00.000Z',
      retiredByUserId: 42,
    });
    expect(JSON.parse(String(audit?.params[10]))).toMatchObject({
      retiredAt: { from: null, to: '2026-05-25T10:00:00.000Z' },
      retiredByUserId: { from: null, to: 42 },
    });
    expect(JSON.parse(String(audit?.params[11]))).toMatchObject({
      reason: 'Exception cleared',
    });
  });

  it('does not retire overrides from a different order', async () => {
    const database = createDatabase({ emptyRetireUpdate: true });
    const repository = new PgDeadlineRepository(database.client);

    await expect(
      repository.retireOrderOverride({
        currentUser: currentUser(),
        requestId: 'req-remove-mismatch',
        orderId: 999,
        overrideId: 'override-action',
        reason: 'Wrong order',
        audit: {
          event: 'deadline.order_override_removed',
          source: 'admin-ui',
          actorUserId: 42,
          requestId: 'req-remove-mismatch',
          timerRuleId: null,
          actionRuleId: 'rule-change-status',
          orderId: 999,
          before: {},
          after: {},
          diff: {},
          reason: 'Wrong order',
          comment: null,
          executionEvidence: null,
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'DEADLINE_ORDER_OVERRIDE_NOT_FOUND',
    });

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).toContain('override_id = $1 AND order_id = $2');
    expect(sql).not.toContain('INSERT INTO audit_log');
  });

  it('validates current deadline event context for preview without side effects', async () => {
    const currentDatabase = createDatabase({ currentDeadlineEvent: true });
    const staleDatabase = createDatabase({ currentDeadlineEvent: false });

    await expect(
      new PgDeadlineRepository(currentDatabase.client).isDeadlineEventCurrentForOrder({
        orderId: 100,
        deadlineId: '11111111-1111-4111-8111-111111111111',
        deadlineEventId: '22222222-2222-4222-8222-222222222222',
      }),
    ).resolves.toBe(true);
    await expect(
      new PgDeadlineRepository(staleDatabase.client).isDeadlineEventCurrentForOrder({
        orderId: 100,
        deadlineId: '11111111-1111-4111-8111-111111111111',
        deadlineEventId: '22222222-2222-4222-8222-222222222222',
      }),
    ).resolves.toBe(false);

    const sql = currentDatabase.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).toContain('FROM deadline_events e');
    expect(sql).toContain('JOIN deadline_instances d');
    expect(sql).toContain("e.event_type = 'DEADLINE_EXPIRED'");
    expect(sql).toContain('e.deadline_event_id = $2');
    expect(sql).toContain('d.deadline_id = $3');
    expect(sql).toContain('ORDER BY latest.event_at DESC, latest.created_at DESC');
    expect(sql).not.toContain('INSERT INTO deadline_action_executions');
  });

  it('rejects non-expired or older deadline event contexts for preview as stale', async () => {
    const database = createDatabase({ currentDeadlineEvent: false });
    const repository = new PgDeadlineRepository(database.client);

    await expect(
      repository.isDeadlineEventCurrentForOrder({
        orderId: 100,
        deadlineId: '11111111-1111-4111-8111-111111111111',
        deadlineEventId: 'older-or-non-expired-event',
      }),
    ).resolves.toBe(false);

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).toContain("latest.event_type = 'DEADLINE_EXPIRED'");
    expect(sql).toContain('e.deadline_event_id = ( SELECT latest.deadline_event_id');
  });

  it('lists and updates global transition rules with config conditions and audit reason', async () => {
    const database = createDatabase();
    const repository = new PgDeadlineRepository(database.client);

    await expect(repository.listGlobalTransitionRules()).resolves.toMatchObject([
      {
        actionRuleId: 'rule-change-status',
        actionType: 'change_order_status',
      },
    ]);

    await expect(
      repository.updateGlobalTransitionRule({
        currentUser: currentUser(),
        requestId: 'req-transition-rule',
        actionRuleId: 'rule-change-status',
        dto: {
          enabled: true,
          priority: 5,
          eventType: 'DEADLINE_EXPIRED',
          actionType: 'change_order_status',
          targetOrderStatusId: 7,
          allowedFromOrderStatusIds: [1, 2],
          excludeOrderStatusIds: [8],
          excludeCompletedOrders: true,
          requireCurrentDeadlineEvent: true,
          reason: 'Escalate overdue orders',
        },
        audit: {
          event: 'deadline.action_rule_updated',
          source: 'admin-ui',
          actorUserId: 42,
          requestId: 'req-transition-rule',
          timerRuleId: null,
          actionRuleId: 'rule-change-status',
          orderId: null,
          before: {},
          after: { priority: 5 },
          diff: { priority: { from: 50, to: 5 } },
          reason: 'Escalate overdue orders',
          comment: null,
          executionEvidence: null,
        },
      }),
    ).resolves.toMatchObject({
      actionRuleId: 'rule-change-status',
      priority: 5,
      config: {
        conditions: {
          allowedFromOrderStatusIds: [1, 2],
          excludeOrderStatusIds: [8],
          excludeCompletedOrders: true,
          requireCurrentDeadlineEvent: true,
        },
        actionConfig: { targetOrderStatusId: 7 },
      },
    });

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).toContain("scope_type = 'order'");
    expect(sql).toContain("event_type = 'DEADLINE_EXPIRED'");
    expect(sql).toContain("action_type = 'change_order_status'");
    expect(sql).toContain("config_json->'scope'->>'type' = 'global_orders'");
    expect(sql).toContain('UPDATE deadline_action_rules');
    expect(sql).toContain('config_json = $4::jsonb');

    const update = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('UPDATE deadline_action_rules'),
    );
    expect(JSON.parse(String(update?.params[3]))).toMatchObject({
      scope: { type: 'global_orders' },
      conditions: {
        allowedFromOrderStatusIds: [1, 2],
        excludeOrderStatusIds: [8],
        excludeCompletedOrders: true,
        requireCurrentDeadlineEvent: true,
      },
      actionConfig: { targetOrderStatusId: 7 },
    });
  });

  it('audits global transition rule enable transitions with enabled event', async () => {
    const database = createDatabase({ actionRuleEnabled: false });
    const repository = new PgDeadlineRepository(database.client);

    await repository.updateGlobalTransitionRule({
      currentUser: currentUser(),
      requestId: 'req-transition-enable',
      actionRuleId: 'rule-change-status',
      dto: {
        enabled: true,
        reason: 'Enable expired order escalation',
      },
      audit: {
        event: 'deadline.action_rule_updated',
        source: 'admin-ui',
        actorUserId: 42,
        requestId: 'req-transition-enable',
        timerRuleId: null,
        actionRuleId: 'rule-change-status',
        orderId: null,
        before: {},
        after: {},
        diff: {},
        reason: 'Enable expired order escalation',
        comment: null,
        executionEvidence: null,
      },
    });

    const audit = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO audit_log'),
    );
    expect(audit?.params[0]).toBe('deadline.action_rule_enabled');
    expect(JSON.parse(String(audit?.params[8]))).toMatchObject({ isEnabled: false });
    expect(JSON.parse(String(audit?.params[9]))).toMatchObject({ isEnabled: true });
  });

  it('audits global transition rule disable transitions with disabled event', async () => {
    const database = createDatabase({ actionRuleEnabled: true });
    const repository = new PgDeadlineRepository(database.client);

    await repository.updateGlobalTransitionRule({
      currentUser: currentUser(),
      requestId: 'req-transition-disable',
      actionRuleId: 'rule-change-status',
      dto: {
        enabled: false,
        reason: 'Disable expired order escalation',
      },
      audit: {
        event: 'deadline.action_rule_updated',
        source: 'admin-ui',
        actorUserId: 42,
        requestId: 'req-transition-disable',
        timerRuleId: null,
        actionRuleId: 'rule-change-status',
        orderId: null,
        before: {},
        after: {},
        diff: {},
        reason: 'Disable expired order escalation',
        comment: null,
        executionEvidence: null,
      },
    });

    const audit = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO audit_log'),
    );
    expect(audit?.params[0]).toBe('deadline.action_rule_disabled');
    expect(JSON.parse(String(audit?.params[8]))).toMatchObject({ isEnabled: true });
    expect(JSON.parse(String(audit?.params[9]))).toMatchObject({ isEnabled: false });
  });

  it('loads order evaluation context without mutating preview side effects', async () => {
    const database = createDatabase();
    const repository = new PgDeadlineRepository(database.client);

    await expect(repository.getOrderDeadlineEvaluationContext(100)).resolves.toEqual({
      orderId: 100,
      orderStatusId: 1,
      isCompleted: false,
    });

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).toContain('SELECT order_id, order_status_id');
    expect(sql).not.toContain('INSERT INTO deadline_action_executions');
  });

  it('returns null order evaluation context for missing or soft-deleted orders', async () => {
    const missingDatabase = createDatabase({ orderEvaluationRows: [] });
    const deletedDatabase = createDatabase({
      orderEvaluationRows: [
        {
          order_id: 100,
          order_status_id: 1,
          completion_date: null,
          issue_date: null,
        },
      ],
    });

    await expect(
      new PgDeadlineRepository(missingDatabase.client).getOrderDeadlineEvaluationContext(100),
    ).resolves.toBeNull();
    await expect(
      new PgDeadlineRepository(deletedDatabase.client).getOrderDeadlineEvaluationContext(100),
    ).resolves.toEqual({
      orderId: 100,
      orderStatusId: 1,
      isCompleted: false,
    });

    const sql = missingDatabase.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).toContain('COALESCE(delete_flag, false) = false');
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
    currentDeadlineEvent?: boolean;
    actionRuleEnabled?: boolean;
    emptyRetireUpdate?: boolean;
    existingOverride?: OrderOverrideTestRow;
    noExistingOverride?: boolean;
    emptyOverrideSupersedeUpdate?: boolean;
    emptyPauseUpdate?: boolean;
    emptyResumeUpdate?: boolean;
    orderEvaluationRows?: Array<{
      order_id: string | number;
      order_status_id: string | number;
      completion_date: string | Date | null;
      issue_date: string | Date | null;
    }>;
  } = {},
) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  const insertedEventIdempotencyKeys = new Set<string>();
  let overrideReplacementCreated = false;
  let originalSupersededByOverride = false;
  let notifyAssigneeEnabled = false;
  const client = {
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });

      if (text.includes('COUNT(*)::int')) {
        return { rows: [{ total: 1 }] };
      }

      if (text.includes('FROM deadline_action_rules') && text.includes('GROUP BY action_type')) {
        return {
          rows: [
            { action_type: 'notify_assignee', is_enabled: notifyAssigneeEnabled },
          ],
        };
      }

      if (text.includes('SELECT action_rule_id') && text.includes('FROM deadline_action_rules')) {
        return { rows: [{ action_rule_id: 'rule-notify-assignee' }] };
      }

      if (
        text.includes('SELECT') &&
        text.includes('FROM deadline_action_rules') &&
        text.includes("action_type = 'change_order_status'")
      ) {
        return { rows: [actionRuleRow({
          action_rule_id: 'rule-change-status',
          action_type: 'change_order_status',
          is_enabled: options.actionRuleEnabled ?? true,
          priority: 50,
          config_json: {
            scope: { type: 'global_orders' },
            conditions: { allowedFromOrderStatusIds: [1] },
            actionConfig: { targetOrderStatusId: 5 },
          },
        })] };
      }

      if (
        text.includes('SELECT') &&
        text.includes('FROM deadline_action_rules') &&
        text.includes('ORDER BY priority ASC')
      ) {
        return { rows: [actionRuleRow()] };
      }

      if (text.includes('UPDATE deadline_action_rules')) {
        if (text.includes('RETURNING')) {
          return {
            rows: [
              actionRuleRow({
                action_rule_id: String(params[0]),
                action_type: 'change_order_status',
                is_enabled: Boolean(params[1]),
                priority: params[2] as number,
                config_json:
                  typeof params[3] === 'string'
                    ? (JSON.parse(params[3]) as Record<string, unknown>)
                    : {},
              }),
            ],
          };
        }
        if (params[0] === 'rule-notify-assignee') {
          notifyAssigneeEnabled = Boolean(params[1]);
        }
        return { rows: [] };
      }

      if (text.includes('RETURNING') && text.includes('INSERT INTO deadline_order_overrides')) {
        return { rows: [orderOverrideRow({
          order_id: params[0] as number,
          policy_id: null,
          action_rule_id: String(params[1]),
          is_disabled: Boolean(params[2]),
          override_config_json:
            typeof params[3] === 'string'
              ? (JSON.parse(params[3]) as Record<string, unknown>)
              : {},
          reason: String(params[4]),
          updated_by_user_id: params[5] as number,
          created_by_user_id: params[5] as number,
        })] };
      }

      if (text.includes('RETURNING') && text.includes('UPDATE deadline_order_overrides')) {
        if (options.emptyRetireUpdate) {
          return { rows: [] };
        }
        return { rows: [orderOverrideRow({
          override_id: String(params[0]),
          order_id: params[1] as number,
          retired_by_user_id: params[2] as number,
          retired_at: new Date('2026-05-25T10:00:00.000Z'),
        })] };
      }

      if (text.includes('SELECT') && text.includes('FROM deadline_order_overrides')) {
        if (options.noExistingOverride) {
          return { rows: [] };
        }
        return { rows: [options.existingOverride ?? orderOverrideRow()] };
      }

      if (text.includes('FROM deadline_events e') && text.includes('JOIN deadline_instances d')) {
        return { rows: options.currentDeadlineEvent === false ? [] : [{ exists: true }] };
      }

      if (text.includes('SELECT order_id, order_status_id') && text.includes('FROM orders')) {
        return {
          rows: options.orderEvaluationRows ?? [
            {
              order_id: params[0],
              order_status_id: 1,
              completion_date: null,
              issue_date: null,
            },
          ],
        };
      }

      if (text.includes('SELECT') && text.includes('FROM deadline_policies') && text.includes('policy_id = $1')) {
        return { rows: [policyRow()] };
      }

      if (text.includes('RETURNING') && text.includes('INSERT INTO deadline_policies')) {
        return {
          rows: [
            policyRow({
              policy_code: String(params[0]),
              policy_name: String(params[1]),
              scope_type: String(params[2]),
              target_type: (params[3] as string | null | undefined) ?? null,
              target_code: (params[4] as string | null | undefined) ?? null,
              duration_value: (params[5] as number | null | undefined) ?? null,
              duration_unit: (params[6] as string | null | undefined) ?? null,
              start_point: (params[7] as string | null | undefined) ?? null,
              is_enabled: Boolean(params[8]),
            }),
          ],
        };
      }

      if (text.includes('RETURNING') && text.includes('UPDATE deadline_policies')) {
        return {
          rows: [
            policyRow({
              policy_id: String(params[0]),
              policy_name: String(params[1]),
              target_type: (params[2] as string | null | undefined) ?? null,
              target_code: (params[3] as string | null | undefined) ?? null,
              duration_value: (params[4] as number | null | undefined) ?? null,
              duration_unit: (params[5] as string | null | undefined) ?? null,
              start_point: (params[6] as string | null | undefined) ?? null,
              is_enabled: Boolean(params[7]),
            }),
          ],
        };
      }

      if (text.includes('MAX(version_number)')) {
        return { rows: [{ next_version: 3 }] };
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
        return { rows: [executionRow(params)] };
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
        if (originalSupersededByOverride) {
          return { rows: [] };
        }
        originalSupersededByOverride = true;
        return {
          rows: [
            deadlineRow({
              status: 'superseded',
            }),
          ],
        };
      }

      if (
        text.includes('SELECT') &&
        text.includes('FROM deadline_instances') &&
        text.includes('idempotency_key = $1')
      ) {
        return {
          rows: overrideReplacementCreated ? [overrideReplacementRow()] : [],
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
        text.includes("$11::timestamptz, 'active', 'manual', true")
      ) {
        overrideReplacementCreated = true;
        return {
          rows: [overrideReplacementRow()],
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
type PolicyTestRow = ReturnType<typeof basePolicyRow>;
type ActionRuleTestRow = ReturnType<typeof baseActionRuleRow>;
type OrderOverrideTestRow = ReturnType<typeof baseOrderOverrideRow>;

function deadlineRow(overrides: Partial<DeadlineTestRow> = {}) {
  return {
    ...baseDeadlineRow(),
    ...overrides,
  };
}

function policyRow(overrides: Partial<PolicyTestRow> = {}) {
  return {
    ...basePolicyRow(),
    ...overrides,
  };
}

function actionRuleRow(overrides: Partial<ActionRuleTestRow> = {}) {
  return {
    ...baseActionRuleRow(),
    ...overrides,
  };
}

function orderOverrideRow(overrides: Partial<OrderOverrideTestRow> = {}) {
  return {
    ...baseOrderOverrideRow(),
    ...overrides,
  };
}

function overrideReplacementRow(overrides: Partial<DeadlineTestRow> = {}) {
  return deadlineRow({
    deadline_id: '44444444-4444-4444-8444-444444444444',
    deadline_at: new Date('2026-05-03T10:00:00.000Z'),
    is_manually_overridden: true,
    metadata_json: {
      label: 'Manual',
      overrideBatch: 'manual-1',
      overrideReason: 'Manual correction',
      overriddenDeadlineId: '11111111-1111-4111-8111-111111111111',
    },
    idempotency_key: 'deadline-override:11111111-1111-4111-8111-111111111111:req-override-1',
    ...overrides,
  });
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

function basePolicyRow() {
  return {
    policy_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    policy_code: 'order.final',
    policy_name: 'Final order deadline',
    scope_type: 'order',
    target_type: null,
    target_code: null,
    duration_value: 10,
    duration_unit: 'working_day',
    start_point: null,
    is_enabled: true,
    created_at: new Date('2026-05-01T10:00:00.000Z'),
    updated_at: new Date('2026-05-01T10:00:00.000Z'),
  };
}

function baseActionRuleRow() {
  return {
    action_rule_id: 'rule-notify-assignee',
    policy_id: null,
    scope_type: 'order',
    event_type: 'DEADLINE_EXPIRED',
    action_type: 'notify_assignee',
    is_enabled: true,
    priority: 50,
    config_json: {},
    created_at: new Date('2026-05-01T10:00:00.000Z'),
    updated_at: new Date('2026-05-01T10:00:00.000Z'),
  };
}

function baseOrderOverrideRow() {
  return {
    override_id: 'override-action',
    order_id: 100,
    policy_id: null,
    action_rule_id: 'rule-change-status',
    is_disabled: true,
    override_config_json: {},
    reason: 'Customer approved exception',
    created_by_user_id: 42,
    updated_by_user_id: 42,
    retired_by_user_id: null,
    retired_at: null,
    created_at: new Date('2026-05-25T10:00:00.000Z'),
    updated_at: new Date('2026-05-25T10:00:00.000Z'),
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

function executionRow(params: readonly unknown[] = []) {
  return {
    action_execution_id: '33333333-3333-4333-8333-333333333333',
    deadline_event_id: String(params[0] ?? '22222222-2222-4222-8222-222222222222'),
    action_rule_id: (params[1] as string | null | undefined) ?? null,
    action_type: String(params[2] ?? 'write_audit'),
    target_type: (params[3] as string | null | undefined) ?? 'order',
    target_id: (params[4] as string | null | undefined) ?? '100',
    status: (params[5] as 'executed' | 'skipped' | 'failed' | undefined) ?? 'executed',
    idempotency_key: String(params[6] ?? 'event:write_audit:order:100'),
    skip_reason: (params[7] as string | null | undefined) ?? null,
    error_code: (params[8] as string | null | undefined) ?? null,
    error_message: (params[9] as string | null | undefined) ?? null,
    result_json:
      typeof params[10] === 'string'
        ? (JSON.parse(params[10]) as Record<string, unknown>)
        : {},
    rule_config_snapshot_json:
      typeof params[11] === 'string'
        ? (JSON.parse(params[11]) as Record<string, unknown>)
        : {},
    rule_version_id: (params[12] as string | null | undefined) ?? null,
    order_id: (params[13] as number | null | undefined) ?? null,
    target_status_id: (params[14] as number | null | undefined) ?? null,
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
