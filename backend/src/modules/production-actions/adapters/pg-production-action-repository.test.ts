import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole, type PermissionName } from '../../../permissions/permissions';
import {
  PgProductionActionRepository,
  loadOrderAssignedUserIds,
} from './pg-production-action-repository';

describe('PgProductionActionRepository', () => {
  it('moves calendar date with idempotency, audit, outbox, and deadline sync boundary', async () => {
    const database = createDatabase();
    const repository = new PgProductionActionRepository(database.service);

    const result = await repository.moveCalendarDate({
      currentUser: currentUser(),
      orderId: 15,
      dto: {
        plannedCompletionDate: '2026-05-20',
        version: 3,
        idempotencyKey: 'move-key-1',
      },
      requestId: 'request-1',
    });

    expect(result).toMatchObject({
      order: { orderId: 15, plannedCompletionDate: '2026-05-20', version: 4 },
      auditId: 'audit-id-1',
      requestId: 'request-1',
    });
    const sql = normalizedSql(database.queries);
    expect(sql).toContain('SELECT set_session_user($1)');
    expect(sql).toContain('INSERT INTO command_idempotency_keys');
    expect(sql).toContain('FROM orders WHERE order_id = $1 AND delete_flag = false FOR UPDATE');
    expect(sql).toContain('UPDATE orders SET planned_completion_date = $2, version = version + 1');
    expect(sql).toContain('INSERT INTO audit_log');
    expect(sql).toContain('INSERT INTO outbox_events');
    expect(JSON.stringify(database.queries.map((query) => query.params))).toContain(
      'deadline.order_sync_requested',
    );
    expect(sql.indexOf('deadline.order_sync_requested')).toBe(-1);
    expect(sql).toContain('UPDATE command_idempotency_keys SET status =');
  });

  it('returns stored idempotent response only for the same versioned request', async () => {
    const database = createDatabase({
      idempotencyExistingRequestHash: hashStable({
        actorUserId: '1',
        commandName: 'orders.calendar_move',
        orderId: 15,
        plannedCompletionDate: '2026-05-20',
        version: 3,
      }),
      idempotencyCompletedResponse: {
        order: { orderId: 15, plannedCompletionDate: '2026-05-20', version: 4 },
        requestId: 'request-1',
      },
    });
    const repository = new PgProductionActionRepository(database.service);

    await expect(
      repository.moveCalendarDate({
        currentUser: currentUser(),
        orderId: 15,
        dto: {
          plannedCompletionDate: '2026-05-20',
          version: 3,
          idempotencyKey: 'move-key-1',
        },
        requestId: 'request-1',
      }),
    ).resolves.toMatchObject({
      order: { orderId: 15, version: 4 },
    });
    expect(normalizedSql(database.queries)).not.toContain('FROM orders WHERE order_id');
  });

  it('rejects a reused production status idempotency key with a different version', async () => {
    const database = createDatabase({
      idempotencyExistingRequestHash: hashStable({
        actorUserId: '1',
        commandName: 'orders.production_status_change',
        orderId: 15,
        productionStatusId: 2,
        version: 3,
      }),
      idempotencyCompletedResponse: {
        order: { orderId: 15, productionStatusId: 2, version: 4 },
        requestId: 'request-production-status',
      },
    });
    const repository = new PgProductionActionRepository(database.service);

    await expect(
      repository.changeProductionStatus({
        currentUser: currentUser(),
        orderId: 15,
        dto: { productionStatusId: 2, version: 999, idempotencyKey: 'production-status-key-1' },
        requestId: 'request-production-status',
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(normalizedSql(database.queries)).not.toContain('FROM orders WHERE order_id');
  });

  it('rejects stale versions after idempotency reservation and before mutation', async () => {
    const database = createDatabase({ orderVersion: 5 });
    const repository = new PgProductionActionRepository(database.service);

    await expect(
      repository.changeOrderStatus({
        currentUser: currentUser(),
        orderId: 15,
        dto: { orderStatusId: 7, version: 3, idempotencyKey: 'status-key-1' },
        requestId: 'request-2',
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'VERSION_CONFLICT',
    });
    const sql = normalizedSql(database.queries);
    expect(sql).toContain('INSERT INTO command_idempotency_keys');
    expect(sql).not.toContain('UPDATE orders SET order_status_id');
  });

  it('activates a production stage with event, order version, audit, and outbox', async () => {
    const database = createDatabase({ existingProductionEventId: null });
    const repository = new PgProductionActionRepository(database.service);

    const result = await repository.activateProductionStage({
      currentUser: currentUser(),
      orderId: 15,
      productionStatusId: 4,
      dto: { version: 3, idempotencyKey: 'stage-on-key-1' },
      requestId: 'request-3',
    });

    expect(result).toMatchObject({
      order: { orderId: 15, version: 4 },
      event: { productionEventId: 42, productionStatusId: 4, active: true },
    });
    const sql = normalizedSql(database.queries);
    expect(sql).toContain('INSERT INTO production_status_events');
    expect(sql).toContain('UPDATE orders SET version = version + 1');
    expect(sql).toContain('INSERT INTO audit_log');
    expect(JSON.stringify(database.queries.map((query) => query.params))).toContain(
      'production.stage_activated',
    );
  });

  it('denies manager actions outside own order scope before mutation', async () => {
    const database = createDatabase({ orderCreatedByUserId: 1, orderManagerUserId: null });
    const repository = new PgProductionActionRepository(database.service);

    await expect(
      repository.changeOrderStatus({
        currentUser: currentUser('manager', '99'),
        orderId: 15,
        dto: { orderStatusId: 7, version: 3, idempotencyKey: 'status-key-2' },
        requestId: 'request-denied',
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    });
    expect(normalizedSql(database.queries)).not.toContain('UPDATE orders SET order_status_id');
  });

  it('audits denied sensitive production actions before mutation', async () => {
    const database = createDatabase({ orderCreatedByUserId: 1, orderManagerUserId: null });
    const repository = new PgProductionActionRepository(database.service);

    await expect(
      repository.changeOrderStatus({
        currentUser: currentUser('manager', '99'),
        orderId: 15,
        dto: { orderStatusId: 7, version: 3, idempotencyKey: 'status-key-denied-audit' },
        requestId: 'request-denied-audit',
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    });

    const audit = database.queries.find((query) => query.text.includes('INSERT INTO audit_log'));
    expect(audit?.params[0]).toBe('production.action_denied');
    expect(audit?.params[1]).toBe('order');
    expect(audit?.params[2]).toBe('15');
    expect(audit?.params[3]).toBe('99');
    // params[4]=username, params[5]=role_code (shared AUDIT_INSERT layout)
    expect(audit?.params[4]).toBe('manager');
    expect(audit?.params[5]).toBe('manager');
    expect(audit?.params[6]).toBe('request-denied-audit');
    expect(audit?.params[7]).toBe('backend-production-command');
    expect(audit?.params[22]).toBe(
      JSON.stringify({
        source: 'backend-production-command',
        denied: true,
        reason: 'order_scope_denied',
        requiredPermissions: ['orders.update', 'orders.change_status'],
      }),
    );
    expect(normalizedSql(database.queries)).not.toContain('UPDATE orders SET order_status_id');
  });

  it('allows manager order status change inside own order scope', async () => {
    const database = createDatabase({ orderCreatedByUserId: 1, orderManagerUserId: 99 });
    const repository = new PgProductionActionRepository(database.service);

    await expect(
      repository.changeOrderStatus({
        currentUser: currentUser('manager', '99'),
        orderId: 15,
        dto: { orderStatusId: 7, version: 3, idempotencyKey: 'status-key-manager' },
        requestId: 'request-manager',
      }),
    ).resolves.toMatchObject({
      order: { orderId: 15, orderStatusId: 7, version: 4 },
    });

    expect(normalizedSql(database.queries)).toContain('UPDATE orders SET order_status_id');
  });

  it('changes order status from deadline-engine without client version or user permission path', async () => {
    const database = createDatabase();
    const repository = new PgProductionActionRepository(database.service);

    const result = await repository.changeOrderStatusFromDeadline({
      source: 'deadline-engine',
      systemActor: {
        type: 'system',
        actorUserId: null,
        actorLabel: 'deadline-engine',
      },
      orderId: 15,
      targetOrderStatusId: 7,
      deadlineId: 'deadline-1',
      deadlineEventId: 'event-1',
      actionRuleId: 'rule-1',
      ruleVersionId: null,
      ruleConfigSnapshot: { snapshotHash: 'sha256:rule-1', actionRuleId: 'rule-1' },
      idempotencyKey: 'deadline-status-key-1',
      requestId: 'request-deadline-status',
      occurredAt: '2026-05-25T10:00:00.000Z',
    });

    expect(result).toMatchObject({
      status: 'executed',
      response: {
        order: { orderId: 15, orderStatusId: 7, version: 4 },
        auditId: 'audit-id-1',
        requestId: 'request-deadline-status',
      },
    });

    const sql = normalizedSql(database.queries);
    expect(sql).not.toContain('SELECT set_session_user($1)');
    expect(sql).not.toContain('VERSION_CONFLICT');
    expect(sql).toContain('FROM orders WHERE order_id = $1 AND delete_flag = false FOR UPDATE');
    expect(sql).toContain('SELECT order_status_id, order_status_name');
    expect(sql).toContain('UPDATE orders SET order_status_id');
    expect(sql).toContain('INSERT INTO audit_log');
    expect(sql).toContain('INSERT INTO outbox_events');

    const params = normalizedParams(database.queries);
    expect(params).toContain('orders.status_change');
    expect(params).toContain('order.status_changed');
    expect(params).toContain('deadline-engine');
    expect(params).toContain('deadline-1');
    expect(params).toContain('event-1');
    expect(params).toContain('rule-1');
    expect(params).toContain('sha256:rule-1');
    expect(params).toContain('deadline-status-key-1');

    const idempotencyInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO command_idempotency_keys'),
    );
    expect(idempotencyInsert?.params[2]).toBeNull();
  });

  it('returns skipped no-op for same status deadline command without mutation side effects', async () => {
    const database = createDatabase({ orderStatusId: 7 });
    const repository = new PgProductionActionRepository(database.service);

    await expect(
      repository.changeOrderStatusFromDeadline({
        source: 'deadline-engine',
        systemActor: {
          type: 'system',
          actorUserId: null,
          actorLabel: 'deadline-engine',
        },
        orderId: 15,
        targetOrderStatusId: 7,
        deadlineId: 'deadline-1',
        deadlineEventId: 'event-1',
        actionRuleId: 'rule-1',
        ruleVersionId: null,
        ruleConfigSnapshot: { snapshotHash: 'sha256:rule-1' },
        idempotencyKey: 'deadline-status-noop-key-1',
        requestId: 'request-deadline-status-noop',
        occurredAt: '2026-05-25T10:00:00.000Z',
      }),
    ).resolves.toMatchObject({
      status: 'skipped',
      skipReason: 'same_status',
      response: {
        order: { orderId: 15, orderStatusId: 7, version: 3 },
      },
    });

    const sql = normalizedSql(database.queries);
    expect(sql).not.toContain('UPDATE orders SET order_status_id');
    expect(sql).not.toContain('INSERT INTO audit_log');
    expect(sql).not.toContain('INSERT INTO outbox_events');
    expect(sql).toContain('UPDATE command_idempotency_keys SET status =');
  });

  it('replays same-status deadline idempotency as skipped instead of executed', async () => {
    const database = createDatabase({
      idempotencyExistingRequestHash: hashStable({
        actorUserId: null,
        actorLabel: 'deadline-engine',
        commandName: 'orders.status_change',
        source: 'deadline-engine',
        orderId: 15,
        orderStatusId: 7,
        deadlineId: 'deadline-1',
        deadlineEventId: 'event-1',
        actionRuleId: 'rule-1',
        ruleVersionId: null,
        snapshotHash: 'sha256:rule-1',
      }),
      idempotencyCompletedResponse: {
        order: { orderId: 15, orderStatusId: 7, version: 3 },
        requestId: 'request-deadline-status-noop',
        deadlineActionStatus: 'skipped',
        deadlineSkipReason: 'same_status',
      },
    });
    const repository = new PgProductionActionRepository(database.service);

    await expect(
      repository.changeOrderStatusFromDeadline({
        source: 'deadline-engine',
        systemActor: {
          type: 'system',
          actorUserId: null,
          actorLabel: 'deadline-engine',
        },
        orderId: 15,
        targetOrderStatusId: 7,
        deadlineId: 'deadline-1',
        deadlineEventId: 'event-1',
        actionRuleId: 'rule-1',
        ruleVersionId: null,
        ruleConfigSnapshot: { snapshotHash: 'sha256:rule-1' },
        idempotencyKey: 'deadline-status-noop-key-1',
        requestId: 'request-deadline-status-noop',
        occurredAt: '2026-05-25T10:00:00.000Z',
      }),
    ).resolves.toMatchObject({
      status: 'skipped',
      skipReason: 'same_status',
      response: {
        order: { orderId: 15, orderStatusId: 7, version: 3 },
      },
    });

    const sql = normalizedSql(database.queries);
    expect(sql).not.toContain('UPDATE orders SET order_status_id');
  });

  it('changes production status from deadline-engine through production command audit and outbox boundary', async () => {
    const database = createDatabase({
      orderProductionStatusId: 1,
      productionStatusFromDetailsEnabled: true,
      detailStatusRowsBefore: [
        { detail_id: 101, production_status_id: 1 },
        { detail_id: 102, production_status_id: 3 },
      ],
      detailStatusRowsAfter: [
        { detail_id: 101, production_status_id: 6 },
        { detail_id: 102, production_status_id: 6 },
      ],
    });
    const repository = new PgProductionActionRepository(database.service);

    const result = await repository.changeProductionStatusFromDeadline({
      source: 'deadline-engine',
      systemActor: {
        type: 'system',
        actorUserId: null,
        actorLabel: 'deadline-engine',
      },
      orderId: 15,
      targetProductionStatusId: 6,
      productionStatusScope: 'order',
      deadlineId: 'deadline-production-1',
      deadlineEventId: 'event-production-1',
      actionRuleId: 'rule-production-1',
      ruleVersionId: null,
      ruleConfigSnapshot: {
        snapshotHash: 'sha256:rule-production-1',
        actionRuleId: 'rule-production-1',
      },
      idempotencyKey: 'deadline-production-status-key-1',
      requestId: 'request-deadline-production-status',
      occurredAt: '2026-05-27T10:00:00.000Z',
    });

    expect(result).toMatchObject({
      status: 'executed',
      response: {
        order: { orderId: 15, productionStatusId: 6, version: 4 },
        auditId: 'audit-id-1',
        requestId: 'request-deadline-production-status',
      },
    });

    const sql = normalizedSql(database.queries);
    expect(sql).not.toContain('SELECT set_session_user($1)');
    expect(sql).toContain('SELECT production_status_id, production_status_name, production_status_code');
    expect(sql).toContain('SELECT detail_id, production_status_id FROM order_details');
    expect(sql).toContain('UPDATE orders SET production_status_id');
    expect(sql).toContain('INSERT INTO audit_log');
    expect(sql).toContain('INSERT INTO outbox_events');

    const params = normalizedParams(database.queries);
    expect(params).toContain('orders.production_status_change');
    expect(params).toContain('order.production_status_changed');
    expect(params).toContain('deadline-engine');
    expect(params).toContain('deadline-production-1');
    expect(params).toContain('event-production-1');
    expect(params).toContain('rule-production-1');
    expect(params).toContain('sha256:rule-production-1');
    expect(params).toContain('deadline-production-status-key-1');

    const idempotencyInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO command_idempotency_keys'),
    );
    expect(idempotencyInsert?.params[2]).toBeNull();
  });

  it('changes manual payment status with idempotency, audit, and outbox', async () => {
    const database = createDatabase();
    const repository = new PgProductionActionRepository(database.service);

    const result = await repository.changePaymentStatus({
      currentUser: currentUser(),
      orderId: 15,
      dto: { paymentStatusId: 3, version: 3, idempotencyKey: 'payment-status-key-1' },
      requestId: 'request-payment-status',
    });

    expect(result).toMatchObject({
      order: { orderId: 15, paymentStatusId: 3, version: 4 },
      auditId: 'audit-id-1',
      requestId: 'request-payment-status',
    });
    const sql = normalizedSql(database.queries);
    expect(sql).toContain('SELECT set_session_user($1)');
    expect(sql).toContain('INSERT INTO command_idempotency_keys');
    expect(sql).toContain('SELECT payment_status_id, payment_status_name');
    expect(sql).toContain('UPDATE orders SET payment_status_id');
    expect(sql).toContain('INSERT INTO audit_log');
    expect(JSON.stringify(database.queries.map((query) => query.params))).toContain(
      'order.payment_status_changed',
    );
    expect(sql).toContain('UPDATE command_idempotency_keys SET status =');
  });

  it('rejects manual payment status changes without finance visibility', async () => {
    const database = createDatabase();
    const repository = new PgProductionActionRepository(database.service);

    await expect(
      repository.changePaymentStatus({
        currentUser: userWithPermissions('viewer', ['orders.update', 'payments.update']),
        orderId: 15,
        dto: { paymentStatusId: 3, version: 3, idempotencyKey: 'payment-status-key-1' },
        requestId: 'request-payment-status',
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['orders.update', 'payments.update', 'orders.view_financials'] },
    });

    const sql = normalizedSql(database.queries);
    expect(sql).not.toContain('UPDATE orders SET payment_status_id');
    expect(sql).toContain('INSERT INTO audit_log');
  });

  it('changes manual production current status with idempotency, cascade metadata, audit, and outbox', async () => {
    const database = createDatabase({
      orderProductionStatusId: 1,
      productionStatusFromDetailsEnabled: false,
      detailStatusRowsBefore: [
        { detail_id: 101, production_status_id: 1 },
        { detail_id: 102, production_status_id: 3 },
      ],
      detailStatusRowsAfter: [
        { detail_id: 101, production_status_id: 2 },
        { detail_id: 102, production_status_id: 2 },
      ],
    });
    const repository = new PgProductionActionRepository(database.service);

    const result = await repository.changeProductionStatus({
      currentUser: currentUser(),
      orderId: 15,
      dto: { productionStatusId: 2, version: 3, idempotencyKey: 'production-status-key-1' },
      requestId: 'request-production-status',
    });

    expect(result).toMatchObject({
      order: { orderId: 15, productionStatusId: 2, version: 4 },
      auditId: 'audit-id-1',
      requestId: 'request-production-status',
    });
    const sql = normalizedSql(database.queries);
    expect(sql).toContain('SELECT set_session_user($1)');
    expect(sql).toContain('INSERT INTO command_idempotency_keys');
    expect(sql).toContain(
      'SELECT production_status_id, production_status_name, production_status_code',
    );
    expect(sql).toContain(
      'FROM order_details WHERE order_id = $1 AND COALESCE(delete_flag, false) = false ORDER BY detail_id FOR UPDATE',
    );
    expect(sql).toContain(
      'UPDATE orders SET production_status_id = $2, production_status_from_details_enabled = false, version = version + 1',
    );
    expect(sql).not.toContain('production_status_events');
    expect(sql).toContain('INSERT INTO audit_log');
    expect(sql).toContain('INSERT INTO outbox_events');
    const params = normalizedParams(database.queries);
    expect(params).toContain('orders.production_status_change');
    expect(params).toContain('order.production_status_changed');
    expect(params).toContain('"affectedDetailIds":[101,102]');
    expect(params).toContain('"affectedDetailCount":2');
    expect(params).toContain('"beforeStatusDistribution":{"1":1,"3":1}');
    expect(params).toContain('"afterStatusDistribution":{"2":2}');
    expect(sql).toContain('UPDATE command_idempotency_keys SET status =');
  });

  it('changes derived production current status by switching to manual mode with detail metadata', async () => {
    const database = createDatabase({
      orderProductionStatusId: 1,
      productionStatusFromDetailsEnabled: true,
      detailStatusRowsBefore: [
        { detail_id: 101, production_status_id: 1 },
        { detail_id: 102, production_status_id: 3 },
      ],
      detailStatusRowsAfter: [
        { detail_id: 101, production_status_id: 2 },
        { detail_id: 102, production_status_id: 2 },
      ],
    });
    const repository = new PgProductionActionRepository(database.service);

    const result = await repository.changeProductionStatus({
      currentUser: currentUser(),
      orderId: 15,
      dto: {
        productionStatusId: 2,
        version: 3,
        idempotencyKey: 'production-status-derived-key-1',
      },
      requestId: 'request-production-status-derived',
    });

    expect(result.order).toEqual({ orderId: 15, productionStatusId: 2, version: 4 });
    expect(result).toMatchObject({
      auditId: 'audit-id-1',
      requestId: 'request-production-status-derived',
    });
    const sql = normalizedSql(database.queries);
    expect(sql).toContain(
      'UPDATE orders SET production_status_id = $2, production_status_from_details_enabled = false, version = version + 1',
    );
    expect(sql).toContain('SELECT detail_id, production_status_id FROM order_details');
    expect(sql).toContain('INSERT INTO audit_log');
    expect(sql).toContain('INSERT INTO outbox_events');
    expect(sql).toContain('UPDATE command_idempotency_keys SET status =');
    const params = normalizedParams(database.queries);
    expect(params).toContain('orders.production_status_change');
    expect(params).toContain('order.production_status_changed');
    expect(params).toContain('"productionStatusFromDetailsEnabled":false');
    expect(params).toContain('"previousProductionStatusFromDetailsEnabled":true');
    expect(params).toContain('"affectedDetailIds":[101,102]');
    expect(params).toContain('"affectedDetailCount":2');
    expect(params).toContain('"beforeStatusDistribution":{"1":1,"3":1}');
    expect(params).toContain('"afterStatusDistribution":{"2":2}');
  });

  it('completes same manual production status command without duplicate audit or outbox', async () => {
    const database = createDatabase({
      orderProductionStatusId: 2,
      productionStatusFromDetailsEnabled: false,
    });
    const repository = new PgProductionActionRepository(database.service);

    const result = await repository.changeProductionStatus({
      currentUser: currentUser(),
      orderId: 15,
      dto: { productionStatusId: 2, version: 3, idempotencyKey: 'production-status-noop-key-1' },
      requestId: 'request-production-status-noop',
    });

    expect(result).toMatchObject({
      order: { orderId: 15, productionStatusId: 2, version: 3 },
      requestId: 'request-production-status-noop',
    });
    const sql = normalizedSql(database.queries);
    expect(sql).not.toContain('UPDATE orders SET production_status_id');
    expect(sql).not.toContain('INSERT INTO audit_log');
    expect(sql).not.toContain('INSERT INTO outbox_events');
    expect(sql).toContain('UPDATE command_idempotency_keys SET status =');
  });

  it('activates a detail production stage with detail lock, event, audit, and outbox', async () => {
    const database = createDatabase({ existingDetailProductionEventId: null });
    const repository = new PgProductionActionRepository(database.service);

    const result = await repository.activateDetailProductionStage({
      currentUser: currentUser(),
      detailId: 99,
      productionStatusId: 4,
      dto: { idempotencyKey: 'detail-stage-key-1', note: 'started cutting' },
      requestId: 'request-detail-stage',
    });

    expect(result).toMatchObject({
      order: { orderId: 15, version: 3 },
      event: { productionEventId: 42, productionStatusId: 4, active: true },
      auditId: 'audit-id-1',
      requestId: 'request-detail-stage',
    });
    const sql = normalizedSql(database.queries);
    expect(sql).toContain('SELECT set_session_user($1)');
    expect(sql).toContain('INSERT INTO command_idempotency_keys');
    expect(sql).toContain('FROM order_details od JOIN orders o ON o.order_id = od.order_id');
    expect(sql).toContain('o.production_status_id');
    expect(sql).toContain('o.production_status_from_details_enabled');
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toContain('INSERT INTO production_status_events');
    expect(sql).toContain('ON CONFLICT (detail_id, production_status_id) WHERE detail_id IS NOT NULL');
    expect(sql).not.toContain('UPDATE orders SET version = version + 1');
    expect(sql).toContain('INSERT INTO audit_log');
    const params = JSON.stringify(database.queries.map((query) => query.params));
    expect(params).toContain('production.detail_stage_activated');
    expect(params).toContain('order_detail');
    expect(params).toContain('detail-stage-key-1');
    expect(sql).toContain('UPDATE command_idempotency_keys SET status =');
  });

  // ─── restore-auto tests ──────────────────────────────────────────────────

  it('restore-auto happy path: sets flag=true, recalculates status, version bumps, audit+outbox emitted', async () => {
    // detail before: status 1 and 3; after recalc the order production_status_id becomes 5 (≠ pre-flip 1)
    const database = createDatabase({
      orderProductionStatusId: 1,
      productionStatusFromDetailsEnabled: false,
      detailStatusRowsBefore: [
        { detail_id: 101, production_status_id: 1 },
        { detail_id: 102, production_status_id: 3 },
      ],
      detailStatusRowsAfter: [
        { detail_id: 101, production_status_id: 1 },
        { detail_id: 102, production_status_id: 3 },
      ],
      recalcOrderProductionStatusId: 5,
    });
    const repository = new PgProductionActionRepository(database.service);

    const result = await repository.restoreAutoProductionStatus({
      currentUser: currentUser(),
      orderId: 15,
      dto: { version: 3, idempotencyKey: 'restore-auto-key-1' },
      requestId: 'request-restore-auto',
    });

    expect(result).toMatchObject({
      order: {
        orderId: 15,
        productionStatusId: 5,
        productionStatusFromDetailsEnabled: true,
        version: 4,
      },
      auditId: 'audit-id-1',
      requestId: 'request-restore-auto',
    });

    const sql = normalizedSql(database.queries);
    expect(sql).toContain('SELECT set_session_user($1)');
    expect(sql).toContain('INSERT INTO command_idempotency_keys');
    expect(sql).toContain('FROM orders WHERE order_id = $1 AND delete_flag = false FOR UPDATE');
    expect(sql).toContain('UPDATE orders SET production_status_from_details_enabled = true, version = version + 1');
    expect(sql).toContain('SELECT recalc_order_production_status($1)');
    expect(sql).toContain('SELECT production_status_id FROM orders WHERE order_id = $1');
    expect(sql).toContain('SELECT detail_id, production_status_id FROM order_details');
    expect(sql).toContain('INSERT INTO audit_log');
    expect(sql).toContain('INSERT INTO outbox_events');
    expect(sql).toContain('UPDATE command_idempotency_keys SET status =');

    const params = normalizedParams(database.queries);
    expect(params).toContain('orders.production_status_mode_restore');
    expect(params).toContain('order.production_status_mode_restored');
    // post-recalc statusId = 5 in audit afterJson
    expect(params).toContain('"productionStatusId":5');
    expect(params).toContain('"productionStatusFromDetailsEnabled":true');
    expect(params).toContain('"mode":"auto"');
    expect(params).toContain('"action":"production_status_mode_restore"');
  });

  it('restore-auto with null recalculated status: response productionStatusId undefined, no crash', async () => {
    const database = createDatabase({
      orderProductionStatusId: null,
      productionStatusFromDetailsEnabled: false,
      detailStatusRowsBefore: [],
      detailStatusRowsAfter: [],
      recalcOrderProductionStatusId: null,
    });
    const repository = new PgProductionActionRepository(database.service);

    const result = await repository.restoreAutoProductionStatus({
      currentUser: currentUser(),
      orderId: 15,
      dto: { version: 3, idempotencyKey: 'restore-auto-null-key-1' },
      requestId: 'request-restore-auto-null',
    });

    expect(result.order.productionStatusId).toBeUndefined();
    expect(result.order.productionStatusFromDetailsEnabled).toBe(true);
    expect(result.order.version).toBe(4);
    // audit and outbox still emitted
    const sql = normalizedSql(database.queries);
    expect(sql).toContain('INSERT INTO audit_log');
    expect(sql).toContain('INSERT INTO outbox_events');
  });

  it('restore-auto no-op (order already enabled=true): no version bump, no audit, no outbox', async () => {
    const database = createDatabase({
      orderProductionStatusId: 2,
      productionStatusFromDetailsEnabled: true,
    });
    const repository = new PgProductionActionRepository(database.service);

    const result = await repository.restoreAutoProductionStatus({
      currentUser: currentUser(),
      orderId: 15,
      dto: { version: 3, idempotencyKey: 'restore-auto-noop-key-1' },
      requestId: 'request-restore-auto-noop',
    });

    expect(result).toMatchObject({
      order: {
        orderId: 15,
        productionStatusId: 2,
        productionStatusFromDetailsEnabled: true,
        version: 3,
      },
      requestId: 'request-restore-auto-noop',
    });
    expect(result.auditId).toBeUndefined();

    const sql = normalizedSql(database.queries);
    expect(sql).not.toContain('UPDATE orders SET production_status_from_details_enabled = true');
    expect(sql).not.toContain('SELECT recalc_order_production_status');
    expect(sql).not.toContain('INSERT INTO audit_log');
    expect(sql).not.toContain('INSERT INTO outbox_events');
    expect(sql).toContain('UPDATE command_idempotency_keys SET status =');
  });

  // ─── enter-manual tests ──────────────────────────────────────────────────

  it('enter-manual happy path: sets flag=false, version bumps, detail diff in audit+outbox', async () => {
    const database = createDatabase({
      orderProductionStatusId: 3,
      productionStatusFromDetailsEnabled: true,
      detailStatusRowsBefore: [
        { detail_id: 101, production_status_id: 1 },
        { detail_id: 102, production_status_id: 3 },
      ],
      detailStatusRowsAfter: [
        { detail_id: 101, production_status_id: 3 },
        { detail_id: 102, production_status_id: 3 },
      ],
    });
    const repository = new PgProductionActionRepository(database.service);

    const result = await repository.enterManualProductionStatus({
      currentUser: currentUser(),
      orderId: 15,
      dto: { version: 3, idempotencyKey: 'enter-manual-key-1' },
      requestId: 'request-enter-manual',
    });

    expect(result).toMatchObject({
      order: {
        orderId: 15,
        productionStatusId: 3,
        productionStatusFromDetailsEnabled: false,
        version: 4,
      },
      auditId: 'audit-id-1',
      requestId: 'request-enter-manual',
    });

    const sql = normalizedSql(database.queries);
    expect(sql).toContain('UPDATE orders SET production_status_from_details_enabled = false, version = version + 1');
    expect(sql).not.toContain('SELECT recalc_order_production_status');
    expect(sql).toContain('SELECT detail_id, production_status_id FROM order_details');
    expect(sql).toContain('INSERT INTO audit_log');
    expect(sql).toContain('INSERT INTO outbox_events');
    expect(sql).toContain('UPDATE command_idempotency_keys SET status =');

    const params = normalizedParams(database.queries);
    expect(params).toContain('orders.production_status_mode_manual');
    expect(params).toContain('order.production_status_mode_set_manual');
    expect(params).toContain('"productionStatusFromDetailsEnabled":false');
    expect(params).toContain('"mode":"manual"');
    expect(params).toContain('"action":"production_status_mode_manual"');
    // detail 101 changed from 1 to 3 → affectedDetailIds=[101]
    expect(params).toContain('"affectedDetailIds":[101]');
    expect(params).toContain('"affectedDetailCount":1');
  });

  it('enter-manual no-op (already false): no version bump, no audit, no outbox', async () => {
    const database = createDatabase({
      orderProductionStatusId: 3,
      productionStatusFromDetailsEnabled: false,
    });
    const repository = new PgProductionActionRepository(database.service);

    const result = await repository.enterManualProductionStatus({
      currentUser: currentUser(),
      orderId: 15,
      dto: { version: 3, idempotencyKey: 'enter-manual-noop-key-1' },
      requestId: 'request-enter-manual-noop',
    });

    expect(result).toMatchObject({
      order: {
        orderId: 15,
        productionStatusId: 3,
        productionStatusFromDetailsEnabled: false,
        version: 3,
      },
      requestId: 'request-enter-manual-noop',
    });
    expect(result.auditId).toBeUndefined();

    const sql = normalizedSql(database.queries);
    expect(sql).not.toContain('UPDATE orders SET production_status_from_details_enabled = false');
    expect(sql).not.toContain('INSERT INTO audit_log');
    expect(sql).not.toContain('INSERT INTO outbox_events');
    expect(sql).toContain('UPDATE command_idempotency_keys SET status =');
  });

  // ─── shared: version conflict, idempotency, scope denied ─────────────────

  it('restore-auto: version conflict → VERSION_CONFLICT 409', async () => {
    const database = createDatabase({ orderVersion: 5, productionStatusFromDetailsEnabled: false });
    const repository = new PgProductionActionRepository(database.service);

    await expect(
      repository.restoreAutoProductionStatus({
        currentUser: currentUser(),
        orderId: 15,
        dto: { version: 3, idempotencyKey: 'restore-auto-vc-key-1' },
        requestId: 'request-restore-auto-vc',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'VERSION_CONFLICT' });

    const sql = normalizedSql(database.queries);
    expect(sql).not.toContain('UPDATE orders SET production_status_from_details_enabled = true');
  });

  it('enter-manual: version conflict → VERSION_CONFLICT 409', async () => {
    const database = createDatabase({ orderVersion: 5, productionStatusFromDetailsEnabled: true });
    const repository = new PgProductionActionRepository(database.service);

    await expect(
      repository.enterManualProductionStatus({
        currentUser: currentUser(),
        orderId: 15,
        dto: { version: 3, idempotencyKey: 'enter-manual-vc-key-1' },
        requestId: 'request-enter-manual-vc',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'VERSION_CONFLICT' });

    const sql = normalizedSql(database.queries);
    expect(sql).not.toContain('UPDATE orders SET production_status_from_details_enabled = false');
  });

  it('restore-auto: idempotency replay returns stored response', async () => {
    const database = createDatabase({
      productionStatusFromDetailsEnabled: false,
      idempotencyExistingRequestHash: hashStable({
        actorUserId: '1',
        commandName: 'orders.production_status_mode_restore',
        orderId: 15,
        version: 3,
      }),
      idempotencyCompletedResponse: {
        order: {
          orderId: 15,
          productionStatusId: 5,
          productionStatusFromDetailsEnabled: true,
          version: 4,
        },
        requestId: 'request-restore-auto-replay',
      },
    });
    const repository = new PgProductionActionRepository(database.service);

    const result = await repository.restoreAutoProductionStatus({
      currentUser: currentUser(),
      orderId: 15,
      dto: { version: 3, idempotencyKey: 'restore-auto-replay-key' },
      requestId: 'request-restore-auto-replay',
    });

    expect(result.order.productionStatusId).toBe(5);
    expect(result.order.version).toBe(4);
    expect(normalizedSql(database.queries)).not.toContain('FROM orders WHERE order_id');
  });

  it('restore-auto: reused idempotency key with different version → IDEMPOTENCY_KEY_REUSED', async () => {
    const database = createDatabase({
      productionStatusFromDetailsEnabled: false,
      idempotencyExistingRequestHash: hashStable({
        actorUserId: '1',
        commandName: 'orders.production_status_mode_restore',
        orderId: 15,
        version: 3,
      }),
      idempotencyCompletedResponse: {
        order: { orderId: 15, version: 4 },
        requestId: 'request-restore-auto-replay',
      },
    });
    const repository = new PgProductionActionRepository(database.service);

    await expect(
      repository.restoreAutoProductionStatus({
        currentUser: currentUser(),
        orderId: 15,
        dto: { version: 999, idempotencyKey: 'restore-auto-reused-key' },
        requestId: 'request-restore-auto-reused',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('restore-auto: scope denied → writeDeniedActionAudit + 403', async () => {
    const database = createDatabase({
      orderCreatedByUserId: 1,
      orderManagerUserId: null,
      productionStatusFromDetailsEnabled: false,
    });
    const repository = new PgProductionActionRepository(database.service);

    await expect(
      repository.restoreAutoProductionStatus({
        currentUser: currentUser('manager', '99'),
        orderId: 15,
        dto: { version: 3, idempotencyKey: 'restore-auto-denied-key' },
        requestId: 'request-restore-auto-denied',
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });

    const audit = database.queries.find((q) => q.text.includes('INSERT INTO audit_log'));
    expect(audit?.params[0]).toBe('production.action_denied');
    expect(normalizedSql(database.queries)).not.toContain(
      'UPDATE orders SET production_status_from_details_enabled = true',
    );
  });

  it('completes duplicate detail production stage commands without duplicate outbox', async () => {
    const database = createDatabase({ existingDetailProductionEventId: 77 });
    const repository = new PgProductionActionRepository(database.service);

    const result = await repository.activateDetailProductionStage({
      currentUser: currentUser(),
      detailId: 99,
      productionStatusId: 4,
      dto: { idempotencyKey: 'detail-stage-duplicate-key-1' },
      requestId: 'request-detail-stage-duplicate',
    });

    expect(result).toMatchObject({
      order: { orderId: 15, version: 3 },
      event: { productionEventId: 77, productionStatusId: 4, active: true },
      requestId: 'request-detail-stage-duplicate',
    });
    const sql = normalizedSql(database.queries);
    expect(sql).not.toContain('INSERT INTO production_status_events');
    expect(sql).not.toContain('INSERT INTO outbox_events');
    expect(sql).not.toContain('INSERT INTO audit_log');
    expect(sql).toContain('UPDATE command_idempotency_keys SET status =');
  });
});

describe('loadOrderAssignedUserIds', () => {
  it('resolves responsible users and emits the soft-delete/inactive/null filters', async () => {
    const database = createDatabase({ assignedUserIds: [20, 77] });
    const ids = await database.service.transaction((tx) => loadOrderAssignedUserIds(tx, 15));
    expect(ids).toEqual(['20', '77']);

    const sql = normalizedSql(database.queries);
    expect(sql).toContain('SELECT DISTINCT u.user_id');
    expect(sql).toContain('JOIN users u ON u.employee_id = ow.responsible_employee_id');
    expect(sql).toContain('ow.delete_flag = false');
    expect(sql).toContain('ow.responsible_employee_id IS NOT NULL');
    expect(sql).toContain('u.is_active = true');
    expect(sql).toContain('ORDER BY u.user_id');
  });

  it('returns [] when no responsible employees map to a user', async () => {
    const database = createDatabase({ assignedUserIds: [] });
    const ids = await database.service.transaction((tx) => loadOrderAssignedUserIds(tx, 15));
    expect(ids).toEqual([]);
  });
});

describe('assertOrderScope assigned-production-worker path', () => {
  const nonOwnOrder = { orderId: 15, createdByUserId: '999', managerUserId: '888' } as const;

  async function runScope(database: ReturnType<typeof createDatabase>, user: CurrentUser) {
    const repo = new PgProductionActionRepository(database.service);
    return database.service.transaction((tx) =>
      (repo as unknown as {
        assertOrderScope: (
          user: CurrentUser,
          order: typeof nonOwnOrder,
          perms: readonly string[],
          requestId: string,
          options: { tx: unknown; allowAssignedProductionWorker: boolean },
        ) => Promise<unknown>;
      }).assertOrderScope(
        user,
        nonOwnOrder,
        ['orders.update', 'orders.change_production_status'],
        'req',
        { tx, allowAssignedProductionWorker: true },
      ),
    );
  }

  it('allows an assigned worker (accessVia=assigned_production_worker)', async () => {
    const database = createDatabase({ assignedUserIds: [20] });
    const decision = await runScope(database, currentUser('worker', '20'));
    expect(decision).toEqual({
      accessVia: 'assigned_production_worker',
      assignmentSource: 'order_workshops.responsible_employee_id',
    });
  });

  it('denies a worker NOT assigned on the order', async () => {
    const database = createDatabase({ assignedUserIds: [77] });
    await expect(runScope(database, currentUser('worker', '20'))).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    });
  });

  it('denies an assigned user who lacks orders.change_production_status', async () => {
    const database = createDatabase({ assignedUserIds: ['worker-custom-id'] });
    await expect(
      runScope(database, userWithPermissions('worker', ['doweling.view'])),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('does NOT broaden a manager: non-own order + matching assignment row stays denied', async () => {
    const database = createDatabase({ assignedUserIds: [20] });
    await expect(runScope(database, currentUser('manager', '20'))).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('does NOT broaden an operator: non-own order + matching assignment row stays denied', async () => {
    const database = createDatabase({ assignedUserIds: [20] });
    await expect(runScope(database, currentUser('operator', '20'))).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('keeps admin all-scope owner allow on a non-own order (accessVia=owner)', async () => {
    const database = createDatabase({ assignedUserIds: [] });
    const decision = await runScope(database, currentUser('admin', '20'));
    expect(decision).toMatchObject({ accessVia: 'owner' });
  });

  it('manager owner allow on OWN order is unchanged and never runs the assignment query', async () => {
    const database = createDatabase({ assignedUserIds: [] });
    const repo = new PgProductionActionRepository(database.service);
    const ownOrder = { orderId: 15, createdByUserId: '20', managerUserId: '20' } as const;
    const decision = await database.service.transaction((tx) =>
      (repo as unknown as {
        assertOrderScope: (
          user: CurrentUser,
          order: typeof ownOrder,
          perms: readonly string[],
          requestId: string,
          options: { tx: unknown; allowAssignedProductionWorker: boolean },
        ) => Promise<unknown>;
      }).assertOrderScope(
        currentUser('manager', '20'),
        ownOrder,
        ['orders.update', 'orders.change_production_status'],
        'req',
        { tx, allowAssignedProductionWorker: true },
      ),
    );
    expect(decision).toMatchObject({ accessVia: 'owner' });
    expect(normalizedSql(database.queries)).not.toContain('SELECT DISTINCT u.user_id');
  });
});

describe('non-denied audit redaction via auditService.record', () => {
  it('redacts JWT token in orderStatusName within after_json and metadata_json blobs', async () => {
    // A JWT-like token in the order status name flows into afterJson.orderStatusName and
    // metadataJson.orderStatusName in writeAudit.
    // With the old inline INSERT: the JSON blobs are serialized raw — token is present.
    // After replacing with auditService.record(): redactJson() applies JWT_PATTERN → [REDACTED].
    //
    // The status_name column ($17 in AUDIT_INSERT) holds the raw status name and is NOT a JSON
    // blob — it is legitimately not redacted.  We check only the JSON blob params (after_json /
    // metadata_json) which are the last 4 params in AUDIT_INSERT: indices 19..22 (0-based).
    const secretToken =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.TJVA95OrM7E2cBab30RMHrHDcEfxjoYZgeFONFh7HgQ';
    const database = createDatabase({ orderStatusNameOverride: secretToken });
    const repo = new PgProductionActionRepository(database.service);

    await repo.changeOrderStatus({
      currentUser: currentUser(),
      orderId: 15,
      dto: { orderStatusId: 7, version: 3, idempotencyKey: 'redaction-test-key-1' },
      requestId: 'request-redaction-test',
    });

    const auditInsert = database.queries.find((q) =>
      normalizeSql(q.text).startsWith('INSERT INTO audit_log'),
    );
    expect(auditInsert, 'audit_log INSERT must exist').toBeDefined();

    // JSON blob params are the last 4 (before/after/diff/metadata) — always the trailing 4 params
    const jsonBlobParams = auditInsert!.params.slice(-4);
    const jsonBlobStr = JSON.stringify(jsonBlobParams);

    // Within the JSON blobs, the raw token must be absent (redacted)
    expect(jsonBlobStr).not.toContain(secretToken);
    // [REDACTED] sentinel must appear in at least one JSON blob (after_json or metadata_json)
    expect(jsonBlobStr).toContain('[REDACTED]');
  });
});

describe('assigned-worker audit metadata across production commands', () => {
  it('changeProductionStatus stamps accessVia/assignmentSource into audit + outbox', async () => {
    const database = createDatabase({
      orderCreatedByUserId: 999,
      orderManagerUserId: 888,
      assignedUserIds: [20],
    });
    const repository = new PgProductionActionRepository(database.service);
    await repository.changeProductionStatus({
      currentUser: currentUser('worker', '20'),
      orderId: 15,
      dto: { productionStatusId: 2, version: 3, idempotencyKey: 'wrk-audit-1' },
      requestId: 'req-w',
    });
    const params = normalizedParams(database.queries);
    expect(params).toContain('assigned_production_worker');
    expect(params).toContain('order_workshops.responsible_employee_id');
  });

  it('activateProductionStage records assignment source for an assigned worker', async () => {
    const database = createDatabase({
      orderCreatedByUserId: 999,
      orderManagerUserId: 888,
      assignedUserIds: [20],
      existingProductionEventId: null,
    });
    const repository = new PgProductionActionRepository(database.service);
    await repository.activateProductionStage({
      currentUser: currentUser('worker', '20'),
      orderId: 15,
      productionStatusId: 4,
      dto: { version: 3, idempotencyKey: 'wrk-stage-act-1' },
      requestId: 'req-sa',
    });
    const params = normalizedParams(database.queries);
    expect(params).toContain('assigned_production_worker');
    expect(params).toContain('order_workshops.responsible_employee_id');
  });

  it('deactivateProductionStage records assignment source for an assigned worker', async () => {
    const database = createDatabase({
      orderCreatedByUserId: 999,
      orderManagerUserId: 888,
      assignedUserIds: [20],
      existingProductionEventId: 42,
    });
    const repository = new PgProductionActionRepository(database.service);
    await repository.deactivateProductionStage({
      currentUser: currentUser('worker', '20'),
      orderId: 15,
      productionStatusId: 4,
      dto: { version: 3, idempotencyKey: 'wrk-stage-deact-1' },
      requestId: 'req-sd',
    });
    const params = normalizedParams(database.queries);
    expect(params).toContain('assigned_production_worker');
    expect(params).toContain('order_workshops.responsible_employee_id');
  });

  it('activateDetailProductionStage enforces parent-order scope and records assignment source', async () => {
    const database = createDatabase({
      orderCreatedByUserId: 999,
      orderManagerUserId: 888,
      assignedUserIds: [20],
      existingDetailProductionEventId: null,
    });
    const repository = new PgProductionActionRepository(database.service);
    await repository.activateDetailProductionStage({
      currentUser: currentUser('worker', '20'),
      detailId: 99,
      productionStatusId: 4,
      dto: { idempotencyKey: 'wrk-detail-1' },
      requestId: 'req-d',
    });
    const params = normalizedParams(database.queries);
    expect(params).toContain('assigned_production_worker');
    expect(params).toContain('order_workshops.responsible_employee_id');
    expect(normalizedSql(database.queries)).toContain('SELECT DISTINCT u.user_id');
  });
});

function createDatabase(options: {
  orderVersion?: number;
  orderStatusId?: number;
  orderCreatedByUserId?: number;
  orderManagerUserId?: number | null;
  existingProductionEventId?: number | null;
  idempotencyCompletedResponse?: unknown;
  idempotencyExistingRequestHash?: string;
  existingDetailProductionEventId?: number | null;
  orderProductionStatusId?: number | null;
  productionStatusFromDetailsEnabled?: boolean;
  detailStatusRowsBefore?: Array<{ detail_id: number; production_status_id: number | null }>;
  detailStatusRowsAfter?: Array<{ detail_id: number; production_status_id: number | null }>;
  recalcOrderProductionStatusId?: number | null;
  assignedUserIds?: Array<number | string>;
  /** Suffix appended to the fake order status name — used to inject a token for redaction tests */
  orderStatusNameOverride?: string;
} = {}) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  let lastRequestHash: unknown = 'hash';
  const tx = {
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });
      const normalized = normalizeSql(text);

      if (normalized.startsWith('SELECT DISTINCT u.user_id')) {
        const ids = options.assignedUserIds ?? [];
        return { rows: ids.map((id) => ({ user_id: id })), rowCount: ids.length };
      }

      if (normalized.startsWith('INSERT INTO command_idempotency_keys')) {
        lastRequestHash = params[5];
        if (options.idempotencyCompletedResponse) {
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: [
            {
              idempotency_key: params[0],
              request_hash: params[5],
              response_json: null,
              status: 'processing',
            },
          ],
          rowCount: 1,
        };
      }

      if (normalized.startsWith('SELECT idempotency_key, request_hash')) {
        return {
          rows: [
            {
              idempotency_key: params[0],
              request_hash: options.idempotencyExistingRequestHash ?? lastRequestHash,
              response_json: options.idempotencyCompletedResponse,
              status: 'completed',
            },
          ],
          rowCount: 1,
        };
      }

      if (normalized.startsWith('SELECT order_id, client_id')) {
        return {
          rows: [
            {
              order_id: 15,
              client_id: 969,
              order_date: '2026-05-01',
              planned_completion_date: '2026-05-10',
              order_status_id: options.orderStatusId ?? 5,
              payment_status_id: 1,
              production_status_id: options.orderProductionStatusId ?? 1,
              production_status_from_details_enabled:
                options.productionStatusFromDetailsEnabled ?? false,
              version: options.orderVersion ?? 3,
              created_by: options.orderCreatedByUserId ?? 1,
              manager_id: options.orderManagerUserId ?? null,
            },
          ],
          rowCount: 1,
        };
      }

      if (normalized.startsWith('SELECT order_status_id, order_status_name')) {
        const statusName = options.orderStatusNameOverride
          ? `Выдан ${options.orderStatusNameOverride}`
          : 'Выдан';
        return { rows: [{ order_status_id: params[0], order_status_name: statusName }], rowCount: 1 };
      }

      if (normalized.startsWith('SELECT payment_status_id, payment_status_name')) {
        return {
          rows: [{ payment_status_id: params[0], payment_status_name: 'Оплачено' }],
          rowCount: 1,
        };
      }

      if (normalized.startsWith('SELECT production_status_id FROM orders')) {
        // Re-select after recalc_order_production_status
        const statusId = options.recalcOrderProductionStatusId !== undefined
          ? options.recalcOrderProductionStatusId
          : (options.orderProductionStatusId ?? 1);
        return {
          rows: statusId === null ? [] : [{ production_status_id: statusId }],
          rowCount: statusId === null ? 0 : 1,
        };
      }

      if (normalized.startsWith('SELECT production_status_id')) {
        return {
          rows: [
            {
              production_status_id: params[0],
              production_status_name: 'Крой',
              production_status_code: 'cut',
            },
          ],
          rowCount: 1,
        };
      }

      if (normalized.startsWith('SELECT recalc_order_production_status')) {
        return { rows: [], rowCount: 0 };
      }

      if (normalized.startsWith('SELECT event_id FROM production_status_events WHERE detail_id')) {
        return {
          rows:
            options.existingDetailProductionEventId === null
              ? []
              : [{ event_id: options.existingDetailProductionEventId ?? 42 }],
          rowCount: options.existingDetailProductionEventId === null ? 0 : 1,
        };
      }

      if (normalized.startsWith('SELECT event_id FROM production_status_events')) {
        return {
          rows:
            options.existingProductionEventId === null
              ? []
              : [{ event_id: options.existingProductionEventId ?? 42 }],
          rowCount: options.existingProductionEventId === null ? 0 : 1,
        };
      }

      if (normalized.startsWith('SELECT od.detail_id')) {
        return {
          rows: [
            {
              detail_id: 99,
              order_id: 15,
              client_id: 969,
              production_status_id: options.orderProductionStatusId ?? 1,
              production_status_from_details_enabled:
                options.productionStatusFromDetailsEnabled ?? false,
              version: options.orderVersion ?? 3,
              created_by: options.orderCreatedByUserId ?? 1,
              manager_id: options.orderManagerUserId ?? null,
            },
          ],
          rowCount: 1,
        };
      }

      if (normalized.startsWith('INSERT INTO production_status_events')) {
        return { rows: [{ event_id: 42 }], rowCount: 1 };
      }

      if (normalized.startsWith('SELECT detail_id, production_status_id FROM order_details')) {
        const updateAlreadyRan = queries.some((query) => {
          const n = normalizeSql(query.text);
          return (
            n.startsWith('UPDATE orders SET production_status_id') ||
            n.startsWith('UPDATE orders SET production_status_from_details_enabled')
          );
        });
        const rows = updateAlreadyRan
          ? (options.detailStatusRowsAfter ?? [])
          : (options.detailStatusRowsBefore ?? []);
        return { rows, rowCount: rows.length };
      }

      if (
        normalized.startsWith('UPDATE orders SET planned_completion_date') ||
        normalized.startsWith('UPDATE orders SET order_status_id') ||
        normalized.startsWith('UPDATE orders SET payment_status_id') ||
        normalized.startsWith('UPDATE orders SET production_status_id') ||
        normalized.startsWith('UPDATE orders SET production_status_from_details_enabled') ||
        normalized.startsWith('UPDATE orders SET version = version + 1')
      ) {
        return { rows: [{ version: 4 }], rowCount: 1 };
      }

      if (normalized.startsWith('INSERT INTO audit_log')) {
        return { rows: [{ audit_id: 'audit-id-1' }], rowCount: 1 };
      }

      return { rows: [], rowCount: 1 };
    },
  };

  return {
    queries,
    service: {
      query: tx.query,
      async transaction<T>(handler: (client: typeof tx) => Promise<T>) {
        return handler(tx);
      },
    } as unknown as DatabaseService,
  };
}

function currentUser(role: CurrentUser['role'] = 'admin', id = '1'): CurrentUser {
  return {
    id,
    username: role,
    role,
    roleId: 1,
    permissions: getPermissionsForRole(role),
  };
}

function userWithPermissions(role: CurrentUser['role'], permissions: PermissionName[]): CurrentUser {
  return {
    id: `${role}-custom-id`,
    username: `${role}_custom`,
    role,
    roleId: 1,
    permissions,
  };
}

function normalizedSql(queries: Array<{ text: string }>): string {
  return queries.map((query) => normalizeSql(query.text)).join('\n');
}

function normalizedParams(queries: Array<{ params: readonly unknown[] }>): string {
  return JSON.stringify(
    queries.map((query) =>
      query.params.map((param) => {
        if (typeof param !== 'string' || !param.startsWith('{')) {
          return param;
        }
        try {
          return JSON.parse(param) as unknown;
        } catch {
          return param;
        }
      }),
    ),
  );
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function hashStable(value: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`;
}
