import { Logger, type LoggerService, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { redactLogFields } from '../../../common/logging/redaction';
import { OutboxRelayService } from './outbox-relay.service';
import {
  NotificationsRuntimeConfigService,
  type NotificationsFeatureFlags,
} from '../http/notifications-runtime-config.service';

type SchedulerLogger = Pick<LoggerService, 'log' | 'error'>;

export class OutboxRelaySchedulerService implements OnModuleInit, OnModuleDestroy {
  private intervalHandle?: ReturnType<typeof setInterval>;

  constructor(
    private readonly relay: OutboxRelayService,
    private readonly runtimeConfig: NotificationsRuntimeConfigService,
    private readonly logger: SchedulerLogger = new Logger(OutboxRelaySchedulerService.name),
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
    }, flags.relayPollIntervalMs);
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

    try {
      const summary = await this.relay.processBatchOnce();

      this.logger.log(redactLogFields({
        event: 'outbox_relay_batch_finished',
        trigger: 'scheduler',
        workerId: flags.relayWorkerId,
        relayOwner: flags.relayOwner,
        batchSize: flags.relayBatchSize,
        claimed: summary.claimed,
        processed: summary.processed,
        failed: summary.failed,
        durationMs: Date.now() - startedAt,
        status: 'ok',
      }));
    } catch (error) {
      this.logger.error(redactLogFields({
        event: 'outbox_relay_scheduler_tick_failed',
        trigger: 'scheduler',
        workerId: flags.relayWorkerId,
        relayOwner: flags.relayOwner,
        batchSize: flags.relayBatchSize,
        durationMs: Date.now() - startedAt,
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private shouldRunScheduler(flags: NotificationsFeatureFlags): boolean {
    return flags.engineEnabled && flags.relayOwner === 'in_process';
  }
}
