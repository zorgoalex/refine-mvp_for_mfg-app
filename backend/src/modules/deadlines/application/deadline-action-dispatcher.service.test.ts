import { describe, expect, it } from 'vitest';
import type { DeadlineActionExecutionDto, DeadlineActionRuleDto } from '../dto/deadline-action-rule.dto';
import type { DeadlineEventDto, DeadlineInstanceDto } from '../dto/deadline-instance.dto';
import { DeadlineActionDispatcherService } from './deadline-action-dispatcher.service';
import type { DeadlineNotificationPort, DeadlineRepositoryPort, DeadlineTargetResolverPort } from './deadline.types';

describe('DeadlineActionDispatcherService', () => {
  it('creates skipped execution when action rule is disabled', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [createRule({ isEnabled: false, actionType: 'write_audit' })],
        executions,
      }),
      targetResolver: createTargetResolver(),
      notificationPort: createNotificationPort(),
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(executions).toMatchObject([
      {
        actionType: 'write_audit',
        status: 'skipped',
        skipReason: 'action_disabled',
        idempotencyKey: 'event-1:write_audit:order:42',
      },
    ]);
  });

  it('creates skipped execution when global actions are disabled after event creation', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [createRule({ isEnabled: true, actionType: 'write_audit' })],
        executions,
      }),
      targetResolver: createTargetResolver(),
      notificationPort: createNotificationPort(),
      config: { actionsEnabled: false, notificationsEnabled: true },
    });

    expect(executions[0]).toMatchObject({
      status: 'skipped',
      skipReason: 'global_actions_disabled',
    });
  });

  it('creates skipped execution for notifications when notifications are disabled', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [createRule({ actionType: 'notify_assignee' })],
        executions,
      }),
      targetResolver: createTargetResolver(),
      notificationPort: createNotificationPort(),
      config: { actionsEnabled: true, notificationsEnabled: false },
    });

    expect(executions).toMatchObject([
      {
        actionType: 'notify_assignee',
        status: 'skipped',
        skipReason: 'notifications_disabled',
      },
    ]);
  });

  it('executes write_audit action when enabled', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [createRule({ actionType: 'write_audit' })],
        executions,
      }),
      targetResolver: createTargetResolver(),
      notificationPort: createNotificationPort(),
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(executions[0]).toMatchObject({
      status: 'executed',
      result: { auditEventQueued: true },
    });
  });

  it('executes set_overdue_flag by marking the deadline expired and recording the action execution', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const overdueUpdates: Array<{ deadlineId: string; expiredAt: string }> = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent({
        deadlineEventId: 'event-overdue-1',
        deadlineId: 'deadline-overdue-1',
        eventAt: '2026-05-01T10:00:00.000Z',
      }),
      repository: createRepository({
        rules: [createRule({ actionType: 'set_overdue_flag' })],
        executions,
        overdueUpdates,
      }),
      targetResolver: createTargetResolver(),
      notificationPort: createNotificationPort(),
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(overdueUpdates).toEqual([
      {
        deadlineId: 'deadline-overdue-1',
        expiredAt: '2026-05-01T10:00:00.000Z',
      },
    ]);
    expect(executions[0]).toMatchObject({
      actionType: 'set_overdue_flag',
      status: 'executed',
      executedAt: '2026-05-01T10:00:00.000Z',
      idempotencyKey: 'event-overdue-1:set_overdue_flag:order:42',
      result: {
        overdueFlagSet: true,
        deadlineId: 'deadline-overdue-1',
        targetType: 'order',
        targetId: '42',
        expiredAt: '2026-05-01T10:00:00.000Z',
      },
    });
  });

  it('skips set_overdue_flag when the target resolver rejects the target', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const overdueUpdates: Array<{ deadlineId: string; expiredAt: string }> = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [createRule({ actionType: 'set_overdue_flag' })],
        executions,
        overdueUpdates,
      }),
      targetResolver: createTargetResolver({ canApplyAction: false }),
      notificationPort: createNotificationPort(),
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(overdueUpdates).toEqual([]);
    expect(executions[0]).toMatchObject({
      actionType: 'set_overdue_flag',
      status: 'skipped',
      skipReason: 'target_rejected_action',
    });
  });

  it('skips set_overdue_flag for non-expired deadline events', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const overdueUpdates: Array<{ deadlineId: string; expiredAt: string }> = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent({
        eventType: 'DEADLINE_COMPLETED_LATE',
        severity: 'warning',
      }),
      repository: createRepository({
        rules: [
          createRule({
            actionType: 'set_overdue_flag',
            eventType: 'DEADLINE_COMPLETED_LATE',
          }),
        ],
        executions,
        overdueUpdates,
      }),
      targetResolver: createTargetResolver(),
      notificationPort: createNotificationPort(),
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(overdueUpdates).toEqual([]);
    expect(executions[0]).toMatchObject({
      actionType: 'set_overdue_flag',
      status: 'skipped',
      skipReason: 'unsupported_event_type',
    });
  });

  it('keeps unavailable non-overdue handlers skipped as action_handler_unavailable', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [createRule({ actionType: 'create_task' })],
        executions,
      }),
      targetResolver: createTargetResolver(),
      notificationPort: createNotificationPort(),
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(executions[0]).toMatchObject({
      actionType: 'create_task',
      status: 'skipped',
      skipReason: 'action_handler_unavailable',
    });
  });

  it('does not call notification port when notifications are disabled', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const calls: unknown[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [createRule({ actionType: 'notify_assignee' })],
        executions,
      }),
      targetResolver: createTargetResolver(),
      notificationPort: {
        async createNotification(input) {
          calls.push(input);
          return { created: true, notificationId: 'notification-1' };
        },
      },
      config: { actionsEnabled: true, notificationsEnabled: false },
    });

    expect(calls).toEqual([]);
    expect(executions[0]).toMatchObject({
      actionType: 'notify_assignee',
      status: 'skipped',
      skipReason: 'notifications_disabled',
      idempotencyKey: 'event-1:notify_assignee:order:42',
    });
  });

  it('builds separate action execution idempotency keys per action type', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [
          createRule({ actionRuleId: 'rule-a', actionType: 'write_audit' }),
          createRule({ actionRuleId: 'rule-b', actionType: 'notify_manager' }),
        ],
        executions,
      }),
      targetResolver: createTargetResolver(),
      notificationPort: createNotificationPort(),
      config: { actionsEnabled: false, notificationsEnabled: false },
    });

    expect(executions.map((execution) => execution.idempotencyKey)).toEqual([
      'event-1:write_audit:order:42',
      'event-1:notify_manager:order:42',
    ]);
  });

  it('uses explicit assignee recipient for notify_assignee even when responsible user order differs', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const notifications: unknown[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent({
        eventType: 'DEADLINE_EXPIRED',
        severity: 'critical',
        deadlineAt: '2026-05-23T09:00:00.000Z',
      }),
      repository: createRepository({
        rules: [createRule({ actionType: 'notify_assignee' })],
        executions,
      }),
      targetResolver: createTargetResolver({
        responsibleUserIds: [20, 10],
        notificationRecipients: {
          assigneeUserId: 10,
          managerUserId: 20,
        },
      }),
      notificationPort: {
        async createNotification(input) {
          notifications.push(input);
          return { created: true, notificationId: 'notification-1' };
        },
      },
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(notifications).toEqual([
      {
        userId: 10,
        level: 'error',
        title: 'Deadline expired',
        message: 'Order 42 deadline expired at 2026-05-23T09:00:00.000Z',
        entityType: 'order',
        entityId: '42',
        sourceType: 'deadline',
        sourceId: 'event-1',
        idempotencyKey: 'deadline-notification:event-1:notify_assignee:10',
      },
    ]);
    expect(executions[0]).toMatchObject({
      actionType: 'notify_assignee',
      status: 'executed',
      result: {
        notificationUserId: 10,
        notificationId: 'notification-1',
        notificationCreated: true,
        notificationIdempotencyKey: 'deadline-notification:event-1:notify_assignee:10',
      },
    });
  });

  it('ignores fixture-scoped rules when the event has no matching fixture key', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const notifications: unknown[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    const result = await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [
          createRule({
            actionType: 'notify_assignee',
            config: { fixtureKey: 'fixture-action-rule' },
          }),
        ],
        executions,
      }),
      targetResolver: createTargetResolver(),
      notificationPort: {
        async createNotification(input) {
          notifications.push(input);
          return { created: true, notificationId: 'notification-1' };
        },
      },
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(result).toEqual([]);
    expect(executions).toEqual([]);
    expect(notifications).toEqual([]);
  });

  it('ignores fixture-scoped rules when the event fixture key differs', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const notifications: unknown[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    const result = await dispatcher.dispatch({
      event: createEvent({ payload: { fixtureKey: 'other-fixture' } }),
      repository: createRepository({
        rules: [
          createRule({
            actionType: 'notify_assignee',
            config: { fixtureKey: 'fixture-action-rule' },
          }),
        ],
        executions,
      }),
      targetResolver: createTargetResolver(),
      notificationPort: {
        async createNotification(input) {
          notifications.push(input);
          return { created: true, notificationId: 'notification-1' };
        },
      },
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(result).toEqual([]);
    expect(executions).toEqual([]);
    expect(notifications).toEqual([]);
  });

  it('executes fixture-scoped rules when the event fixture key matches', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const notifications: unknown[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    const result = await dispatcher.dispatch({
      event: createEvent({ payload: { fixtureKey: 'fixture-action-rule' } }),
      repository: createRepository({
        rules: [
          createRule({
            actionType: 'notify_assignee',
            config: { fixtureKey: 'fixture-action-rule' },
          }),
        ],
        executions,
      }),
      targetResolver: createTargetResolver(),
      notificationPort: {
        async createNotification(input) {
          notifications.push(input);
          return { created: true, notificationId: 'notification-1' };
        },
      },
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(result).toHaveLength(1);
    expect(notifications).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      actionType: 'notify_assignee',
      status: 'executed',
    });
  });

  it('uses explicit manager recipient for notify_manager even when responsible user order differs', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const notifications: unknown[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [createRule({ actionType: 'notify_manager' })],
        executions,
      }),
      targetResolver: createTargetResolver({
        responsibleUserIds: [20, 10],
        notificationRecipients: {
          assigneeUserId: 10,
          managerUserId: 20,
        },
      }),
      notificationPort: {
        async createNotification(input) {
          notifications.push(input);
          return { created: true, notificationId: 'notification-1' };
        },
      },
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(notifications).toMatchObject([
      {
        userId: 20,
        idempotencyKey: 'deadline-notification:event-1:notify_manager:20',
      },
    ]);
    expect(executions[0]).toMatchObject({
      actionType: 'notify_manager',
      status: 'executed',
      result: {
        notificationUserId: 20,
        notificationIdempotencyKey: 'deadline-notification:event-1:notify_manager:20',
      },
    });
  });

  it('uses order-style explicit manager recipient as assignee for notify_assignee', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const notifications: unknown[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [createRule({ actionType: 'notify_assignee' })],
        executions,
      }),
      targetResolver: createTargetResolver({
        responsibleUserIds: [42],
        notificationRecipients: {
          assigneeUserId: 42,
          managerUserId: 42,
        },
      }),
      notificationPort: {
        async createNotification(input) {
          notifications.push(input);
          return { created: true, notificationId: 'notification-1' };
        },
      },
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(notifications).toMatchObject([
      {
        userId: 42,
        idempotencyKey: 'deadline-notification:event-1:notify_assignee:42',
      },
    ]);
    expect(executions[0]).toMatchObject({
      actionType: 'notify_assignee',
      status: 'executed',
      result: {
        notificationUserId: 42,
        notificationIdempotencyKey: 'deadline-notification:event-1:notify_assignee:42',
      },
    });
  });

  it('skips notify_manager when explicit manager recipient is missing', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const notifications: unknown[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [createRule({ actionType: 'notify_manager' })],
        executions,
      }),
      targetResolver: createTargetResolver({
        responsibleUserIds: [10],
        notificationRecipients: {
          assigneeUserId: 10,
          managerUserId: null,
        },
      }),
      notificationPort: {
        async createNotification(input) {
          notifications.push(input);
          return { created: true, notificationId: 'notification-1' };
        },
      },
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(notifications).toEqual([]);
    expect(executions[0]).toMatchObject({
      actionType: 'notify_manager',
      status: 'skipped',
      skipReason: 'notification_target_missing',
    });
  });

  it('skips notify_department_head when explicit department head recipient is missing', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const notifications: unknown[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [createRule({ actionType: 'notify_department_head' })],
        executions,
      }),
      targetResolver: createTargetResolver({
        responsibleUserIds: [10, 20],
        notificationRecipients: {
          assigneeUserId: 10,
          managerUserId: 20,
        },
      }),
      notificationPort: {
        async createNotification(input) {
          notifications.push(input);
          return { created: true, notificationId: 'notification-1' };
        },
      },
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(notifications).toEqual([]);
    expect(executions[0]).toMatchObject({
      actionType: 'notify_department_head',
      status: 'skipped',
      skipReason: 'notification_target_missing',
    });
  });

  it('uses explicit department head recipient for notify_department_head', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const notifications: unknown[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [createRule({ actionType: 'notify_department_head' })],
        executions,
      }),
      targetResolver: createTargetResolver({
        responsibleUserIds: [30, 10, 20],
        notificationRecipients: {
          assigneeUserId: 10,
          managerUserId: 20,
          departmentHeadUserId: 30,
        },
      }),
      notificationPort: {
        async createNotification(input) {
          notifications.push(input);
          return { created: true, notificationId: 'notification-1' };
        },
      },
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(notifications).toMatchObject([
      {
        userId: 30,
        idempotencyKey: 'deadline-notification:event-1:notify_department_head:30',
      },
    ]);
    expect(executions[0]).toMatchObject({
      actionType: 'notify_department_head',
      status: 'executed',
      result: {
        notificationUserId: 30,
        notificationIdempotencyKey: 'deadline-notification:event-1:notify_department_head:30',
      },
    });
  });

  it('uses current resolver-style manager recipient as department head for notify_department_head', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const notifications: unknown[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [createRule({ actionType: 'notify_department_head' })],
        executions,
      }),
      targetResolver: createTargetResolver({
        responsibleUserIds: [42],
        notificationRecipients: {
          assigneeUserId: 42,
          managerUserId: 42,
          departmentHeadUserId: 42,
        },
      }),
      notificationPort: {
        async createNotification(input) {
          notifications.push(input);
          return { created: true, notificationId: 'notification-1' };
        },
      },
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(notifications).toMatchObject([
      {
        userId: 42,
        idempotencyKey: 'deadline-notification:event-1:notify_department_head:42',
      },
    ]);
    expect(executions[0]).toMatchObject({
      actionType: 'notify_department_head',
      status: 'executed',
      result: {
        notificationUserId: 42,
        notificationIdempotencyKey: 'deadline-notification:event-1:notify_department_head:42',
      },
    });
  });

  it('falls back to the first responsible user for legacy notify_manager target resolvers', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const notifications: unknown[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [createRule({ actionType: 'notify_manager' })],
        executions,
      }),
      targetResolver: createTargetResolver({
        responsibleUserIds: [20],
      }),
      notificationPort: {
        async createNotification(input) {
          notifications.push(input);
          return { created: true, notificationId: 'notification-1' };
        },
      },
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(notifications).toMatchObject([
      {
        userId: 20,
        idempotencyKey: 'deadline-notification:event-1:notify_manager:20',
      },
    ]);
    expect(executions[0]).toMatchObject({
      actionType: 'notify_manager',
      status: 'executed',
      result: {
        notificationUserId: 20,
        notificationIdempotencyKey: 'deadline-notification:event-1:notify_manager:20',
      },
    });
  });

  it('falls back to the first responsible user for legacy notify_department_head target resolvers', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const notifications: unknown[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [createRule({ actionType: 'notify_department_head' })],
        executions,
      }),
      targetResolver: createTargetResolver({
        responsibleUserIds: [20],
      }),
      notificationPort: {
        async createNotification(input) {
          notifications.push(input);
          return { created: true, notificationId: 'notification-1' };
        },
      },
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(notifications).toMatchObject([
      {
        userId: 20,
        idempotencyKey: 'deadline-notification:event-1:notify_department_head:20',
      },
    ]);
    expect(executions[0]).toMatchObject({
      actionType: 'notify_department_head',
      status: 'executed',
      result: {
        notificationUserId: 20,
        notificationIdempotencyKey: 'deadline-notification:event-1:notify_department_head:20',
      },
    });
  });

  it('records duplicate notification delivery as executed without creating a second execution shape', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [createRule({ actionType: 'notify_assignee' })],
        executions,
      }),
      targetResolver: createTargetResolver({
        responsibleUserIds: [10],
      }),
      notificationPort: {
        async createNotification() {
          return { created: false, notificationId: 'notification-existing' };
        },
      },
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(executions[0]).toMatchObject({
      status: 'executed',
      result: {
        notificationUserId: 10,
        notificationId: 'notification-existing',
        notificationCreated: false,
      },
    });
  });

  it('records unavailable notification port when notification creation fails', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [createRule({ actionType: 'notify_assignee' })],
        executions,
      }),
      targetResolver: createTargetResolver({
        responsibleUserIds: [10],
      }),
      notificationPort: {
        async createNotification() {
          throw new Error('notification service unavailable');
        },
      },
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(executions[0]).toMatchObject({
      actionType: 'notify_assignee',
      status: 'skipped',
      skipReason: 'notification_port_unavailable',
      errorCode: 'Error',
      errorMessage: 'notification service unavailable',
    });
  });
});

function createRepository(input: {
  rules: DeadlineActionRuleDto[];
  executions: DeadlineActionExecutionDto[];
  overdueUpdates?: Array<{ deadlineId: string; expiredAt: string }>;
}): DeadlineRepositoryPort {
  return {
    async listDeadlines() {
      return { data: [], total: 0 };
    },
    async getDeadlineById() {
      return null;
    },
    async getDeadlineByIdForUpdate() {
      return null;
    },
    async listOrderDeadlines() {
      return [];
    },
    async listOrderDeadlineEvents() {
      return [];
    },
    async listPolicies() {
      return [];
    },
    async createPolicy() {
      throw new Error('not implemented');
    },
    async updatePolicy() {
      throw new Error('not implemented');
    },
    async getSettings() {
      throw new Error('not implemented');
    },
    async updateSettings() {
      throw new Error('not implemented');
    },
    async createDeadlineInstance() {
      throw new Error('not implemented');
    },
    async overrideDeadline() {
      throw new Error('not implemented');
    },
    async pauseDeadline() {
      throw new Error('not implemented');
    },
    async resumeDeadline() {
      throw new Error('not implemented');
    },
    async cancelDeadline() {
      throw new Error('not implemented');
    },
    async findDueDeadlinesForUpdate() {
      return [];
    },
    async markDeadlineExpired(markInput) {
      input.overdueUpdates?.push(markInput);
      return createDeadline({
        deadlineId: markInput.deadlineId,
        expiredAt: markInput.expiredAt,
      });
    },
    async markDeadlineCompleted() {
      throw new Error('not implemented');
    },
    async createDeadlineEvent() {
      throw new Error('not implemented');
    },
    async listActionRules() {
      return input.rules;
    },
    async createActionExecution(execution) {
      const dto: DeadlineActionExecutionDto = {
        actionExecutionId: `execution-${input.executions.length + 1}`,
        createdAt: '2026-05-01T10:00:00.000Z',
        ...execution,
      };
      input.executions.push(dto);
      return dto;
    },
  };
}

function createTargetResolver(
  overrides: Partial<{
    responsibleUserIds: number[];
    isCompleted: boolean;
    canApplyAction: boolean;
    notificationRecipients: {
      assigneeUserId?: number | null;
      managerUserId?: number | null;
      departmentHeadUserId?: number | null;
    };
  }> = {},
): DeadlineTargetResolverPort {
  return {
    async resolveTargetState() {
      return {
        isCompleted: overrides.isCompleted ?? false,
        responsibleUserIds: overrides.responsibleUserIds ?? [10],
        auditContext: {},
        ...(overrides.notificationRecipients === undefined
          ? {}
          : { notificationRecipients: overrides.notificationRecipients }),
      };
    },
    async canApplyAction() {
      return overrides.canApplyAction ?? true;
    },
  };
}

function createNotificationPort(): DeadlineNotificationPort {
  return {
    async createNotification() {
      return { created: true, notificationId: 'notification-1' };
    },
  };
}

function createRule(overrides: Partial<DeadlineActionRuleDto> = {}): DeadlineActionRuleDto {
  return {
    actionRuleId: 'rule-1',
    scopeType: 'order',
    eventType: 'DEADLINE_EXPIRED',
    actionType: 'write_audit',
    isEnabled: true,
    config: {},
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}

function createEvent(overrides: Partial<DeadlineEventDto> = {}): DeadlineEventDto {
  return {
    deadlineEventId: 'event-1',
    deadlineId: 'deadline-1',
    eventType: 'DEADLINE_EXPIRED',
    severity: 'critical',
    entityType: 'order',
    entityId: '42',
    orderId: 42,
    deadlineAt: '2026-05-01T09:00:00.000Z',
    eventAt: '2026-05-01T10:00:00.000Z',
    delayMinutes: 60,
    createdAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}

function createDeadline(overrides: Partial<DeadlineInstanceDto> = {}): DeadlineInstanceDto {
  return {
    deadlineId: 'deadline-overdue-1',
    entityType: 'order',
    entityId: '42',
    orderId: 42,
    deadlineAt: '2026-05-01T09:00:00.000Z',
    status: 'expired',
    source: 'system',
    isManuallyOverridden: false,
    expiredAt: '2026-05-01T10:00:00.000Z',
    createdAt: '2026-05-01T09:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}
