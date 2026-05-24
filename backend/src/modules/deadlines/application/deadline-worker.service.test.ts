import { describe, expect, it, vi } from 'vitest';
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
        trigger: 'manual',
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
      trigger: 'manual',
      config: { actionsEnabled: true, notificationsEnabled: true },
    });

    expect(completedStatuses).toEqual(['completed_late']);
    expect(events[0]).toMatchObject({
      eventType: 'DEADLINE_COMPLETED_LATE',
      delayMinutes: 30,
    });
  });

  it('does not create duplicate terminal events on repeated worker runs', async () => {
    const events: DeadlineEventDto[] = [];
    const due = [createDeadline()];
    const repository = createRepository({
      due,
      events,
      executions: [],
      rules: [],
    });
    const worker = new DeadlineWorkerService({
      transactions: transactionManager({
        ...repository,
        async findDueDeadlinesForUpdate() {
          return due.filter((deadline) => deadline.status === 'active');
        },
        async markDeadlineExpired(markInput) {
          due[0] = createDeadline({ status: 'expired', expiredAt: markInput.expiredAt });
          return due[0];
        },
      }),
      targetResolver: createTargetResolver({ isCompleted: false }),
      notificationPort: createNotificationPort(),
    });

    await worker.processDueDeadlines({
      now: '2026-05-01T10:00:00.000Z',
      limit: 100,
      workerId: 'worker-a',
      trigger: 'manual',
      config: { actionsEnabled: false, notificationsEnabled: false },
    });
    await worker.processDueDeadlines({
      now: '2026-05-01T10:01:00.000Z',
      limit: 100,
      workerId: 'worker-a',
      trigger: 'manual',
      config: { actionsEnabled: false, notificationsEnabled: false },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: 'DEADLINE_EXPIRED' });
  });

  it('does not dispatch actions when terminal event creation returns an idempotent duplicate', async () => {
    const existingEvent = createEvent({
      deadlineEventId: 'event-existing',
      eventType: 'DEADLINE_EXPIRED',
    });
    const dispatch = vi.fn();
    const createNotification = vi.fn();
    const notificationPort = createNotificationPort(createNotification);
    const repository = createRepository({
      due: [createDeadline()],
      events: [],
      executions: [],
      rules: [createRule({ actionType: 'notify_user' })],
    });
    const worker = new DeadlineWorkerService({
      transactions: transactionManager({
        ...repository,
        async createDeadlineEvent() {
          return { event: existingEvent, created: false };
        },
      }),
      targetResolver: createTargetResolver({ isCompleted: false }),
      notificationPort,
      dispatcher: { dispatch } as never,
    });

    await expect(
      worker.processDueDeadlines({
        now: '2026-05-01T10:00:00.000Z',
        limit: 100,
        workerId: 'worker-a',
        trigger: 'scheduler',
        schedulerRunId: 'scheduler-run-1',
        config: { actionsEnabled: true, notificationsEnabled: true },
      }),
    ).resolves.toEqual({
      scanned: 1,
      processed: 1,
      expired: 1,
      completed: 0,
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('passes notification-enabled config through worker event dispatch without bypassing action idempotency', async () => {
    const notifications: unknown[] = [];
    const executions: unknown[] = [];
    const repository = createRepository({
      due: [createDeadline({ deadlineId: 'deadline-1', orderId: 42 })],
      events: [],
      executions: executions as DeadlineActionExecutionDto[],
      rules: [createRule({ actionType: 'notify_assignee' })],
    });
    const worker = new DeadlineWorkerService({
      transactions: transactionManager(repository),
      targetResolver: createTargetResolver({ isCompleted: false }),
      notificationPort: {
        async createNotification(input) {
          notifications.push(input);
          return { created: true, notificationId: 'notification-1' };
        },
      },
    });

    await worker.processDueDeadlines({
      now: '2026-05-23T10:00:00.000Z',
      limit: 10,
      workerId: 'worker-notification-test',
      trigger: 'manual',
      actorUserId: '42',
      requestId: 'req-notification-test',
      config: {
        actionsEnabled: true,
        notificationsEnabled: true,
      },
    });

    expect(notifications).toEqual([
      expect.objectContaining({
        userId: 10,
        sourceType: 'deadline',
        idempotencyKey: expect.stringMatching(/^deadline-notification:/),
      }),
    ]);
    expect(executions).toEqual([
      expect.objectContaining({
        status: 'executed',
        actionType: 'notify_assignee',
      }),
    ]);
  });

  it('records worker source, worker id, actor, and request id on expired events', async () => {
    const events: DeadlineEventDto[] = [];
    const repository = createRepository({
      due: [createDeadline()],
      events,
      executions: [],
      rules: [],
    });
    const worker = new DeadlineWorkerService({
      transactions: transactionManager(repository),
      targetResolver: createTargetResolver({ isCompleted: false }),
      notificationPort: createNotificationPort(),
    });

    await worker.processDueDeadlines({
      now: '2026-05-01T10:00:00.000Z',
      limit: 100,
      workerId: 'worker-a',
      trigger: 'manual',
      actorUserId: '42',
      requestId: 'req-worker-1',
      config: { actionsEnabled: false, notificationsEnabled: false },
    });

    expect(events[0]).toMatchObject({
      eventType: 'DEADLINE_EXPIRED',
      payload: {
        status: 'expired',
        source: 'deadline-engine',
        trigger: 'manual',
        workerId: 'worker-a',
        actorUserId: '42',
        requestId: 'req-worker-1',
        schedulerRunId: null,
      },
      idempotencyKey: 'deadline-terminal:deadline-1:DEADLINE_EXPIRED:deadline-engine',
    });
  });

  it('copies deadline fixture key metadata into expired event payload', async () => {
    const events: DeadlineEventDto[] = [];
    const repository = createRepository({
      due: [
        createDeadline({
          metadata: {
            fixtureKey: 'deadline-notification-action-canary-2026-05-24',
          },
        }),
      ],
      events,
      executions: [],
      rules: [],
    });
    const worker = new DeadlineWorkerService({
      transactions: transactionManager(repository),
      targetResolver: createTargetResolver({ isCompleted: false }),
      notificationPort: createNotificationPort(),
    });

    await worker.processDueDeadlines({
      now: '2026-05-01T10:00:00.000Z',
      limit: 100,
      workerId: 'worker-a',
      trigger: 'manual',
      config: { actionsEnabled: false, notificationsEnabled: false },
    });

    expect(events[0].payload).toMatchObject({
      status: 'expired',
      fixtureKey: 'deadline-notification-action-canary-2026-05-24',
    });
  });

  it('marks completed target as completed_on_time when completed before deadline', async () => {
    const events: DeadlineEventDto[] = [];
    const repository = createRepository({
      due: [createDeadline()],
      events,
      executions: [],
      rules: [],
    });
    const worker = new DeadlineWorkerService({
      transactions: transactionManager(repository),
      targetResolver: createTargetResolver({
        isCompleted: true,
        completedAt: '2026-05-01T08:30:00.000Z',
      }),
      notificationPort: createNotificationPort(),
    });

    await worker.processDueDeadlines({
      now: '2026-05-01T10:00:00.000Z',
      limit: 100,
      workerId: 'worker-a',
      trigger: 'scheduler',
      schedulerRunId: 'scheduler-run-1',
      actorUserId: '42',
      requestId: 'req-worker-2',
      config: { actionsEnabled: false, notificationsEnabled: false },
    });

    expect(events[0]).toMatchObject({
      eventType: 'DEADLINE_COMPLETED_ON_TIME',
      delayMinutes: 0,
      payload: {
        status: 'completed_on_time',
        completedAt: '2026-05-01T08:30:00.000Z',
        source: 'deadline-engine',
        trigger: 'scheduler',
        workerId: 'worker-a',
        actorUserId: '42',
        requestId: 'req-worker-2',
        schedulerRunId: 'scheduler-run-1',
      },
      idempotencyKey: 'deadline-terminal:deadline-1:DEADLINE_COMPLETED_ON_TIME:deadline-engine',
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
      return { event, created: true };
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

function createNotificationPort(
  createNotification: DeadlineNotificationPort['createNotification'] = async () => ({
    created: true,
    notificationId: 'notification-1',
  }),
): DeadlineNotificationPort {
  return {
    createNotification,
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
    payload: {},
    idempotencyKey: 'deadline-terminal:deadline-1:DEADLINE_EXPIRED:deadline-engine',
    createdAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
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
