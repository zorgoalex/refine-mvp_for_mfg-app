import { calculateDelayMinutes } from '../domain/deadline-calculator';
import { getCompletionDeadlineStatus } from '../domain/deadline-status';
import type { DeadlineInstanceDto } from '../dto/deadline-instance.dto';
import type { DeadlineActionDispatcherConfig } from './deadline-action-dispatcher.service';
import { DeadlineActionDispatcherService } from './deadline-action-dispatcher.service';
import type {
  CreateDeadlineEventInput,
  DeadlineRepositoryPort,
  DeadlineNotificationPort,
  DeadlineOrderStatusActionPort,
  DeadlineProjectDeadlineOverdueNotificationPort,
  DeadlineProductionStatusActionPort,
  DeadlineTargetResolverPort,
  DeadlineTransactionManagerPort,
} from './deadline.types';

export interface DeadlineWorkerServicePorts {
  transactions: DeadlineTransactionManagerPort;
  targetResolver: DeadlineTargetResolverPort;
  notificationPort: DeadlineNotificationPort;
  statusActionPort?: DeadlineOrderStatusActionPort;
  productionStatusActionPort?: DeadlineProductionStatusActionPort;
  projectDeadlineOverduePort?: DeadlineProjectDeadlineOverdueNotificationPort;
  dispatcher?: DeadlineActionDispatcherService;
}

export interface ProcessDueDeadlinesCommand {
  now: string;
  limit: number;
  workerId: string;
  trigger: 'manual' | 'scheduler';
  schedulerRunId?: string;
  actorUserId?: string;
  requestId?: string;
  config: DeadlineActionDispatcherConfig;
}

export interface ProcessDueDeadlinesResult {
  scanned: number;
  processed: number;
  expired: number;
  completed: number;
}

export class DeadlineWorkerService {
  constructor(private readonly ports: DeadlineWorkerServicePorts) {}

  async processDueDeadlines(command: ProcessDueDeadlinesCommand): Promise<ProcessDueDeadlinesResult> {
    const dispatchEvents: Array<{
      event: Awaited<ReturnType<DeadlineRepositoryPort['createDeadlineEvent']>>['event'];
    }> = [];
    const result = await this.ports.transactions.runInTransaction(async (unitOfWork) => {
      const dueDeadlines = await unitOfWork.deadlines.findDueDeadlinesForUpdate({
        now: command.now,
        limit: command.limit,
        workerId: command.workerId,
      });
      const result: ProcessDueDeadlinesResult = {
        scanned: dueDeadlines.length,
        processed: 0,
        expired: 0,
        completed: 0,
      };

      for (const deadline of dueDeadlines) {
        if (deadline.status !== 'active') {
          continue;
        }

        const targetState = await this.ports.targetResolver.resolveTargetState({
          entityType: deadline.entityType,
          entityId: deadline.entityId,
          orderId: deadline.orderId,
          orderWorkshopId: deadline.orderWorkshopId,
          clientId: deadline.clientId,
        });

        const eventInput = targetState.isCompleted
          ? await this.markCompleted(
              unitOfWork.deadlines,
              deadline,
              targetState.completedAt ?? command.now,
              command.now,
              command.workerId,
              command.trigger,
              command.schedulerRunId,
              command.actorUserId,
              command.requestId,
            )
          : await this.markExpired(
              unitOfWork.deadlines,
              deadline,
              command.now,
              command.workerId,
              command.trigger,
              command.schedulerRunId,
              command.actorUserId,
              command.requestId,
            );
        const eventResult = await unitOfWork.deadlines.createDeadlineEvent(eventInput);
        const { event } = eventResult;

        if (eventResult.created) {
          dispatchEvents.push({ event });
          const projectDeadlineOverduePort =
            unitOfWork.projectDeadlineOverduePort ?? this.ports.projectDeadlineOverduePort;
          if (event.eventType === 'DEADLINE_EXPIRED' && projectDeadlineOverduePort) {
            await projectDeadlineOverduePort.notifyDeadlineOverdue({
              deadlineEventId: event.deadlineEventId,
              deadlineInstanceId: event.deadlineId,
              orderId: event.orderId == null ? null : String(event.orderId),
              actorUserId: command.actorUserId ?? null,
              requestId: command.requestId ?? event.deadlineEventId,
            });
          }
        }

        result.processed += 1;
        if (event.eventType === 'DEADLINE_EXPIRED') {
          result.expired += 1;
        } else {
          result.completed += 1;
        }
      }

      return result;
    });

    for (const { event } of dispatchEvents) {
      await this.ports.transactions.runInTransaction(async (unitOfWork) => {
        await this.createDispatcher(unitOfWork).dispatch({
          event,
          repository: unitOfWork.deadlines,
          targetResolver: this.ports.targetResolver,
          notificationPort: this.ports.notificationPort,
          config: command.config,
        });
      });
    }

    return result;
  }

  private createDispatcher(unitOfWork: {
    statusActionPort?: DeadlineOrderStatusActionPort;
    productionStatusActionPort?: DeadlineProductionStatusActionPort;
  }) {
    if (this.ports.dispatcher) {
      return this.ports.dispatcher;
    }

    return new DeadlineActionDispatcherService({
      statusActionPort: unitOfWork.statusActionPort ?? this.ports.statusActionPort,
      productionStatusActionPort:
        unitOfWork.productionStatusActionPort ?? this.ports.productionStatusActionPort,
    });
  }

  private async markExpired(
    repository: DeadlineRepositoryPort,
    deadline: DeadlineInstanceDto,
    now: string,
    workerId: string,
    trigger: 'manual' | 'scheduler',
    schedulerRunId?: string,
    actorUserId?: string,
    requestId?: string,
  ): Promise<CreateDeadlineEventInput> {
    await repository.markDeadlineExpired({
      deadlineId: deadline.deadlineId,
      expiredAt: now,
    });

    return {
      deadlineId: deadline.deadlineId,
      eventType: 'DEADLINE_EXPIRED',
      severity: 'critical',
      entityType: deadline.entityType,
      entityId: deadline.entityId,
      orderId: deadline.orderId,
      orderWorkshopId: deadline.orderWorkshopId,
      clientId: deadline.clientId,
      deadlineAt: deadline.deadlineAt,
      eventAt: now,
      delayMinutes: calculateDelayMinutes({ deadlineAt: deadline.deadlineAt, occurredAt: now }),
      idempotencyKey: terminalEventIdempotencyKey(deadline.deadlineId, 'DEADLINE_EXPIRED'),
      payload: {
        status: 'expired',
        source: 'deadline-engine',
        trigger,
        workerId,
        actorUserId: actorUserId ?? null,
        requestId: requestId ?? null,
        schedulerRunId: schedulerRunId ?? null,
        ...fixturePayload(deadline),
      },
    };
  }

  private async markCompleted(
    repository: DeadlineRepositoryPort,
    deadline: DeadlineInstanceDto,
    completedAt: string,
    now: string,
    workerId: string,
    trigger: 'manual' | 'scheduler',
    schedulerRunId?: string,
    actorUserId?: string,
    requestId?: string,
  ): Promise<CreateDeadlineEventInput> {
    const status = getCompletionDeadlineStatus({
      completedAt,
      deadlineAt: deadline.deadlineAt,
    });
    await repository.markDeadlineCompleted({
      deadlineId: deadline.deadlineId,
      status,
      completedAt,
    });

    const eventType =
      status === 'completed_on_time' ? 'DEADLINE_COMPLETED_ON_TIME' : 'DEADLINE_COMPLETED_LATE';

    return {
      deadlineId: deadline.deadlineId,
      eventType,
      severity: status === 'completed_on_time' ? 'info' : 'warning',
      entityType: deadline.entityType,
      entityId: deadline.entityId,
      orderId: deadline.orderId,
      orderWorkshopId: deadline.orderWorkshopId,
      clientId: deadline.clientId,
      deadlineAt: deadline.deadlineAt,
      eventAt: now,
      delayMinutes:
        status === 'completed_late'
          ? calculateDelayMinutes({ deadlineAt: deadline.deadlineAt, occurredAt: completedAt })
          : 0,
      idempotencyKey: terminalEventIdempotencyKey(deadline.deadlineId, eventType),
      payload: {
        status,
        completedAt,
        source: 'deadline-engine',
        trigger,
        workerId,
        actorUserId: actorUserId ?? null,
        requestId: requestId ?? null,
        schedulerRunId: schedulerRunId ?? null,
        ...fixturePayload(deadline),
      },
    };
  }
}

function terminalEventIdempotencyKey(deadlineId: string, eventType: string): string {
  return `deadline-terminal:${deadlineId}:${eventType}:deadline-engine`;
}

function fixturePayload(deadline: DeadlineInstanceDto): { fixtureKey?: string } {
  const fixtureKey = deadline.metadata?.fixtureKey;
  if (typeof fixtureKey !== 'string' || fixtureKey.trim() === '') {
    return {};
  }

  return { fixtureKey };
}
