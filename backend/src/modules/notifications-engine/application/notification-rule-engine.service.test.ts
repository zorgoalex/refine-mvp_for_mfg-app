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
    deadlineEntityType: null,
    deadlineInstanceId: null,
    groupIds: [],
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
    groupId: null,
    isEnabled: true,
    priority: 100,
    level: 'info',
    channels: ['in_app'],
    balloonMode: 'auto',
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
  channelDelivery: { enqueueIfAbsent: ReturnType<typeof vi.fn> };
  runtimeConfig?: { isEngineOwnsDeadline(): boolean; isFeatureEnabled?(flag: string): boolean };
  now?: () => Date;
  procurementVisibility?: { filterByBaseVisibility: ReturnType<typeof vi.fn> };
}

function fakes(overrides: Partial<Fakes> = {}): Fakes {
  return {
    ruleRepo: { listEnabledByEvent: vi.fn(async () => []) },
    contextBuilder: { buildContext: vi.fn(async () => ctx()) },
    recipientResolver: { resolve: vi.fn(async () => []) },
    notificationWrite: { insertIfAbsent: vi.fn(async () => ({ created: true, notificationId: 'notif-1' })) },
    channelDelivery: { enqueueIfAbsent: vi.fn(async () => ({ created: true, deliveryId: 'delivery-1' })) },
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

  it('matches global rules and group-scoped rules for attributed events', async () => {
    const globalRule = rule({ notificationRuleId: 'global-rule', groupId: null, recipients: { userIds: [1] } });
    const scopedRule = rule({
      notificationRuleId: 'scoped-rule',
      groupId: '11111111-1111-4111-8111-111111111111',
      recipients: { userIds: [2] },
    });
    const otherGroupRule = rule({
      notificationRuleId: 'other-rule',
      groupId: '22222222-2222-4222-8222-222222222222',
      recipients: { userIds: [3] },
    });
    const deps = fakes({
      ruleRepo: { listEnabledByEvent: vi.fn(async () => [globalRule, scopedRule, otherGroupRule]) },
      contextBuilder: {
        buildContext: vi.fn(async () => ctx({
          groupIds: ['11111111-1111-4111-8111-111111111111'],
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

  it('skips group-scoped rules when the event has no group attribution', async () => {
    const scopedRule = rule({
      notificationRuleId: 'scoped-rule',
      groupId: '11111111-1111-4111-8111-111111111111',
      recipients: { userIds: [1] },
    });
    const deps = fakes({
      ruleRepo: { listEnabledByEvent: vi.fn(async () => [scopedRule]) },
      contextBuilder: { buildContext: vi.fn(async () => ctx({ groupIds: [] })) },
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

  it('routes Telegram through durable external delivery without creating an in-app row', async () => {
    const telegramRule = rule({
      notificationRuleId: 'rule-telegram',
      channels: ['telegram'],
      recipients: { userIds: [42] },
    });
    const deps = fakes({
      ruleRepo: { listEnabledByEvent: vi.fn(async () => [telegramRule]) },
      recipientResolver: { resolve: vi.fn(async () => [42]) },
    });

    const result = await service(deps).processEvent(
      client,
      event({ outboxEventId: '00000000-0000-0000-0000-000000000077' }),
    );

    expect(result).toMatchObject({ matched: 1, created: 1 });
    expect(deps.notificationWrite.insertIfAbsent).not.toHaveBeenCalled();
    expect(deps.channelDelivery.enqueueIfAbsent).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        userId: 42,
        channel: 'telegram',
        idempotencyKey:
          'notif-rule:00000000-0000-0000-0000-000000000077:rule-telegram:42:telegram',
      }),
    );
  });

  it('balloon (plan 2026-10-03): in_app row carries the rule balloon mode; balloon never goes to external delivery', async () => {
    const balloonRule = rule({ notificationRuleId: 'rule-balloon', channels: ['in_app', 'balloon', 'telegram'], balloonMode: 'persistent', recipients: { userIds: [42] } });
    const deps = fakes({
      ruleRepo: { listEnabledByEvent: vi.fn(async () => [balloonRule]) },
      recipientResolver: { resolve: vi.fn(async () => [42]) },
    });
    await service(deps).processEvent(client, event({ outboxEventId: '00000000-0000-0000-0000-000000000078' }));
    expect(deps.notificationWrite.insertIfAbsent).toHaveBeenCalledTimes(1);
    expect(deps.notificationWrite.insertIfAbsent).toHaveBeenCalledWith(client, expect.objectContaining({ userId: 42, balloonMode: 'persistent' }));
    expect(deps.channelDelivery.enqueueIfAbsent).toHaveBeenCalledTimes(1);
    expect(deps.channelDelivery.enqueueIfAbsent).toHaveBeenCalledWith(client, expect.objectContaining({ channel: 'telegram' }));
    // Без канала balloon — без балуна.
    const plain = fakes({
      ruleRepo: { listEnabledByEvent: vi.fn(async () => [rule({ channels: ['in_app'], balloonMode: 'persistent', recipients: { userIds: [7] } })]) },
      recipientResolver: { resolve: vi.fn(async () => [7]) },
    });
    await service(plain).processEvent(client, event({ outboxEventId: '00000000-0000-0000-0000-000000000079' }));
    expect(plain.notificationWrite.insertIfAbsent).toHaveBeenCalledWith(client, expect.objectContaining({ balloonMode: null }));
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

  it('deadline balloons: a DEADLINE_EXPIRED rule with the balloon channel writes the in_app row with its persistent mode (engine owns deadlines)', async () => {
    const deadlineEvent = (outboxEventId: string) => event({
      outboxEventId,
      eventType: 'deadline.event.created',
      aggregateType: 'deadline',
      aggregateId: 'dl-9',
      payload: { eventType: 'DEADLINE_EXPIRED', orderId: 500, deadlineEventId: 'de-9' },
    });
    const run = async (channels: NotificationRule['channels'], ownsDeadline: boolean) => {
      const deps = fakes({
        ruleRepo: { listEnabledByEvent: vi.fn(async () => [rule({
          notificationRuleId: 'rule-deadline-balloon', eventType: 'DEADLINE_EXPIRED', channels, balloonMode: 'persistent',
          recipients: { resolvers: ['order_manager'] },
        })]) },
        contextBuilder: { buildContext: vi.fn(async () => ctx({ eventType: 'DEADLINE_EXPIRED', deadlineInstanceId: 'dl-9' })) },
        recipientResolver: { resolve: vi.fn(async () => [77]) },
        runtimeConfig: { isEngineOwnsDeadline: () => ownsDeadline },
      });
      await service(deps).processEvent(client, deadlineEvent(`outbox-deadline-balloon-${channels.join('-')}-${ownsDeadline}`));
      return deps;
    };

    const withBalloon = await run(['in_app', 'balloon'], true);
    expect(withBalloon.notificationWrite.insertIfAbsent).toHaveBeenCalledTimes(1);
    expect(withBalloon.notificationWrite.insertIfAbsent).toHaveBeenCalledWith(client, expect.objectContaining({ userId: 77, balloonMode: 'persistent' }));
    // Балун — не внешняя доставка.
    expect(withBalloon.channelDelivery.enqueueIfAbsent).not.toHaveBeenCalled();

    // То же правило без канала балуна — уведомление без балуна (режим правила сам по себе ничего не включает).
    const plain = await run(['in_app'], true);
    expect(plain.notificationWrite.insertIfAbsent).toHaveBeenCalledWith(client, expect.objectContaining({ userId: 77, balloonMode: null }));

    // Дедлайнами владеет старый путь — движок ничего не пишет (балунов дедлайнов нет, как и уведомлений движка).
    const legacy = await run(['in_app', 'balloon'], false);
    expect(legacy.notificationWrite.insertIfAbsent).not.toHaveBeenCalled();
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

  describe('procurement events (§5.7, phase 4b)', () => {
    const NOW = new Date('2026-10-01T12:00:00.000Z');
    const procurementEvent = (overrides: Partial<OutboxEventRecord> = {}) => event({
      eventType: 'order.resource_procurement_changed',
      payload: { orderId: 500, changeType: 'allocation_added', role: 'receipt' },
      createdAt: '2026-10-01T11:00:00.000Z',
      ...overrides,
    });
    const arrived = rule({
      eventType: 'order.resource_procurement_changed',
      conditions: { procurementChangeTypes: ['allocation_added'], allocationRoles: ['receipt'] },
    });
    const procurementFakes = (enabled: boolean) => fakes({
      ruleRepo: { listEnabledByEvent: vi.fn(async () => [arrived]) },
      contextBuilder: { buildContext: vi.fn(async (_client: unknown, record: OutboxEventRecord) => ctx({ eventType: record.eventType, payload: record.payload })) },
      recipientResolver: { resolve: vi.fn(async () => [7]) },
      runtimeConfig: { isEngineOwnsDeadline: () => false, isFeatureEnabled: (flag: string) => flag === 'procurementNotifications' && enabled },
      now: () => NOW,
      procurementVisibility: { filterByBaseVisibility: vi.fn(async () => [7]) },
    });

    it('flag off at processing time: skipped_disabled, nothing read or written', async () => {
      const deps = procurementFakes(false);
      expect(await service(deps).processEvent(client, procurementEvent())).toEqual({ matched: 0, created: 0, skipped: 'skipped_disabled' });
      expect(deps.ruleRepo.listEnabledByEvent).not.toHaveBeenCalled();
      expect(deps.notificationWrite.insertIfAbsent).not.toHaveBeenCalled();
    });

    it('fails closed without the runtime flag reader', async () => {
      const deps = { ...procurementFakes(true), runtimeConfig: { isEngineOwnsDeadline: () => false } };
      expect((await service(deps).processEvent(client, procurementEvent())).skipped).toBe('skipped_disabled');
    });

    it('flag on: a receipt allocation writes in_app with its own source_type; stale or undated events are skipped', async () => {
      const deps = procurementFakes(true);
      expect(await service(deps).processEvent(client, procurementEvent())).toEqual({ matched: 1, created: 1 });
      expect(deps.notificationWrite.insertIfAbsent).toHaveBeenCalledWith(client, expect.objectContaining({
        userId: 7, sourceType: 'procurement_order_event', entityType: 'order', entityId: '500',
      }));
      expect((await service(deps).processEvent(client, procurementEvent({ createdAt: '2026-09-30T11:59:00.000Z' }))).skipped).toBe('skipped_stale');
      expect((await service(deps).processEvent(client, procurementEvent({ createdAt: undefined }))).skipped).toBe('skipped_stale');
    });

    it('recipients go through the procurement visibility (live role matrix); without it nobody is notified (CR1-1)', async () => {
      const deps = procurementFakes(true);
      await service(deps).processEvent(client, procurementEvent());
      expect(deps.recipientResolver.resolve).toHaveBeenCalledWith(client, arrived.recipients, expect.anything(), deps.procurementVisibility);
      const blind = { ...procurementFakes(true), procurementVisibility: undefined };
      expect(await service(blind).processEvent(client, procurementEvent())).toEqual({ matched: 1, created: 0 });
      expect(blind.recipientResolver.resolve).not.toHaveBeenCalled();
    });

    it('payment, mark and removal do not match the «material arrived» rule', async () => {
      const deps = procurementFakes(true);
      for (const payload of [
        { orderId: 500, changeType: 'allocation_added', role: 'payment' },
        { orderId: 500, changeType: 'marked' },
        { orderId: 500, changeType: 'allocation_removed', role: 'receipt' },
      ]) {
        expect(await service(deps).processEvent(client, procurementEvent({ payload }))).toEqual({ matched: 0, created: 0 });
      }
      expect(deps.notificationWrite.insertIfAbsent).not.toHaveBeenCalled();
    });

    it('a stored telegram channel is never delivered for a procurement event', async () => {
      const deps = procurementFakes(true);
      deps.ruleRepo.listEnabledByEvent = vi.fn(async () => [{ ...arrived, channels: ['in_app', 'telegram'] }]);
      await service(deps).processEvent(client, procurementEvent());
      expect(deps.channelDelivery.enqueueIfAbsent).not.toHaveBeenCalled();
      expect(deps.notificationWrite.insertIfAbsent).toHaveBeenCalledTimes(1);
    });
  });
});
