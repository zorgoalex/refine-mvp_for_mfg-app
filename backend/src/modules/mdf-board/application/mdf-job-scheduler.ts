import { Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import type { MdfJobOutcome } from './mdf-job-runner';

interface JobProcessor { processOne(): Promise<{ status: MdfJobOutcome }> }
/** One bounded in-process poller; PostgreSQL SKIP LOCKED handles other instances.
 * Separate from notification scheduling. Feature flag AND database active mode
 * are required. Shutdown waits for the current atomic job, not another batch. */
export class MdfJobScheduler implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  constructor(private readonly processor: JobProcessor,
    private readonly enabled = () => process.env.BACKEND_MDF_JOB_WORKER==='true',
    private readonly logger: Pick<Logger,'error'> = new Logger(MdfJobScheduler.name)) {}

  onModuleInit(): void {
    if (this.timer || !this.enabled() || this.stopped) return;
    this.timer = setInterval(() => { void this.runTick(); },1000);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
  runTick(): Promise<void> {
    if (!this.enabled() || this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.processBatch().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async processBatch(): Promise<void> {
    try {
      for (let count=0;count<10 && !this.stopped && this.enabled();count++) {
        const outcome = await this.processor.processOne();
        if (outcome.status==='idle' || outcome.status==='disabled') break;
      }
    } catch {
      // No raw SQL/credentials/payload in logs; uncommitted job remains claimable.
      this.logger.error({ event: 'mdf_job_poll_failed',code: 'MDF_POLL_FAILED' });
    }
  }
}
