import { Logger, type LoggerService, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { redactLogFields } from '../../../common/logging/redaction';
import { CrmSyncRelayService } from './crm-sync-relay.service';
import { CrmSyncRuntimeConfigService } from '../http/crm-sync-runtime-config.service';

type SchedulerLogger = Pick<LoggerService, 'log' | 'error'>;

/**
 * Periodic scheduler for the CRM-sync relay.
 *
 * Scheduling conditions (all must hold):
 *   flags.enabled === true
 *   flags.relayOwner === 'in_process'
 *   flags.dryRun === false  (dry-run is manual-only via runTick({dryRun:true}))
 *
 * Non-reentrant: if the previous tick is still running, the next interval callback
 * is skipped entirely (no overlapping claims from the single in-process worker).
 */
export class CrmSyncRelaySchedulerService implements OnModuleInit, OnModuleDestroy {
  private intervalHandle?: ReturnType<typeof setInterval>;
  /** Guards against re-entrant ticks. Set true while runTick is in-flight. */
  private running = false;

  constructor(
    private readonly relay: CrmSyncRelayService,
    private readonly runtimeConfig: CrmSyncRuntimeConfigService,
    private readonly logger: SchedulerLogger = new Logger(CrmSyncRelaySchedulerService.name),
  ) {}

  onModuleInit(): void {
    if (this.intervalHandle) {
      return;
    }

    const flags = this.runtimeConfig.getFlags();

    if (!this.shouldRun(flags)) {
      return;
    }

    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, flags.pollIntervalMs);
  }

  onModuleDestroy(): void {
    if (!this.intervalHandle) {
      return;
    }
    clearInterval(this.intervalHandle);
    this.intervalHandle = undefined;
  }

  /** Exposed for manual triggering in tests and for HTTP admin endpoints. */
  async tick(): Promise<void> {
    const flags = this.runtimeConfig.getFlags();

    if (!this.shouldRun(flags)) {
      return;
    }

    // Non-reentrant guard: skip this tick if the previous one has not finished.
    if (this.running) {
      this.logger.log(
        redactLogFields({
          event: 'crm_sync_scheduler_tick_skipped',
          reason: 'previous_tick_in_flight',
          workerId: flags.workerId,
        }),
      );
      return;
    }

    this.running = true;
    const startedAt = Date.now();

    try {
      const summary = await this.relay.runTick();
      this.logger.log(
        redactLogFields({
          event: 'crm_sync_relay_batch_finished',
          trigger: 'scheduler',
          workerId: flags.workerId,
          relayOwner: flags.relayOwner,
          batchSize: flags.batchSize,
          claimed: summary.claimed,
          processed: summary.processed,
          failed: summary.failed,
          durationMs: Date.now() - startedAt,
          status: 'ok',
        }),
      );
    } catch (error) {
      this.logger.error(
        redactLogFields({
          event: 'crm_sync_scheduler_tick_failed',
          trigger: 'scheduler',
          workerId: flags.workerId,
          relayOwner: flags.relayOwner,
          durationMs: Date.now() - startedAt,
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      this.running = false;
    }
  }

  private shouldRun(
    flags: ReturnType<CrmSyncRuntimeConfigService['getFlags']>,
  ): boolean {
    return flags.enabled && flags.relayOwner === 'in_process' && !flags.dryRun;
  }
}
