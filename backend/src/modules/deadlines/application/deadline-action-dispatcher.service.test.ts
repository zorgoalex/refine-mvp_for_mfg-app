import { describe, expect, it } from 'vitest';
import type {
  DeadlineActionExecutionDto,
  DeadlineActionRuleDto,
  DeadlineOrderOverrideDto,
} from '../dto/deadline-action-rule.dto';
import type { DeadlineEventDto, DeadlineInstanceDto } from '../dto/deadline-instance.dto';
import { DeadlineActionDispatcherService } from './deadline-action-dispatcher.service';
import type {
  DeadlineChangeProductionStatusCommand,
  DeadlineNotificationPort,
  DeadlineRepositoryPort,
  DeadlineTargetResolverPort,
} from './deadline.types';

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
        idempotencyKey: expect.stringContaining('event-1:write_audit:order:42:order:42:rule-1:'),
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

  it('skips notify_* when the notification engine owns DEADLINE_EXPIRED (convergence cutover)', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const notifications: unknown[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [
          createRule({ actionRuleId: 'notify-manager', actionType: 'notify_manager' }),
          createRule({ actionRuleId: 'notify-assignee', actionType: 'notify_assignee' }),
        ],
        executions,
      }),
      targetResolver: createTargetResolver({
        notificationRecipients: { assigneeUserId: 10, managerUserId: 20 },
      }),
      notificationPort: {
        async createNotification(input) {
          notifications.push(input);
          return { created: true, notificationId: 'should-not-be-called' };
        },
      },
      config: { actionsEnabled: true, notificationsEnabled: true, engineOwnsDeadline: true },
    });

    expect(notifications).toEqual([]);
    expect(executions).toHaveLength(2);
    for (const execution of executions) {
      expect(execution).toMatchObject({
        status: 'skipped',
        skipReason: 'owned_by_notification_engine',
      });
      expect(['notify_manager', 'notify_assignee']).toContain(execution.actionType);
    }
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
      idempotencyKey: expect.stringContaining('event-overdue-1:set_overdue_flag:order:42:order:42:rule-1:'),
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

  it('executes change_production_status through the production status action port with target resolver approval', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const productionCommands: DeadlineChangeProductionStatusCommand[] = [];
    const canApplyActions: unknown[] = [];
    const dispatcher = new DeadlineActionDispatcherService({
      productionStatusActionPort: {
        async changeProductionStatusFromDeadline(command) {
          productionCommands.push(command);
          return {
            status: 'executed',
            result: {
              order: {
                orderId: command.orderId,
                productionStatusId: command.targetProductionStatusId,
                version: 5,
              },
            },
          };
        },
      },
    });

    await dispatcher.dispatch({
      event: createEvent({
        deadlineId: 'deadline-production-1',
        deadlineEventId: 'event-production-1',
        eventAt: '2026-05-27T10:00:00.000Z',
        payload: { requestId: 'req-production-status-1' },
      }),
      repository: createRepository({
        rules: [
          createRule({
            actionRuleId: 'production-status-rule',
            actionType: 'change_production_status',
            config: {
              actionConfig: {
                targetProductionStatusId: 6,
                productionStatusScope: 'order',
              },
            },
          }),
        ],
        executions,
      }),
      targetResolver: createTargetResolver({
        onCanApplyAction(input) {
          canApplyActions.push(input);
        },
      }),
      notificationPort: createNotificationPort(),
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(canApplyActions).toEqual([
      {
        actionType: 'change_production_status',
        target: {
          entityType: 'order',
          entityId: '42',
          orderId: 42,
          orderWorkshopId: undefined,
          clientId: undefined,
        },
      },
    ]);
    expect(productionCommands).toEqual([
      expect.objectContaining({
        source: 'deadline-engine',
        systemActor: {
          type: 'system',
          actorUserId: null,
          actorLabel: 'deadline-engine',
        },
        orderId: 42,
        targetProductionStatusId: 6,
        productionStatusScope: 'order',
        deadlineId: 'deadline-production-1',
        deadlineEventId: 'event-production-1',
        actionRuleId: 'production-status-rule',
        occurredAt: '2026-05-27T10:00:00.000Z',
        requestId: 'req-production-status-1',
      }),
    ]);
    expect(executions[0]).toMatchObject({
      actionRuleId: 'production-status-rule',
      actionType: 'change_production_status',
      status: 'executed',
      skipReason: null,
      orderId: 42,
      targetStatusId: 6,
      result: { order: { orderId: 42, productionStatusId: 6, version: 5 } },
      ruleConfigSnapshot: {
        actionType: 'change_production_status',
        actionConfig: {
          targetProductionStatusId: 6,
          productionStatusScope: 'order',
        },
      },
    });
    expect(executions[0].idempotencyKey).toContain(
      'event-production-1:change_production_status:order:42:order:42:production-status-rule:6:',
    );
  });

  it('skips change_production_status when target resolver rejects the target', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const productionCommands: DeadlineChangeProductionStatusCommand[] = [];
    const dispatcher = new DeadlineActionDispatcherService({
      productionStatusActionPort: {
        async changeProductionStatusFromDeadline(command) {
          productionCommands.push(command);
          return { status: 'executed', result: {} };
        },
      },
    });

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [
          createRule({
            actionType: 'change_production_status',
            config: {
              actionConfig: {
                targetProductionStatusId: 6,
                productionStatusScope: 'order',
              },
            },
          }),
        ],
        executions,
      }),
      targetResolver: createTargetResolver({ canApplyAction: false }),
      notificationPort: createNotificationPort(),
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(productionCommands).toEqual([]);
    expect(executions[0]).toMatchObject({
      actionType: 'change_production_status',
      status: 'skipped',
      skipReason: 'target_rejected_action',
      targetStatusId: 6,
    });
  });

  it('skips change_production_status when target production status is missing', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const dispatcher = new DeadlineActionDispatcherService({
      productionStatusActionPort: {
        async changeProductionStatusFromDeadline() {
          throw new Error('production status action should not run');
        },
      },
    });

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [
          createRule({
            actionType: 'change_production_status',
            config: {
              actionConfig: {
                productionStatusScope: 'order',
              },
            },
          }),
        ],
        executions,
      }),
      targetResolver: createTargetResolver(),
      notificationPort: createNotificationPort(),
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(executions[0]).toMatchObject({
      actionType: 'change_production_status',
      status: 'skipped',
      skipReason: 'missing_target_production_status',
    });
  });

  it('records one selected change_order_status candidate as unavailable and does not loop status handlers', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const canApplyActions: unknown[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [
          createRule({
            actionRuleId: 'status-lower-priority',
            actionType: 'change_order_status',
            priority: 20,
            config: {
              conditions: { allowedFromOrderStatusIds: [1] },
              actionConfig: { targetOrderStatusId: 8 },
            },
          }),
          createRule({
            actionRuleId: 'status-selected',
            actionType: 'change_order_status',
            priority: 10,
            config: {
              conditions: { allowedFromOrderStatusIds: [1] },
              actionConfig: { targetOrderStatusId: 7 },
            },
          }),
        ],
        executions,
        orderContext: { orderId: 42, orderStatusId: 1, isCompleted: false },
        isCurrentDeadlineEvent: true,
      }),
      targetResolver: createTargetResolver({
        onCanApplyAction(input) {
          canApplyActions.push(input);
        },
      }),
      notificationPort: createNotificationPort(),
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(canApplyActions).toEqual([]);
    expect(executions).toMatchObject([
      {
        actionRuleId: 'status-selected',
        actionType: 'change_order_status',
        status: 'skipped',
        skipReason: 'action_handler_unavailable',
        targetStatusId: 7,
      },
      {
        actionRuleId: 'status-lower-priority',
        actionType: 'change_order_status',
        status: 'skipped',
        skipReason: 'lower_priority_rule_not_selected',
        targetStatusId: 8,
      },
    ]);
  });

  it('executes selected change_order_status through internal status action port once', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const statusCommands: unknown[] = [];
    const dispatcher = new DeadlineActionDispatcherService({
      statusActionPort: {
        async changeOrderStatusFromDeadline(command) {
          statusCommands.push(command);
          return {
            status: 'executed',
            result: { order: { orderId: command.orderId, orderStatusId: command.targetOrderStatusId, version: 4 } },
          };
        },
      },
    });

    await dispatcher.dispatch({
      event: createEvent({
        deadlineId: 'deadline-status-1',
        deadlineEventId: 'event-status-1',
        eventAt: '2026-05-25T10:00:00.000Z',
      }),
      repository: createRepository({
        rules: [
          createRule({
            actionRuleId: 'status-selected',
            actionType: 'change_order_status',
            priority: 10,
            config: {
              conditions: { allowedFromOrderStatusIds: [1] },
              actionConfig: { targetOrderStatusId: 7 },
            },
          }),
          createRule({
            actionRuleId: 'status-lower',
            actionType: 'change_order_status',
            priority: 20,
            config: {
              conditions: { allowedFromOrderStatusIds: [1] },
              actionConfig: { targetOrderStatusId: 8 },
            },
          }),
        ],
        executions,
        orderContext: { orderId: 42, orderStatusId: 1, isCompleted: false },
      }),
      targetResolver: createTargetResolver(),
      notificationPort: createNotificationPort(),
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(statusCommands).toEqual([
      expect.objectContaining({
        source: 'deadline-engine',
        systemActor: {
          type: 'system',
          actorUserId: null,
          actorLabel: 'deadline-engine',
        },
        orderId: 42,
        expectedSourceOrderStatusId: 1,
        targetOrderStatusId: 7,
        deadlineId: 'deadline-status-1',
        deadlineEventId: 'event-status-1',
        actionRuleId: 'status-selected',
        occurredAt: '2026-05-25T10:00:00.000Z',
      }),
    ]);
    expect(executions).toMatchObject([
      {
        actionRuleId: 'status-selected',
        status: 'executed',
        skipReason: null,
        result: { order: { orderId: 42, orderStatusId: 7, version: 4 } },
      },
      {
        actionRuleId: 'status-lower',
        status: 'skipped',
        skipReason: 'lower_priority_rule_not_selected',
      },
    ]);
  });

  it('records selected change_order_status as skipped when internal command returns no-op', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const dispatcher = new DeadlineActionDispatcherService({
      statusActionPort: {
        async changeOrderStatusFromDeadline(command) {
          return {
            status: 'skipped',
            skipReason: 'same_status',
            result: { order: { orderId: command.orderId, orderStatusId: command.targetOrderStatusId, version: 3 } },
          };
        },
      },
    });

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [
          createRule({
            actionRuleId: 'status-selected',
            actionType: 'change_order_status',
            config: {
              conditions: { allowedFromOrderStatusIds: [1] },
              actionConfig: { targetOrderStatusId: 1 },
            },
          }),
        ],
        executions,
        orderContext: { orderId: 42, orderStatusId: 1, isCompleted: false },
      }),
      targetResolver: createTargetResolver(),
      notificationPort: createNotificationPort(),
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(executions[0]).toMatchObject({
      actionRuleId: 'status-selected',
      status: 'skipped',
      skipReason: 'same_status',
      result: { order: { orderId: 42, orderStatusId: 1, version: 3 } },
    });
  });

  it('fails closed for stale status rules that opt out of current-event enforcement', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const currentEventChecks: unknown[] = [];
    const statusCommands: unknown[] = [];
    const dispatcher = new DeadlineActionDispatcherService({
      statusActionPort: {
        async changeOrderStatusFromDeadline(command) {
          statusCommands.push(command);
          return { status: 'executed', result: {} };
        },
      },
    });

    await dispatcher.dispatch({
      event: createEvent({
        deadlineId: 'deadline-stale-default',
        deadlineEventId: 'event-stale-default',
      }),
      repository: createRepository({
        rules: [
          createRule({
            actionRuleId: 'status-stale-default',
            actionType: 'change_order_status',
            config: {
              conditions: {
                allowedFromOrderStatusIds: [1],
                requireCurrentDeadlineEvent: false,
              },
              actionConfig: { targetOrderStatusId: 7 },
            },
          }),
        ],
        executions,
        orderContext: { orderId: 42, orderStatusId: 1, isCompleted: false },
        isCurrentDeadlineEvent: false,
        currentEventChecks,
      }),
      targetResolver: createTargetResolver(),
      notificationPort: createNotificationPort(),
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(currentEventChecks).toEqual([
      {
        orderId: 42,
        deadlineId: 'deadline-stale-default',
        deadlineEventId: 'event-stale-default',
      },
    ]);
    expect(statusCommands).toEqual([]);
    expect(executions[0]).toMatchObject({
      actionRuleId: 'status-stale-default',
      status: 'skipped',
      skipReason: 'unsafe_rule_config',
    });
  });

  it('skips order-backed status transitions when order evaluation context is unavailable', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const statusCommands: unknown[] = [];
    const dispatcher = new DeadlineActionDispatcherService({
      statusActionPort: {
        async changeOrderStatusFromDeadline(command) {
          statusCommands.push(command);
          return { status: 'executed', result: {} };
        },
      },
    });

    await dispatcher.dispatch({
      event: createEvent({ orderId: 42 }),
      repository: createRepository({
        rules: [
          createRule({
            actionRuleId: 'status-missing-order',
            actionType: 'change_order_status',
            config: {
              conditions: { allowedFromOrderStatusIds: [1] },
              actionConfig: { targetOrderStatusId: 7 },
            },
          }),
        ],
        executions,
        orderContext: null,
      }),
      targetResolver: createTargetResolver(),
      notificationPort: createNotificationPort(),
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(statusCommands).toEqual([]);
    expect(executions[0]).toMatchObject({
      actionRuleId: 'status-missing-order',
      status: 'skipped',
      skipReason: 'stale_deadline_event',
    });
  });

  it('records invalid target status from internal command as skipped guard outcome', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const dispatcher = new DeadlineActionDispatcherService({
      statusActionPort: {
        async changeOrderStatusFromDeadline() {
          const error = new Error('Status not found or inactive') as Error & { code: string };
          error.code = 'VALIDATION_ERROR';
          throw error;
        },
      },
    });

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [
          createRule({
            actionRuleId: 'status-invalid-target',
            actionType: 'change_order_status',
            config: {
              conditions: { allowedFromOrderStatusIds: [1] },
              actionConfig: { targetOrderStatusId: 777 },
            },
          }),
        ],
        executions,
        orderContext: { orderId: 42, orderStatusId: 1, isCompleted: false },
      }),
      targetResolver: createTargetResolver(),
      notificationPort: createNotificationPort(),
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(executions[0]).toMatchObject({
      actionRuleId: 'status-invalid-target',
      status: 'skipped',
      skipReason: 'invalid_target_status',
      errorCode: 'invalid_target_status',
      errorMessage: 'Status not found or inactive',
    });
  });

  it('keeps notification actions multi-dispatchable alongside status first-wins evaluation', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const notifications: unknown[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [
          createRule({
            actionRuleId: 'status-selected',
            actionType: 'change_order_status',
            priority: 1,
            config: {
              conditions: { allowedFromOrderStatusIds: [1] },
              actionConfig: { targetOrderStatusId: 7 },
            },
          }),
          createRule({ actionRuleId: 'notify-assignee', actionType: 'notify_assignee', priority: 2 }),
          createRule({ actionRuleId: 'notify-manager', actionType: 'notify_manager', priority: 3 }),
        ],
        executions,
        orderContext: { orderId: 42, orderStatusId: 1, isCompleted: false },
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
          return { created: true, notificationId: `notification-${notifications.length}` };
        },
      },
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(notifications).toHaveLength(2);
    expect(executions.map((execution) => [
      execution.actionRuleId,
      execution.actionType,
      execution.status,
      execution.skipReason ?? null,
    ])).toEqual([
      ['status-selected', 'change_order_status', 'skipped', 'action_handler_unavailable'],
      ['notify-assignee', 'notify_assignee', 'executed', null],
      ['notify-manager', 'notify_manager', 'executed', null],
    ]);
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
      idempotencyKey: expect.stringContaining('event-1:notify_assignee:order:42:order:42:rule-1:'),
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
      expect.stringContaining('event-1:write_audit:order:42:order:42:rule-a:'),
      expect.stringContaining('event-1:notify_manager:order:42:order:42:rule-b:'),
    ]);
  });

  it('builds rule-specific action execution idempotency keys for same action type candidates', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [
          createRule({ actionRuleId: 'rule-audit-a', actionType: 'write_audit', priority: 1 }),
          createRule({ actionRuleId: 'rule-audit-b', actionType: 'write_audit', priority: 2 }),
          createRule({
            actionRuleId: 'rule-status-a',
            actionType: 'change_order_status',
            priority: 3,
            config: {
              conditions: { allowedFromOrderStatusIds: [1] },
              actionConfig: { targetOrderStatusId: 7 },
            },
          }),
          createRule({
            actionRuleId: 'rule-status-b',
            actionType: 'change_order_status',
            priority: 4,
            config: {
              conditions: { allowedFromOrderStatusIds: [1] },
              actionConfig: { targetOrderStatusId: 8 },
            },
          }),
        ],
        executions,
      }),
      targetResolver: createTargetResolver(),
      notificationPort: createNotificationPort(),
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(new Set(executions.map((execution) => execution.idempotencyKey)).size).toBe(4);
    expect(executions.map((execution) => execution.idempotencyKey)).toEqual([
      expect.stringContaining('event-1:write_audit:order:42:order:42:rule-audit-a:'),
      expect.stringContaining('event-1:write_audit:order:42:order:42:rule-audit-b:'),
      expect.stringContaining('event-1:change_order_status:order:42:order:42:rule-status-a:source:1:7:'),
      expect.stringContaining('event-1:change_order_status:order:42:order:42:rule-status-b:source:1:8:'),
    ]);
  });

  it('builds rule-specific action execution idempotency keys for repeated notification action types', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [
          createRule({ actionRuleId: 'notify-a', actionType: 'notify_assignee', priority: 1 }),
          createRule({ actionRuleId: 'notify-b', actionType: 'notify_assignee', priority: 2 }),
        ],
        executions,
      }),
      targetResolver: createTargetResolver(),
      notificationPort: createNotificationPort(),
      config: { actionsEnabled: true, notificationsEnabled: false },
    });

    expect(executions.map((execution) => execution.idempotencyKey)).toEqual([
      expect.stringContaining('event-1:notify_assignee:order:42:order:42:notify-a:'),
      expect.stringContaining('event-1:notify_assignee:order:42:order:42:notify-b:'),
    ]);
  });

  it('records rule snapshot and order evidence on dispatcher-created executions', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent({ orderId: 42 }),
      repository: createRepository({
        rules: [
          createRule({
            actionRuleId: 'rule-change-status',
            actionType: 'change_order_status',
            priority: 10,
            config: {
              conditions: {
                allowedFromOrderStatusIds: [1, 2],
                excludeCompletedOrders: true,
                requireCurrentDeadlineEvent: true,
              },
              actionConfig: {
                targetOrderStatusId: 7,
              },
            },
            createdAt: '2026-05-01T09:00:00.000Z',
            updatedAt: '2026-05-01T09:30:00.000Z',
          }),
        ],
        executions,
      }),
      targetResolver: createTargetResolver({ canApplyAction: false }),
      notificationPort: createNotificationPort(),
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(executions[0]).toMatchObject({
      actionRuleId: 'rule-change-status',
      orderId: 42,
      targetStatusId: 7,
      ruleConfigSnapshot: {
        actionRuleId: 'rule-change-status',
        priority: 10,
        eventType: 'DEADLINE_EXPIRED',
        actionType: 'change_order_status',
        conditions: {
          allowedFromOrderStatusIds: [1, 2],
          excludeCompletedOrders: true,
          requireCurrentDeadlineEvent: true,
        },
        actionConfig: {
          targetOrderStatusId: 7,
        },
        createdAt: '2026-05-01T09:00:00.000Z',
        updatedAt: '2026-05-01T09:30:00.000Z',
        snapshotHash: expect.stringMatching(/^sha256:/),
      },
    });
  });

  it('builds deterministic snapshot hashes for equivalent configs with different key order', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const dispatcher = new DeadlineActionDispatcherService();
    const baseRule = {
      actionRuleId: 'rule-deterministic-hash',
      actionType: 'change_order_status' as const,
      priority: 10,
      createdAt: '2026-05-01T09:00:00.000Z',
      updatedAt: '2026-05-01T09:30:00.000Z',
    };

    await dispatcher.dispatch({
      event: createEvent({ orderId: 42 }),
      repository: createRepository({
        rules: [
          createRule({
            ...baseRule,
            config: {
              conditions: {
                allowedFromOrderStatusIds: [1, 2],
                excludeCompletedOrders: true,
                requireCurrentDeadlineEvent: true,
              },
              actionConfig: {
                targetOrderStatusId: 7,
              },
            },
          }),
          createRule({
            ...baseRule,
            config: {
              actionConfig: {
                targetOrderStatusId: 7,
              },
              conditions: {
                requireCurrentDeadlineEvent: true,
                excludeCompletedOrders: true,
                allowedFromOrderStatusIds: [1, 2],
              },
            },
          }),
        ],
        executions,
      }),
      targetResolver: createTargetResolver({ canApplyAction: false }),
      notificationPort: createNotificationPort(),
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(executions).toHaveLength(2);
    expect(executions[0].ruleConfigSnapshot?.snapshotHash).toMatch(/^sha256:/);
    expect(executions[0].ruleConfigSnapshot?.snapshotHash).toBe(
      executions[1].ruleConfigSnapshot?.snapshotHash,
    );
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

  it('executes escalate by notifying the explicit manager recipient after target approval', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const notifications: unknown[] = [];
    const canApplyActions: unknown[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent({
        eventType: 'DEADLINE_EXPIRED',
        severity: 'critical',
        deadlineAt: '2026-05-23T09:00:00.000Z',
      }),
      repository: createRepository({
        rules: [createRule({ actionRuleId: 'escalate-rule', actionType: 'escalate' })],
        executions,
      }),
      targetResolver: createTargetResolver({
        responsibleUserIds: [10, 20],
        notificationRecipients: {
          assigneeUserId: 10,
          managerUserId: 20,
        },
        onCanApplyAction(input) {
          canApplyActions.push(input);
        },
      }),
      notificationPort: {
        async createNotification(input) {
          notifications.push(input);
          return { created: true, notificationId: 'notification-escalation-1' };
        },
      },
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(canApplyActions).toEqual([
      {
        actionType: 'escalate',
        target: {
          entityType: 'order',
          entityId: '42',
          orderId: 42,
          orderWorkshopId: undefined,
          clientId: undefined,
        },
      },
    ]);
    expect(notifications).toEqual([
      {
        userId: 20,
        level: 'error',
        title: 'Deadline escalation',
        message: 'Order 42 deadline escalated after missing 2026-05-23T09:00:00.000Z',
        entityType: 'order',
        entityId: '42',
        sourceType: 'deadline',
        sourceId: 'event-1',
        idempotencyKey: 'deadline-notification:event-1:escalate:20',
      },
    ]);
    expect(executions[0]).toMatchObject({
      actionRuleId: 'escalate-rule',
      actionType: 'escalate',
      status: 'executed',
      skipReason: null,
      result: {
        escalatedUserId: 20,
        notificationId: 'notification-escalation-1',
        notificationCreated: true,
        notificationIdempotencyKey: 'deadline-notification:event-1:escalate:20',
      },
    });
  });

  it('skips escalate without notification mutation when notifications are disabled', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const notifications: unknown[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [createRule({ actionType: 'escalate' })],
        executions,
      }),
      targetResolver: createTargetResolver({
        notificationRecipients: {
          assigneeUserId: 10,
          managerUserId: 20,
        },
      }),
      notificationPort: {
        async createNotification(input) {
          notifications.push(input);
          return { created: true, notificationId: 'notification-escalation-1' };
        },
      },
      config: { actionsEnabled: true, notificationsEnabled: false },
    });

    expect(notifications).toEqual([]);
    expect(executions[0]).toMatchObject({
      actionType: 'escalate',
      status: 'skipped',
      skipReason: 'notifications_disabled',
    });
  });

  it('skips escalate when the notification engine owns DEADLINE_EXPIRED (convergence cutover)', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const notifications: unknown[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [createRule({ actionType: 'escalate' })],
        executions,
      }),
      targetResolver: createTargetResolver({
        notificationRecipients: {
          assigneeUserId: 10,
          managerUserId: 20,
        },
      }),
      notificationPort: {
        async createNotification(input) {
          notifications.push(input);
          return { created: true, notificationId: 'should-not-be-called' };
        },
      },
      config: { actionsEnabled: true, notificationsEnabled: true, engineOwnsDeadline: true },
    });

    expect(notifications).toEqual([]);
    expect(executions[0]).toMatchObject({
      actionType: 'escalate',
      status: 'skipped',
      skipReason: 'owned_by_notification_engine',
    });
  });

  it('skips escalate when explicit manager recipient is missing', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const notifications: unknown[] = [];
    const dispatcher = new DeadlineActionDispatcherService();

    await dispatcher.dispatch({
      event: createEvent(),
      repository: createRepository({
        rules: [createRule({ actionType: 'escalate' })],
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
          return { created: true, notificationId: 'notification-escalation-1' };
        },
      },
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(notifications).toEqual([]);
    expect(executions[0]).toMatchObject({
      actionType: 'escalate',
      status: 'skipped',
      skipReason: 'escalation_target_missing',
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

  describe('orderContext fetching for set_overdue_flag/change_production_status conditions', () => {
    it('fetches orderContext and gates a set_overdue_flag rule with excludeCompletedOrders', async () => {
      const executions: DeadlineActionExecutionDto[] = [];
      const overdueUpdates: Array<{ deadlineId: string; expiredAt: string }> = [];
      const currentEventChecks: unknown[] = [];
      const dispatcher = new DeadlineActionDispatcherService();

      await dispatcher.dispatch({
        event: createEvent(),
        repository: createRepository({
          rules: [
            createRule({
              actionRuleId: 'overdue-completed-guard',
              actionType: 'set_overdue_flag',
              config: { conditions: { excludeCompletedOrders: true } },
            }),
          ],
          executions,
          overdueUpdates,
          orderContext: { orderId: 42, orderStatusId: 90, isCompleted: true },
          currentEventChecks,
        }),
        targetResolver: createTargetResolver(),
        notificationPort: createNotificationPort(),
        config: { actionsEnabled: true, notificationsEnabled: true },
      });

      expect(overdueUpdates).toEqual([]);
      expect(executions[0]).toMatchObject({
        actionRuleId: 'overdue-completed-guard',
        actionType: 'set_overdue_flag',
        status: 'skipped',
        skipReason: 'order_completed',
      });
    });

    it('REGRESSION: set_overdue_flag rule with no conditions still executes when other rules need orderContext', async () => {
      const executions: DeadlineActionExecutionDto[] = [];
      const overdueUpdates: Array<{ deadlineId: string; expiredAt: string }> = [];
      const dispatcher = new DeadlineActionDispatcherService();

      await dispatcher.dispatch({
        event: createEvent({
          deadlineEventId: 'event-overdue-2',
          deadlineId: 'deadline-overdue-2',
          eventAt: '2026-05-01T10:00:00.000Z',
        }),
        repository: createRepository({
          rules: [
            createRule({ actionRuleId: 'overdue-no-conditions', actionType: 'set_overdue_flag', config: {} }),
            createRule({
              actionRuleId: 'production-with-conditions',
              actionType: 'change_production_status',
              config: {
                conditions: { excludeCompletedOrders: true },
                actionConfig: { targetProductionStatusId: 6, productionStatusScope: 'order' },
              },
            }),
          ],
          executions,
          overdueUpdates,
          orderContext: { orderId: 42, orderStatusId: 10, isCompleted: false },
        }),
        targetResolver: createTargetResolver(),
        notificationPort: createNotificationPort(),
        config: { actionsEnabled: true, notificationsEnabled: true },
      });

      expect(overdueUpdates).toEqual([
        { deadlineId: 'deadline-overdue-2', expiredAt: '2026-05-01T10:00:00.000Z' },
      ]);
      expect(executions.find((e) => e.actionRuleId === 'overdue-no-conditions')).toMatchObject({
        status: 'executed',
      });
    });

    it('does not fetch orderContext for non-order targets even with set_overdue_flag conditions configured', async () => {
      const executions: DeadlineActionExecutionDto[] = [];
      const overdueUpdates: Array<{ deadlineId: string; expiredAt: string }> = [];
      const orderContextCalls: number[] = [];
      const dispatcher = new DeadlineActionDispatcherService();

      await dispatcher.dispatch({
        event: createEvent({
          entityType: 'project',
          entityId: 'group-1',
          orderId: undefined,
        }),
        repository: {
          ...createRepository({
            rules: [
              createRule({
                actionRuleId: 'overdue-group-rule',
                actionType: 'set_overdue_flag',
                config: { conditions: { excludeCompletedOrders: true } },
              }),
            ],
            executions,
            overdueUpdates,
          }),
          async getOrderDeadlineEvaluationContext(orderId: number) {
            orderContextCalls.push(orderId);
            return { orderId, orderStatusId: 1, isCompleted: false };
          },
        },
        targetResolver: createTargetResolver(),
        notificationPort: createNotificationPort(),
        config: { actionsEnabled: true, notificationsEnabled: true },
      });

      expect(orderContextCalls).toEqual([]);
      // No orderContext -> hasConditions is true but orderContext is null and
      // orderContextUnavailable is false (no orderId on the event at all) ->
      // missing_order_id, NOT executed, NOT a DB write.
      expect(overdueUpdates).toEqual([]);
      expect(executions[0]).toMatchObject({
        actionRuleId: 'overdue-group-rule',
        actionType: 'set_overdue_flag',
        status: 'skipped',
        skipReason: 'missing_order_id',
      });
    });

    it('HOT PATH: a set_overdue_flag rule with no conditions triggers zero orderContext/isCurrentDeadlineEvent calls', async () => {
      const executions: DeadlineActionExecutionDto[] = [];
      const overdueUpdates: Array<{ deadlineId: string; expiredAt: string }> = [];
      const orderContextCalls: number[] = [];
      const currentEventCalls: unknown[] = [];
      const dispatcher = new DeadlineActionDispatcherService();

      await dispatcher.dispatch({
        event: createEvent(),
        repository: {
          ...createRepository({
            rules: [
              createRule({ actionRuleId: 'overdue-no-conditions', actionType: 'set_overdue_flag', config: {} }),
            ],
            executions,
            overdueUpdates,
          }),
          async getOrderDeadlineEvaluationContext(orderId: number) {
            orderContextCalls.push(orderId);
            return { orderId, orderStatusId: 1, isCompleted: false };
          },
          async isDeadlineEventCurrentForOrder(input: unknown) {
            currentEventCalls.push(input);
            return true;
          },
        },
        targetResolver: createTargetResolver(),
        notificationPort: createNotificationPort(),
        config: { actionsEnabled: true, notificationsEnabled: true },
      });

      expect(orderContextCalls).toEqual([]);
      expect(currentEventCalls).toEqual([]);
      expect(executions[0]).toMatchObject({ actionRuleId: 'overdue-no-conditions', status: 'executed' });
      expect(overdueUpdates).not.toEqual([]);
    });

    it('EDGE CASE: a set_overdue_flag rule with ONLY requireCurrentDeadlineEvent:false triggers zero orderContext calls and still runs', async () => {
      const executions: DeadlineActionExecutionDto[] = [];
      const overdueUpdates: Array<{ deadlineId: string; expiredAt: string }> = [];
      const orderContextCalls: number[] = [];
      const dispatcher = new DeadlineActionDispatcherService();

      await dispatcher.dispatch({
        event: createEvent(),
        repository: {
          ...createRepository({
            rules: [
              createRule({
                actionRuleId: 'overdue-no-staleness-gate',
                actionType: 'set_overdue_flag',
                config: { conditions: { requireCurrentDeadlineEvent: false } },
              }),
            ],
            executions,
            overdueUpdates,
          }),
          async getOrderDeadlineEvaluationContext(orderId: number) {
            orderContextCalls.push(orderId);
            return { orderId, orderStatusId: 1, isCompleted: false };
          },
        },
        targetResolver: createTargetResolver(),
        notificationPort: createNotificationPort(),
        config: { actionsEnabled: true, notificationsEnabled: true },
      });

      expect(orderContextCalls).toEqual([]);
      expect(executions[0]).toMatchObject({ actionRuleId: 'overdue-no-staleness-gate', status: 'executed' });
      expect(overdueUpdates).not.toEqual([]);
    });
  });
});

function createRepository(input: {
  rules: DeadlineActionRuleDto[];
  executions: DeadlineActionExecutionDto[];
  overdueUpdates?: Array<{ deadlineId: string; expiredAt: string }>;
  overrides?: DeadlineOrderOverrideDto[];
  orderContext?: { orderId: number; orderStatusId: number; isCompleted: boolean } | null;
  isCurrentDeadlineEvent?: boolean;
  currentEventChecks?: unknown[];
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
    async listOrderOverrides() {
      return input.overrides ?? [];
    },
    async listOrderActionRuleOverrides() {
      return input.overrides ?? [];
    },
    async upsertOrderOverride() {
      throw new Error('not implemented');
    },
    async retireOrderOverride() {
      throw new Error('not implemented');
    },
    async listGlobalTransitionRules() {
      return input.rules;
    },
    async updateGlobalTransitionRule() {
      throw new Error('not implemented');
    },
    async getOrderDeadlineEvaluationContext(orderId: number) {
      if (input.orderContext === null) {
        return null;
      }
      return input.orderContext ?? { orderId, orderStatusId: 1, isCompleted: false };
    },
    async isDeadlineEventCurrentForOrder(query) {
      input.currentEventChecks?.push(query);
      return input.isCurrentDeadlineEvent ?? true;
    },
  };
}

function createTargetResolver(
  overrides: Partial<{
    responsibleUserIds: number[];
    isCompleted: boolean;
    canApplyAction: boolean;
    onCanApplyAction: (input: Parameters<DeadlineTargetResolverPort['canApplyAction']>[0]) => void;
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
    async canApplyAction(input) {
      overrides.onCanApplyAction?.(input);
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
  const result: DeadlineActionRuleDto = {
    actionRuleId: 'rule-1',
    scopeType: 'order',
    eventType: 'DEADLINE_EXPIRED',
    actionType: 'write_audit',
    isEnabled: true,
    priority: 100,
    config: {},
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
  if (result.actionType === 'change_order_status') {
    result.config = {
      ...(result.config ?? {}),
      conditions: {
        excludeCompletedOrders: true,
        requireCurrentDeadlineEvent: true,
        ...(result.config?.conditions ?? {}),
      },
    };
  }
  return result;
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
