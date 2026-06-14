import { describe, expect, it, vi } from 'vitest';
import type { OutboxEventRecord } from '../domain/outbox-event.types';
import type { NotificationEventContext, NotificationRule } from '../domain/notification-rule.types';
import { buildNotificationDeliveryKey } from '../domain/notification-idempotency';
import {
  NotificationRuleEngineService,
  renderNotificationText,
  type NotificationRuleEngineDeps,
} from './notification-rule-engine.service';

const client = {} as any;

function ctx(overrides: Partial<NotificationEventContext> = {}): NotificationEventContext {
  return {
    eventType: 'order.production_status_changed',
    outboxEventId: 'outbox-1',
    aggregateType: 'order',
    aggregateId: '500',
    orderId: 500,
    clientId: 12,
    paymentId: null,
    deadlineId: null,
    deadlineInstanceId: null,
    projectIds: [],
    orderStatusId: 30,
    isOrderCompleted: false,
    isCurrentDeadlineEvent: true,
    payload: { orderId: 500, clientId: 12, orderStatusId: 30, actorUserId: 9, requestId: 'req-1' },
    ...overrides,
  };
}

function rule(overrides: Partial<NotificationRule> = {}): NotificationRule {
  return {
    notificationRuleId: 'rule-1',
    ruleCode: 'rule_code_1',
    eventType: 'order.production_status_changed',
    projectId: null,
    isEnabled: true,
    priority: 100,
    level: 'info',
    conditions: {},
    recipients: { resolvers: ['order_manager'] },
    titleTemplate: null,
    messageTemplate: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function event(overrides: Partial<OutboxEventRecord> = {}): OutboxEventRecord {
  return {
    outboxEventId: 'outbox-1',
    eventType: 'order.production_status_changed',
    aggregateType: 'order',
    aggregateId: '500',
    payload: { orderId: 500, clientId: 12, orderStatusId: 30 },
    attempts: 0,
    ...overrides,
  };
}

interface Fakes {
  ruleRepo: { listEnabledByEvent: ReturnType<typeof vi.fn> };
  contextBuilder: { buildContext: ReturnType<typeof vi.fn> };
  recipientResolver: { resolve: ReturnType<typeof vi.fn> };
  notificationWrite: { insertIfAbsent: ReturnType<typeof vi.fn> };
  runtimeConfig?: { isEngineOwnsDeadline(): boolean };
}

function fakes(overrides: Partial<Fakes> = {}): Fakes {
  return {
    ruleRepo: { listEnabledByEvent: vi.fn(async () => []) },
    contextBuilder: { buildContext: vi.fn(async () => ctx()) },
    recipientResolver: { resolve: vi.fn(async () => []) },
    notificationWrite: { insertIfAbsent: vi.fn(async () => ({ created: true, notificationId: 'notif-1' })) },
    ...overrides,
  };
}

function service(deps: Fakes): NotificationRuleEngineService {
  return new NotificationRuleEngineService(deps as unknown as NotificationRuleEngineDeps);
}

describe('NotificationRuleEngineService.processEvent', () => {
  it('returns matched:0 for legacy_inline events without touching deps', async () => {
    const deps = fakes();
    const svc = service(deps);

    const result = await svc.processEvent(client, event({ eventType: 'DEADLINE_EXPIRED', payload: { orderId: 500, deadlineId: 10 } }));

    expect(result).toEqual({ matched: 0, created: 0, skipped: 'not_engine_owned' });
    expect(deps.ruleRepo.listEnabledByEvent).not.toHaveBeenCalled();
    expect(deps.contextBuilder.buildContext).not.toHaveBeenCalled();
    expect(deps.recipientResolver.resolve).not.toHaveBeenCalled();
    expect(deps.notificationWrite.insertIfAbsent).not.toHaveBeenCalled();
  });

  it('multi-fires: two enabled matching rules both fire and write per (rule, recipient)', async () => {
    const ruleA = rule({ notificationRuleId: 'rule-a', recipients: { userIds: [1, 2] } });
    const ruleB = rule({ notificationRuleId: 'rule-b', recipients: { resolvers: ['stage_assignee'] } });
    const deps = fakes({
      ruleRepo: { listEnabledByEvent: vi.fn(async () => [ruleA, ruleB]) },
      recipientResolver: {
        resolve: vi.fn(async (_client: unknown, recipients: { resolvers?: string[]; userIds?: number[] }) => {
          if (recipients.userIds) return recipients.userIds;
          return [3];
        }),
      },
    });
    const svc = service(deps);

    const result = await svc.processEvent(client, event());

    expect(result.matched).toBe(2);
    expect(result.created).toBe(3);
    expect(deps.recipientResolver.resolve).toHaveBeenCalledTimes(2);
    expect(deps.notificationWrite.insertIfAbsent).toHaveBeenCalledTimes(3);
  });

  it('matches global rules and project-scoped rules for attributed events', async () => {
    const globalRule = rule({ notificationRuleId: 'global-rule', projectId: null, recipients: { userIds: [1] } });
    const scopedRule = rule({
      notificationRuleId: 'scoped-rule',
      projectId: '11111111-1111-4111-8111-111111111111',
      recipients: { userIds: [2] },
    });
    const otherProjectRule = rule({
      notificationRuleId: 'other-rule',
      projectId: '22222222-2222-4222-8222-222222222222',
      recipients: { userIds: [3] },
    });
    const deps = fakes({
      ruleRepo: { listEnabledByEvent: vi.fn(async () => [globalRule, scopedRule, otherProjectRule]) },
      contextBuilder: {
        buildContext: vi.fn(async () => ctx({
          projectIds: ['11111111-1111-4111-8111-111111111111'],
        })),
      },
      recipientResolver: {
        resolve: vi.fn(async (_client: unknown, recipients: { userIds?: number[] }) => recipients.userIds ?? []),
      },
    });
    const svc = service(deps);

    const result = await svc.processEvent(client, event());

    expect(result.matched).toBe(2);
    expect(deps.notificationWrite.insertIfAbsent).toHaveBeenCalledTimes(2);
    expect(
      deps.notificationWrite.insertIfAbsent.mock.calls.map((call) => call[1].sourceId).sort(),
    ).toEqual(['global-rule', 'scoped-rule']);
  });

  it('skips project-scoped rules when the event has no project attribution', async () => {
    const scopedRule = rule({
      notificationRuleId: 'scoped-rule',
      projectId: '11111111-1111-4111-8111-111111111111',
      recipients: { userIds: [1] },
    });
    const deps = fakes({
      ruleRepo: { listEnabledByEvent: vi.fn(async () => [scopedRule]) },
      contextBuilder: { buildContext: vi.fn(async () => ctx({ projectIds: [] })) },
      recipientResolver: { resolve: vi.fn(async () => [1]) },
    });
    const svc = service(deps);

    const result = await svc.processEvent(client, event());

    expect(result.matched).toBe(0);
    expect(deps.notificationWrite.insertIfAbsent).toHaveBeenCalledTimes(0);
  });

  it('does not fire a rule excluded by excludeCompletedOrders when ctx.isOrderCompleted=true', async () => {
    const completedCtx = ctx({ isOrderCompleted: true });
    const excludedRule = rule({ notificationRuleId: 'rule-excluded', conditions: { excludeCompletedOrders: true }, recipients: { userIds: [1] } });
    const okRule = rule({ notificationRuleId: 'rule-ok', recipients: { userIds: [2] } });
    const deps = fakes({
      contextBuilder: { buildContext: vi.fn(async () => completedCtx) },
      ruleRepo: { listEnabledByEvent: vi.fn(async () => [excludedRule, okRule]) },
      recipientResolver: { resolve: vi.fn(async (_c: unknown, recipients: { userIds?: number[] }) => recipients.userIds ?? []) },
    });
    const svc = service(deps);

    const result = await svc.processEvent(client, event());

    expect(result.matched).toBe(1);
    expect(result.created).toBe(1);
    expect(deps.recipientResolver.resolve).toHaveBeenCalledTimes(1);
    expect(deps.recipientResolver.resolve).toHaveBeenCalledWith(client, okRule.recipients, expect.anything());
    expect(deps.notificationWrite.insertIfAbsent).toHaveBeenCalledTimes(1);
    const insertedFor = (deps.notificationWrite.insertIfAbsent as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(insertedFor.userId).toBe(2);
  });

  it('builds idempotencyKey via buildNotificationDeliveryKey for (event, rule, user) — one insert per (rule, recipient)', async () => {
    const r = rule({ notificationRuleId: 'rule-key', recipients: { userIds: [42] } });
    const deps = fakes({
      ruleRepo: { listEnabledByEvent: vi.fn(async () => [r]) },
      recipientResolver: { resolve: vi.fn(async () => [42]) },
    });
    const svc = service(deps);

    await svc.processEvent(client, event({ outboxEventId: 'outbox-77' }));

    expect(deps.notificationWrite.insertIfAbsent).toHaveBeenCalledTimes(1);
    const input = (deps.notificationWrite.insertIfAbsent as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(input.idempotencyKey).toBe(buildNotificationDeliveryKey({ outboxEventId: 'outbox-77', ruleId: 'rule-key', userId: 42 }));
    expect(input.userId).toBe(42);
    expect(input.entityType).toBe('order');
    expect(input.entityId).toBe('500');
    expect(input.sourceType).toBe('notification_rule');
    expect(input.sourceId).toBe('rule-key');
  });

  it('replay: when notificationWrite returns created:false, processEvent returns created:0 with same call count (idempotency delegated to write layer)', async () => {
    const r = rule({ notificationRuleId: 'rule-replay', recipients: { userIds: [1, 2] } });
    const deps = fakes({
      ruleRepo: { listEnabledByEvent: vi.fn(async () => [r]) },
      recipientResolver: { resolve: vi.fn(async () => [1, 2]) },
      notificationWrite: { insertIfAbsent: vi.fn(async () => ({ created: false, notificationId: 'existing-1' })) },
    });
    const svc = service(deps);

    const result = await svc.processEvent(client, event());

    expect(result.matched).toBe(1);
    expect(result.created).toBe(0);
    expect(deps.notificationWrite.insertIfAbsent).toHaveBeenCalledTimes(2);
  });

  it('redacts unknown placeholders: never emits payload/phone/secret values, only whitelisted fields', () => {
    const dangerousCtx = ctx({
      orderId: 777,
      clientId: 99,
      orderStatusId: 30,
      eventType: 'order.production_status_changed',
      payload: {
        clientPhone: '+79991234567',
        secret: 'sk-super-secret-token',
        orderId: 777,
      },
    });
    const dangerousRule = rule({
      titleTemplate: '{orderId} {payload} {clientPhone} {secret}',
      messageTemplate: 'Order {orderId} client {clientId} payload={payload} phone={clientPhone} secret={secret}',
    });

    const { title, message } = renderNotificationText(dangerousRule, dangerousCtx);

    expect(title).toContain('777');
    expect(message).toContain('777');
    expect(message).toContain('99');

    for (const text of [title, message]) {
      // Actual sensitive VALUES from ctx.payload must never be emitted —
      // this is the redaction guarantee (literal English words the operator
      // wrote into their own template, e.g. "secret=", are not sensitive).
      expect(text).not.toContain('+79991234567');
      expect(text).not.toContain('sk-super-secret-token');
      expect(text).not.toContain('[object Object]');
      // Unknown placeholders must be fully consumed/blanked, never echoed raw.
      expect(text).not.toMatch(/\{payload\}|\{clientPhone\}|\{secret\}/);
    }
  });

  it('uses a safe default template built only from whitelisted fields when templates are null', () => {
    const c = ctx({ orderId: 321, orderStatusId: 40, eventType: 'order.status_changed' });
    const r = rule({ titleTemplate: null, messageTemplate: null });

    const { title, message } = renderNotificationText(r, c);

    expect(title).toBe('Order 321 — order.status_changed');
    expect(message).toBe('Order 321 event order.status_changed (status 40)');
  });

  it('processes the deadline envelope as DEADLINE_EXPIRED when ownsDeadline=true (convergence)', async () => {
    const r = rule({
      notificationRuleId: 'rule-deadline-1',
      eventType: 'DEADLINE_EXPIRED',
      recipients: { resolvers: ['order_manager'] },
    });
    const deps = fakes({
      ruleRepo: { listEnabledByEvent: vi.fn(async () => [r]) },
      contextBuilder: {
        buildContext: vi.fn(async () => ctx({ eventType: 'DEADLINE_EXPIRED', deadlineInstanceId: 'dl-1' })),
      },
      recipientResolver: { resolve: vi.fn(async () => [77]) },
      runtimeConfig: { isEngineOwnsDeadline: () => true },
    });
    const svc = service(deps);

    const result = await svc.processEvent(
      client,
      event({
        outboxEventId: 'outbox-deadline-1',
        eventType: 'deadline.event.created',
        aggregateType: 'deadline',
        aggregateId: 'dl-1',
        payload: { eventType: 'DEADLINE_EXPIRED', orderId: 500, deadlineEventId: 'de-1' },
      }),
    );

    expect(result).toEqual({ matched: 1, created: 1 });
    expect(deps.ruleRepo.listEnabledByEvent).toHaveBeenCalledWith(client, 'DEADLINE_EXPIRED');
    expect(deps.notificationWrite.insertIfAbsent).toHaveBeenCalledTimes(1);
  });

  it('skips the deadline envelope when ownsDeadline=false (legacy default)', async () => {
    const r = rule({
      notificationRuleId: 'rule-deadline-2',
      eventType: 'DEADLINE_EXPIRED',
      recipients: { resolvers: ['order_manager'] },
    });
    const deps = fakes({
      ruleRepo: { listEnabledByEvent: vi.fn(async () => [r]) },
      runtimeConfig: { isEngineOwnsDeadline: () => false },
    });
    const svc = service(deps);

    const result = await svc.processEvent(
      client,
      event({
        eventType: 'deadline.event.created',
        payload: { eventType: 'DEADLINE_EXPIRED', orderId: 500 },
      }),
    );

    expect(result).toEqual({ matched: 0, created: 0, skipped: 'not_engine_owned' });
    expect(deps.ruleRepo.listEnabledByEvent).not.toHaveBeenCalled();
  });

  it('skips deadline envelope with unknown inner type (safe skip)', async () => {
    const deps = fakes({
      runtimeConfig: { isEngineOwnsDeadline: () => true },
    });
    const svc = service(deps);

    const result = await svc.processEvent(
      client,
      event({
        eventType: 'deadline.event.created',
        payload: { eventType: 'DEADLINE_SOMETHING_NEW' },
      }),
    );

    expect(result).toEqual({ matched: 0, created: 0, skipped: 'not_engine_owned' });
  });

  it('does not flip order.* ownership regardless of ownsDeadline (regression)', async () => {
    const r = rule({ notificationRuleId: 'rule-order' });
    const deps = fakes({
      ruleRepo: { listEnabledByEvent: vi.fn(async () => [r]) },
      recipientResolver: { resolve: vi.fn(async () => [1]) },
      runtimeConfig: { isEngineOwnsDeadline: () => true },
    });
    const svc = service(deps);

    const result = await svc.processEvent(client, event());

    expect(result.matched).toBe(1);
    expect(deps.ruleRepo.listEnabledByEvent).toHaveBeenCalledWith(client, 'order.production_status_changed');
  });
});
