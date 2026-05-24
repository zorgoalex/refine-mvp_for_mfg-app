import { Logger, type LoggerService, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { redactLogFields } from '../../../common/logging/redaction';
import { DeadlineWorkerService } from './deadline-worker.service';
import { DeadlinesRuntimeConfigService, type DeadlinesFeatureFlags } from '../http/deadlines-runtime-config.service';

type SchedulerLogger = Pick<LoggerService, 'log' | 'error'>;

export class DeadlineWorkerSchedulerService implements OnModuleInit, OnModuleDestroy {
  private intervalHandle?: ReturnType<typeof setInterval>;

  constructor(
    private readonly worker: DeadlineWorkerService,
    private readonly runtimeConfig: DeadlinesRuntimeConfigService,
    private readonly logger: SchedulerLogger = new Logger(DeadlineWorkerSchedulerService.name),
  ) {}

  onModuleInit(): void {
    if (this.intervalHandle) {
      return;
    }

    const flags = this.runtimeConfig.getFeatureFlags();

    if (!this.shouldRunScheduler(flags)) {
      return;
    }

    this.intervalHandle = setInterval(() => {
      void this.runTick();
    }, flags.deadlineWorkerPollIntervalMs);
  }

  onModuleDestroy(): void {
    if (!this.intervalHandle) {
      return;
    }

    clearInterval(this.intervalHandle);
    this.intervalHandle = undefined;
  }

  async runTick(): Promise<void> {
    const flags = this.runtimeConfig.getFeatureFlags();

    if (!this.shouldRunScheduler(flags)) {
      return;
    }

    const startedAt = Date.now();
    const requestId = `deadline-worker-scheduler-${randomUUID()}`;

    try {
      const result = await this.worker.processDueDeadlines({
        now: new Date().toISOString(),
        limit: flags.deadlineWorkerBatchSize,
        workerId: flags.deadlineWorkerId,
        trigger: 'scheduler',
        requestId,
        schedulerRunId: requestId,
        config: {
          actionsEnabled: flags.deadlineActionsEnabled,
          notificationsEnabled: flags.deadlineNotificationsEnabled,
        },
      });

      this.logger.log(redactLogFields({
        event: 'deadline_worker_batch_finished',
        trigger: 'scheduler',
        workerId: flags.deadlineWorkerId,
        requestId,
        schedulerOwner: flags.deadlineWorkerSchedulerOwner,
        actionsEnabled: flags.deadlineActionsEnabled,
        notificationsEnabled: flags.deadlineNotificationsEnabled,
        limit: flags.deadlineWorkerBatchSize,
        scanned: result.scanned,
        processed: result.processed,
        expired: result.expired,
        completed: result.completed,
        durationMs: Date.now() - startedAt,
        status: 'ok',
      }));
    } catch (error) {
      this.logger.error(redactLogFields({
        event: 'deadline_worker_scheduler_tick_failed',
        trigger: 'scheduler',
        workerId: flags.deadlineWorkerId,
        requestId,
        schedulerOwner: flags.deadlineWorkerSchedulerOwner,
        actionsEnabled: flags.deadlineActionsEnabled,
        notificationsEnabled: flags.deadlineNotificationsEnabled,
        limit: flags.deadlineWorkerBatchSize,
        durationMs: Date.now() - startedAt,
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private shouldRunScheduler(flags: DeadlinesFeatureFlags): boolean {
    return (
      flags.deadlinesEnabled &&
      !flags.deadlinesReadOnly &&
      flags.deadlineWorkerEnabled &&
      flags.deadlineWorkerSchedulerOwner === 'in_process'
    );
  }
}
