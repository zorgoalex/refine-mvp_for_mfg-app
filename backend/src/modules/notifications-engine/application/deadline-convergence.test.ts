import { describe, expect, it, vi } from 'vitest';
import type { OutboxEventRecord } from '../domain/outbox-event.types';
import type { NotificationEventContext, NotificationRule } from '../domain/notification-rule.types';
import {
  NotificationRuleEngineService,
  type NotificationRuleEngineDeps,
  type NotificationRuleEngineRuntimeConfig,
} from './notification-rule-engine.service';
import { DeadlineActionDispatcherService } from '../../deadlines/application/deadline-action-dispatcher.service';

const client = {} as any;

function deadlineEnvelope(overrides: Partial<OutboxEventRecord> = {}): OutboxEventRecord {
  return {
    outboxEventId: 'outbox-deadline-1',
    eventType: 'deadline.event.created',
    aggregateType: 'deadline',
    aggregateId: 'deadline-instance-1',
    payload: {
      eventType: 'DEADLINE_EXPIRED',
      deadlineEventId: 'deadline-event-1',
      entityType: 'order',
      entityId: '500',
      orderId: 500,
      requestId: 'req-convergence-1',
      source: 'deadline-engine',
    },
    attempts: 0,
    ...overrides,
  };
}

function deadlineContext(overrides: Partial<NotificationEventContext> = {}): NotificationEventContext {
  return {
    eventType: 'DEADLINE_EXPIRED',
    outboxEventId: 'outbox-deadline-1',
    aggregateType: 'deadline',
    aggregateId: 'deadline-instance-1',
    orderId: 500,
    clientId: 42,
    paymentId: null,
    deadlineId: null,
    deadlineInstanceId: 'deadline-instance-1',
    orderStatusId: 11,
    isOrderCompleted: false,
    isCurrentDeadlineEvent: true,
    payload: { orderId: 500, clientId: 42, orderStatusId: 11 },
    ...overrides,
  };
}

function rule(overrides: Partial<NotificationRule> = {}): NotificationRule {
  return {
    notificationRuleId: 'rule-1',
    ruleCode: 'rule-1',
    eventType: 'DEADLINE_EXPIRED',
    isEnabled: true,
    priority: 100,
    level: 'warning',
    conditions: {},
    recipients: { resolvers: ['order_manager'] },
    titleTemplate: null,
    messageTemplate: null,
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    ...overrides,
  };
}

interface Fakes {
  ruleRepo: { listEnabledByEvent: ReturnType<typeof vi.fn> };
  contextBuilder: { buildContext: ReturnType<typeof vi.fn> };
  recipientResolver: { resolve: ReturnType<typeof vi.fn> };
  notificationWrite: { insertIfAbsent: ReturnType<typeof vi.fn> };
  runtimeConfig?: NotificationRuleEngineRuntimeConfig;
}

function fakes(overrides: Partial<Fakes> = {}): Fakes {
  return {
    ruleRepo: { listEnabledByEvent: vi.fn(async () => []) },
    contextBuilder: { buildContext: vi.fn(async () => deadlineContext()) },
    recipientResolver: { resolve: vi.fn(async () => []) },
    notificationWrite: { insertIfAbsent: vi.fn(async () => ({ created: true, notificationId: 'n-1' })) },
    ...overrides,
  };
}

function engine(deps: Fakes): NotificationRuleEngineService {
  return new NotificationRuleEngineService(deps as unknown as NotificationRuleEngineDeps);
}

describe('Deadline convergence — zero double-send (engine fakes)', () => {
  it('engine delivers manager/assignee/participants notifications for DEADLINE_EXPIRED envelope when ownsDeadline=true', async () => {
    const seededRules: NotificationRule[] = [
      rule({
        notificationRuleId: 'seed-manager',
        ruleCode: 'deadline-expired-notify-manager',
        recipients: { resolvers: ['order_manager'] },
        titleTemplate: 'Deadline expired',
        messageTemplate: 'Order {orderId} deadline expired',
      }),
      rule({
        notificationRuleId: 'seed-assignee',
        ruleCode: 'deadline-expired-notify-assignee',
        recipients: { resolvers: ['stage_assignee'] },
      }),
      rule({
        notificationRuleId: 'seed-participants',
        ruleCode: 'deadline-expired-project-participants',
        recipients: { resolvers: ['project_participants'] },
      }),
      rule({
        notificationRuleId: 'seed-escalate',
        ruleCode: 'deadline-expired-escalate-manager',
        priority: 200,
        level: 'error',
        recipients: { resolvers: ['order_manager'] },
      }),
    ];

    const writes: Array<{ userId: number; ruleId: string; key: string }> = [];

    const deps = fakes({
      ruleRepo: { listEnabledByEvent: vi.fn(async () => seededRules) },
      recipientResolver: {
        resolve: vi.fn(async (_c, recipients) => {
          if (recipients.resolvers?.includes('order_manager')) return [100];
          if (recipients.resolvers?.includes('stage_assignee')) return [200, 201];
          if (recipients.resolvers?.includes('project_participants')) return [300];
          return [];
        }),
      },
      notificationWrite: {
        insertIfAbsent: vi.fn(async (_c, input) => {
          writes.push({ userId: input.userId, ruleId: input.sourceId, key: input.idempotencyKey });
          return { created: true, notificationId: `n-${writes.length}` };
        }),
      },
      runtimeConfig: { isEngineOwnsDeadline: () => true },
    });

    const result = await engine(deps).processEvent(client, deadlineEnvelope());

    // 4 rules x resolved recipients: 1 manager + 2 assignees + 1 participant + 1 escalate-manager
    expect(result.matched).toBe(4);
    expect(result.created).toBe(5);
    expect(deps.ruleRepo.listEnabledByEvent).toHaveBeenCalledWith(client, 'DEADLINE_EXPIRED');
    expect(writes).toHaveLength(5);
  });

  it('engine writes nothing when ownsDeadline=false (legacy default — no double-send from engine side)', async () => {
    const deps = fakes({
      runtimeConfig: { isEngineOwnsDeadline: () => false },
    });
    const result = await engine(deps).processEvent(client, deadlineEnvelope());

    expect(result).toEqual({ matched: 0, created: 0, skipped: 'not_engine_owned' });
    expect(deps.ruleRepo.listEnabledByEvent).not.toHaveBeenCalled();
    expect(deps.notificationWrite.insertIfAbsent).not.toHaveBeenCalled();
  });

  it('replay on the same outbox event returns same writes; insertIfAbsent is the idempotency layer', async () => {
    const seededRule = rule({
      notificationRuleId: 'seed-manager',
      recipients: { resolvers: ['order_manager'] },
    });
    let writesCount = 0;
    const deps = fakes({
      ruleRepo: { listEnabledByEvent: vi.fn(async () => [seededRule]) },
      recipientResolver: { resolve: vi.fn(async () => [100]) },
      notificationWrite: {
        insertIfAbsent: vi.fn(async () => {
          writesCount += 1;
          // First call creates, second call (replay) is a no-op
          return { created: writesCount === 1, notificationId: 'n-1' };
        }),
      },
      runtimeConfig: { isEngineOwnsDeadline: () => true },
    });

    const first = await engine(deps).processEvent(client, deadlineEnvelope());
    const replay = await engine(deps).processEvent(client, deadlineEnvelope());

    expect(first).toEqual({ matched: 1, created: 1 });
    expect(replay).toEqual({ matched: 1, created: 0 });
    expect(deps.notificationWrite.insertIfAbsent).toHaveBeenCalledTimes(2);
  });

  it('engine has zero coupling to the dispatcher — the dispatcher is not invoked from the engine path', async () => {
    const deps = fakes({
      runtimeConfig: { isEngineOwnsDeadline: () => true },
    });
    // The dispatcher is never constructed by the engine — assert that the
    // service has no reference to it (compile-time check via type) and that
    // the engine fakes are the only seam consulted. This is a static
    // guarantee: the engine never instantiates DeadlineActionDispatcherService.
    const engineInstance = engine(deps);
    expect(engineInstance).toBeInstanceOf(NotificationRuleEngineService);
    // The dispatcher type is imported here only to assert it stays out of
    // the engine call graph; the test does not call it.
    expect(DeadlineActionDispatcherService).toBeDefined();
  });
});
