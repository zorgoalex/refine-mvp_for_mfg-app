import { describe, expect, it, vi } from 'vitest';
import type { DeadlineActionExecutionDto, DeadlineActionRuleDto } from '../dto/deadline-action-rule.dto';
import type { DeadlineEventDto, DeadlineInstanceDto } from '../dto/deadline-instance.dto';
import { DeadlineWorkerService } from './deadline-worker.service';
import type {
  CreateDeadlineEventInput,
  DeadlineChangeOrderStatusCommand,
  DeadlineChangeProductionStatusCommand,
  DeadlineNotificationPort,
  DeadlineRepositoryPort,
  DeadlineUnitOfWork,
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

  it('notifies group overdue adapter only after a newly persisted DEADLINE_EXPIRED event', async () => {
    const calls: unknown[] = [];
    const events: DeadlineEventDto[] = [];
    const repository = createRepository({
      due: [createDeadline({ deadlineId: deadlineUuid('1'), orderId: 42 })],
      events,
      executions: [],
      rules: [],
    });
    const worker = new DeadlineWorkerService({
      transactions: transactionManager(repository),
      targetResolver: createTargetResolver({ isCompleted: false }),
      notificationPort: createNotificationPort(),
      groupDeadlineOverduePort: {
        async notifyDeadlineOverdue(input) {
          calls.push(input);
        },
      },
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

    expect(calls).toEqual([
      expect.objectContaining({
        deadlineEventId: 'event-1',
        deadlineInstanceId: deadlineUuid('1'),
        orderId: '42',
        actorUserId: '42',
        requestId: 'req-worker-1',
      }),
    ]);
  });

  it('rolls back the newly persisted DEADLINE_EXPIRED event when group overdue adapter fails', async () => {
    const events: DeadlineEventDto[] = [];
    const groupSideEffects: string[] = [];
    const repository = createRepository({
      due: [createDeadline({ deadlineId: deadlineUuid('1'), orderId: 42 })],
      events,
      executions: [],
      rules: [],
    });
    const worker = new DeadlineWorkerService({
      transactions: eventRollbackTransactionManager({
        repository,
        events,
        groupSideEffects,
        groupDeadlineOverduePort: {
          async notifyDeadlineOverdue(input) {
            groupSideEffects.push(`reserved:${input.deadlineEventId}`);
            throw new Error('group overdue adapter unavailable');
          },
        },
      }),
      targetResolver: createTargetResolver({ isCompleted: false }),
      notificationPort: createNotificationPort(),
    });

    await expect(worker.processDueDeadlines({
      now: '2026-05-01T10:00:00.000Z',
      limit: 100,
      workerId: 'worker-a',
      trigger: 'manual',
      config: { actionsEnabled: false, notificationsEnabled: false },
    })).rejects.toThrow('group overdue adapter unavailable');

    expect(events).toEqual([]);
    expect(groupSideEffects).toEqual([]);
  });

  it('skips P8 inline port and records owned_by_notification_engine marker when convergence flag is on', async () => {
    const notifyDeadlineOverdue = vi.fn();
    const recordSkipped = vi.fn();
    const repository = createRepository({
      due: [createDeadline({ deadlineId: deadlineUuid('1'), orderId: 42 })],
      events: [],
      executions: [],
      rules: [],
    });
    const worker = new DeadlineWorkerService({
      transactions: transactionManager(repository),
      targetResolver: createTargetResolver({ isCompleted: false }),
      notificationPort: createNotificationPort(),
      groupDeadlineOverduePort: { notifyDeadlineOverdue, recordSkipped },
    });

    await worker.processDueDeadlines({
      now: '2026-05-01T10:00:00.000Z',
      limit: 100,
      workerId: 'worker-a',
      trigger: 'manual',
      actorUserId: '42',
      requestId: 'req-convergence',
      config: { actionsEnabled: false, notificationsEnabled: false, engineOwnsDeadline: true },
    });

    expect(notifyDeadlineOverdue).not.toHaveBeenCalled();
    expect(recordSkipped).toHaveBeenCalledTimes(1);
    expect(recordSkipped).toHaveBeenCalledWith(
      expect.objectContaining({
        deadlineEventId: 'event-1',
        orderId: '42',
      }),
      'owned_by_notification_engine',
    );
  });

  it('does not notify group overdue adapter for idempotent replay or completed events', async () => {
    const notifyDeadlineOverdue = vi.fn();
    const existingEvent = createEvent({
      deadlineEventId: 'event-existing',
      eventType: 'DEADLINE_EXPIRED',
      deadlineId: deadlineUuid('1'),
      orderId: 42,
    });
    const repository = createRepository({
      due: [createDeadline({ deadlineId: deadlineUuid('1'), orderId: 42 })],
      events: [],
      executions: [],
      rules: [],
    });
    const replayWorker = new DeadlineWorkerService({
      transactions: transactionManager({
        ...repository,
        async createDeadlineEvent() {
          return { event: existingEvent, created: false };
        },
      }),
      targetResolver: createTargetResolver({ isCompleted: false }),
      notificationPort: createNotificationPort(),
      groupDeadlineOverduePort: { notifyDeadlineOverdue },
    });

    await replayWorker.processDueDeadlines({
      now: '2026-05-01T10:00:00.000Z',
      limit: 100,
      workerId: 'worker-a',
      trigger: 'manual',
      config: { actionsEnabled: false, notificationsEnabled: false },
    });

    const completedWorker = new DeadlineWorkerService({
      transactions: transactionManager(repository),
      targetResolver: createTargetResolver({
        isCompleted: true,
        completedAt: '2026-05-01T08:30:00.000Z',
      }),
      notificationPort: createNotificationPort(),
      groupDeadlineOverduePort: { notifyDeadlineOverdue },
    });

    await completedWorker.processDueDeadlines({
      now: '2026-05-01T10:00:00.000Z',
      limit: 100,
      workerId: 'worker-a',
      trigger: 'manual',
      config: { actionsEnabled: false, notificationsEnabled: false },
    });

    expect(notifyDeadlineOverdue).not.toHaveBeenCalled();
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

  it('records rule snapshot and order evidence on worker-created action executions', async () => {
    const executions: DeadlineActionExecutionDto[] = [];
    const repository = createRepository({
      due: [createDeadline({ deadlineId: 'deadline-1', orderId: 42 })],
      events: [],
      executions,
      rules: [
        createRule({
          actionRuleId: 'rule-audit',
          actionType: 'write_audit',
          priority: 25,
          config: {
            conditions: {
              requireCurrentDeadlineEvent: true,
            },
            actionConfig: {},
          },
        }),
      ],
    });
    const worker = new DeadlineWorkerService({
      transactions: transactionManager(repository),
      targetResolver: createTargetResolver({ isCompleted: false }),
      notificationPort: createNotificationPort(),
    });

    await worker.processDueDeadlines({
      now: '2026-05-23T10:00:00.000Z',
      limit: 10,
      workerId: 'worker-evidence-test',
      trigger: 'manual',
      config: {
        actionsEnabled: true,
        notificationsEnabled: true,
      },
    });

    expect(executions).toEqual([
      expect.objectContaining({
        status: 'executed',
        actionType: 'write_audit',
        orderId: 42,
        ruleConfigSnapshot: expect.objectContaining({
          actionRuleId: 'rule-audit',
          priority: 25,
          eventType: 'DEADLINE_EXPIRED',
          actionType: 'write_audit',
          conditions: {
            requireCurrentDeadlineEvent: true,
          },
          actionConfig: {},
          snapshotHash: expect.stringMatching(/^sha256:/),
        }),
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

  it('rolls back same-transaction status mutation evidence when action execution write fails', async () => {
    const events: DeadlineEventDto[] = [];
    const executions: DeadlineActionExecutionDto[] = [];
    const productionMutations: DeadlineChangeOrderStatusCommand[] = [];
    const repository = createRepository({
      due: [createDeadline({ deadlineId: 'deadline-status-rollback', orderId: 42 })],
      events,
      executions,
      rules: [
        createRule({
          actionRuleId: 'rule-change-status',
          actionType: 'change_order_status',
          config: {
            conditions: { allowedFromOrderStatusIds: [1] },
            actionConfig: { targetOrderStatusId: 7 },
          },
        }),
      ],
    });
    const worker = new DeadlineWorkerService({
      transactions: rollbackAwareTransactionManager({
        repository: {
          ...repository,
          async createActionExecution() {
            throw new Error('action execution write failed');
          },
        },
        productionMutations,
      }),
      targetResolver: createTargetResolver({ isCompleted: false }),
      notificationPort: createNotificationPort(),
      statusActionPort: {
        async changeOrderStatusFromDeadline(command) {
          productionMutations.push(command);
          return {
            status: 'executed',
            result: {
              order: {
                orderId: command.orderId,
                orderStatusId: command.targetOrderStatusId,
                version: 4,
              },
            },
          };
        },
      },
    });

    await expect(
      worker.processDueDeadlines({
        now: '2026-05-01T10:00:00.000Z',
        limit: 100,
        workerId: 'worker-a',
        trigger: 'manual',
        config: { actionsEnabled: true, notificationsEnabled: true },
      }),
    ).rejects.toThrow('action execution write failed');

    expect(productionMutations).toEqual([]);
  });

  it('dispatches change_production_status through the transaction-scoped production action port', async () => {
    const events: DeadlineEventDto[] = [];
    const executions: DeadlineActionExecutionDto[] = [];
    const productionCommands: DeadlineChangeProductionStatusCommand[] = [];
    const repository = createRepository({
      due: [createDeadline({ deadlineId: 'deadline-production-status', orderId: 42 })],
      events,
      executions,
      rules: [
        createRule({
          actionRuleId: 'rule-change-production-status',
          actionType: 'change_production_status',
          config: {
            actionConfig: {
              targetProductionStatusId: 6,
              productionStatusScope: 'order',
            },
          },
        }),
      ],
    });
    const worker = new DeadlineWorkerService({
      transactions: {
        async runInTransaction(handler) {
          return handler({
            deadlines: repository,
            productionStatusActionPort: {
              async changeProductionStatusFromDeadline(command) {
                productionCommands.push(command);
                return {
                  status: 'executed',
                  result: {
                    order: {
                      orderId: command.orderId,
                      productionStatusId: command.targetProductionStatusId,
                      version: 8,
                    },
                  },
                };
              },
            },
          });
        },
      },
      targetResolver: createTargetResolver({ isCompleted: false }),
      notificationPort: createNotificationPort(),
    });

    await worker.processDueDeadlines({
      now: '2026-05-27T10:00:00.000Z',
      limit: 10,
      workerId: 'worker-production-status-test',
      trigger: 'manual',
      requestId: 'req-worker-production-status',
      config: {
        actionsEnabled: true,
        notificationsEnabled: true,
      },
    });

    expect(productionCommands).toEqual([
      expect.objectContaining({
        orderId: 42,
        targetProductionStatusId: 6,
        productionStatusScope: 'order',
        deadlineId: 'deadline-production-status',
        actionRuleId: 'rule-change-production-status',
        requestId: 'req-worker-production-status',
      }),
    ]);
    expect(executions).toEqual([
      expect.objectContaining({
        actionType: 'change_production_status',
        status: 'executed',
        targetStatusId: 6,
        result: { order: { orderId: 42, productionStatusId: 6, version: 8 } },
      }),
    ]);
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

function eventRollbackTransactionManager(input: {
  repository: DeadlineRepositoryPort;
  events: DeadlineEventDto[];
  groupSideEffects?: string[];
  groupDeadlineOverduePort?: DeadlineUnitOfWork['groupDeadlineOverduePort'];
}): DeadlineTransactionManagerPort {
  return {
    async runInTransaction(handler) {
      const beforeEvents = [...input.events];
      const beforeGroupSideEffects = [...(input.groupSideEffects ?? [])];
      try {
        return await handler({
          deadlines: input.repository,
          groupDeadlineOverduePort: input.groupDeadlineOverduePort,
        });
      } catch (error) {
        input.events.splice(0, input.events.length, ...beforeEvents);
        input.groupSideEffects?.splice(
          0,
          input.groupSideEffects.length,
          ...beforeGroupSideEffects,
        );
        throw error;
      }
    },
  };
}

function rollbackAwareTransactionManager(input: {
  repository: DeadlineRepositoryPort;
  productionMutations: DeadlineChangeOrderStatusCommand[];
}): DeadlineTransactionManagerPort {
  return {
    async runInTransaction(handler) {
      const beforeProductionMutations = [...input.productionMutations];
      const unitOfWork: DeadlineUnitOfWork = {
        deadlines: input.repository,
        statusActionPort: {
          async changeOrderStatusFromDeadline(command) {
            input.productionMutations.push(command);
            return {
              status: 'executed',
              result: {
                order: {
                  orderId: command.orderId,
                  orderStatusId: command.targetOrderStatusId,
                  version: 4,
                },
              },
            };
          },
        },
      };

      try {
        return await handler(unitOfWork);
      } catch (error) {
        input.productionMutations.splice(
          0,
          input.productionMutations.length,
          ...beforeProductionMutations,
        );
        throw error;
      }
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
    async listOrderOverrides() {
      return [];
    },
    async listOrderActionRuleOverrides() {
      return [];
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
      return { orderId, orderStatusId: 1, isCompleted: false };
    },
    async isDeadlineEventCurrentForOrder() {
      return true;
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
    priority: 100,
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

function deadlineUuid(suffix: string = '1'): string {
  return `${suffix.repeat(8)}-${suffix.repeat(4)}-4${suffix.repeat(3)}-8${suffix.repeat(3)}-${suffix.repeat(12)}`;
}
