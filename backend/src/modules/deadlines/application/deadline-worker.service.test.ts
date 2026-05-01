import { describe, expect, it } from 'vitest';
import type { DeadlineActionExecutionDto, DeadlineActionRuleDto } from '../dto/deadline-action-rule.dto';
import type { DeadlineEventDto, DeadlineInstanceDto } from '../dto/deadline-instance.dto';
import { DeadlineWorkerService } from './deadline-worker.service';
import type {
  CreateDeadlineEventInput,
  DeadlineNotificationPort,
  DeadlineRepositoryPort,
  DeadlineTargetResolverPort,
  DeadlineTransactionManagerPort,
} from './deadline.types';

describe('DeadlineWorkerService', () => {
  it('marks due active deadline expired, creates event, and records skipped action execution', async () => {
    const events: DeadlineEventDto[] = [];
    const executions: DeadlineActionExecutionDto[] = [];
    const repository = createRepository({
      due: [createDeadline()],
      events,
      executions,
      rules: [createRule({ actionType: 'write_audit' })],
    });
    const worker = new DeadlineWorkerService({
      transactions: transactionManager(repository),
      targetResolver: createTargetResolver({ isCompleted: false }),
      notificationPort: createNotificationPort(),
    });

    await expect(
      worker.processDueDeadlines({
        now: '2026-05-01T10:00:00.000Z',
        limit: 100,
        workerId: 'worker-a',
        config: { actionsEnabled: false, notificationsEnabled: false },
      }),
    ).resolves.toEqual({
      scanned: 1,
      processed: 1,
      expired: 1,
      completed: 0,
    });

    expect(events).toMatchObject([
      {
        eventType: 'DEADLINE_EXPIRED',
        delayMinutes: 60,
      },
    ]);
    expect(executions).toMatchObject([
      {
        status: 'skipped',
        skipReason: 'global_actions_disabled',
      },
    ]);
  });

  it('marks completed targets as completed_on_time or completed_late', async () => {
    const events: DeadlineEventDto[] = [];
    const repository = createRepository({
      due: [createDeadline()],
      events,
      executions: [],
      rules: [],
    });
    const completedStatuses: string[] = [];
    const worker = new DeadlineWorkerService({
      transactions: transactionManager({
        ...repository,
        async markDeadlineCompleted(input) {
          completedStatuses.push(input.status);
          return createDeadline({ status: input.status, completedAt: input.completedAt });
        },
      }),
      targetResolver: createTargetResolver({
        isCompleted: true,
        completedAt: '2026-05-01T09:30:00.000Z',
      }),
      notificationPort: createNotificationPort(),
    });

    await worker.processDueDeadlines({
      now: '2026-05-01T10:00:00.000Z',
      limit: 100,
      workerId: 'worker-a',
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(completedStatuses).toEqual(['completed_late']);
    expect(events[0]).toMatchObject({
      eventType: 'DEADLINE_COMPLETED_LATE',
      delayMinutes: 30,
    });
  });
});

function transactionManager(repository: DeadlineRepositoryPort): DeadlineTransactionManagerPort {
  return {
    async runInTransaction(handler) {
      return handler({ deadlines: repository });
    },
  };
}

function createRepository(input: {
  due: DeadlineInstanceDto[];
  events: DeadlineEventDto[];
  executions: DeadlineActionExecutionDto[];
  rules: DeadlineActionRuleDto[];
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
      return input.due;
    },
    async markDeadlineExpired(markInput) {
      return createDeadline({ status: 'expired', expiredAt: markInput.expiredAt });
    },
    async markDeadlineCompleted(markInput) {
      return createDeadline({ status: markInput.status, completedAt: markInput.completedAt });
    },
    async createDeadlineEvent(eventInput: CreateDeadlineEventInput) {
      const event: DeadlineEventDto = {
        deadlineEventId: `event-${input.events.length + 1}`,
        createdAt: eventInput.eventAt,
        ...eventInput,
      };
      input.events.push(event);
      return event;
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

function createTargetResolver(input: {
  isCompleted: boolean;
  completedAt?: string;
}): DeadlineTargetResolverPort {
  return {
    async resolveTargetState() {
      return {
        isCompleted: input.isCompleted,
        completedAt: input.completedAt,
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
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}

function createDeadline(overrides: Partial<DeadlineInstanceDto> = {}): DeadlineInstanceDto {
  return {
    deadlineId: 'deadline-1',
    entityType: 'order',
    entityId: '42',
    orderId: 42,
    deadlineAt: '2026-05-01T09:00:00.000Z',
    status: 'active',
    source: 'manual',
    isManuallyOverridden: false,
    createdAt: '2026-05-01T08:00:00.000Z',
    updatedAt: '2026-05-01T08:00:00.000Z',
    ...overrides,
  };
}
