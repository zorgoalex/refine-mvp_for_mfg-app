import {
  Logger,
  type LoggerService,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { redactLogFields } from '../../../common/logging/redaction';
import { CrmSyncRuntimeConfigService } from '../http/crm-sync-runtime-config.service';
import { Bitrix24ReverseProcessorService } from './bitrix24-reverse-processor.service';

export class Bitrix24ReverseSchedulerService implements OnModuleInit, OnModuleDestroy {
  private interval?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly processor: Bitrix24ReverseProcessorService,
    private readonly config: CrmSyncRuntimeConfigService,
    private readonly logger: Pick<LoggerService, 'log' | 'error'> =
      new Logger(Bitrix24ReverseSchedulerService.name),
  ) {}

  async onModuleInit(): Promise<void> {
    const flags = this.config.getReverseSync();
    if (
      this.interval ||
      !flags.enabled ||
      flags.dryRun
    ) {
      return;
    }
    await this.processor.assertReady();
    if (flags.relayOwner !== 'in_process') return;
    this.interval = setInterval(() => void this.tick(), flags.pollIntervalMs);
    this.interval.unref();
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      const summary = await this.processor.runTick();
      const reconcileEnqueued = await this.processor.runReconcileTick();
      if (summary.claimed > 0 || reconcileEnqueued > 0) {
        this.logger.log(redactLogFields({
          event: 'bitrix24_reverse_batch_finished',
          ...summary,
          reconcileEnqueued,
          durationMs: Date.now() - startedAt,
        }));
      }
    } catch (error) {
      this.logger.error(redactLogFields({
        event: 'bitrix24_reverse_batch_failed',
        durationMs: Date.now() - startedAt,
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      this.running = false;
    }
  }
}
