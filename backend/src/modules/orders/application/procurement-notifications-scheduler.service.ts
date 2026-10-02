import { Logger, type LoggerService, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { ProcurementNotificationsService } from './procurement-notifications.service';

/** Как часто сервис уведомлений закупа делает проход (сводка — по времени из настроек, ключ на дату). */
export const PROCUREMENT_NOTIFICATIONS_INTERVAL_MS = 5 * 60_000;

/**
 * Таймер уведомлений закупа (§5.7): проход раз в 5 минут; флаги проверяет сам сервис на каждом проходе; проходы не
 * перекрываются (следующий тик пропускается, пока идёт предыдущий).
 */
export class ProcurementNotificationsSchedulerService implements OnModuleInit, OnModuleDestroy {
  private handle?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly service: Pick<ProcurementNotificationsService, 'runOnce'>,
    private readonly logger: Pick<LoggerService, 'log' | 'error'> = new Logger(ProcurementNotificationsSchedulerService.name),
    private readonly intervalMs: number = PROCUREMENT_NOTIFICATIONS_INTERVAL_MS,
  ) {}

  onModuleInit(): void {
    if (this.handle) return;
    this.handle = setInterval(() => { void this.tick(); }, this.intervalMs);
  }

  onModuleDestroy(): void {
    if (this.handle) clearInterval(this.handle);
    this.handle = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      const summary = await this.service.runOnce();
      if (!summary.skipped && (summary.demandEvents > 0 || summary.digests > 0 || summary.unallocated > 0 || summary.failed > 0)) {
        this.logger.log({ event: 'procurement_notifications_run', ...summary, durationMs: Date.now() - startedAt });
      }
    } catch (error) {
      this.logger.error({
        event: 'procurement_notifications_run_failed',
        durationMs: Date.now() - startedAt,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }
}
