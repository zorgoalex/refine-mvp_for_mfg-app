import { describe, expect, it } from 'vitest';
import type { DeadlineActionExecutionDto, DeadlineActionRuleDto } from '../dto/deadline-action-rule.dto';
import type { DeadlineEventDto } from '../dto/deadline-instance.dto';
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

    expect(executions[0]).toMatchObject({
      status: 'skipped',
      skipReason: 'notifications_disabled',
    });
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
});

function createRepository(input: {
  rules: DeadlineActionRuleDto[];
  executions: DeadlineActionExecutionDto[];
}): DeadlineRepositoryPort {
  return {
    async listDeadlines() {
      return { data: [], total: 0 };
    },
    async getDeadlineById() {
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
    async markDeadlineExpired() {
      throw new Error('not implemented');
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

function createTargetResolver(): DeadlineTargetResolverPort {
  return {
    async resolveTargetState() {
      return {
        isCompleted: false,
        responsibleUserIds: [10],
        auditContext: {},
      };
    },
    async canApplyAction() {
      return true;
    },
  };
}

function createNotificationPort(): DeadlineNotificationPort {
  return {
    async createNotification() {},
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

function createEvent(): DeadlineEventDto {
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
  };
}
