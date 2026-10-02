import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Logger, type LoggerService, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { ProcurementNotificationsService } from './procurement-notifications.service';

/** Как часто сервис уведомлений закупа делает проход (сводка — по времени из настроек, ключ на дату). */
export const PROCUREMENT_NOTIFICATIONS_INTERVAL_MS = 5 * 60_000;

/**
 * Таймер уведомлений закупа (§5.7): проход раз в 5 минут; флаги проверяет сам сервис на каждом проходе; проходы не
 * перекрываются (следующий тик пропускается, пока идёт предыдущий). КАЖДЫЙ проход, включая пустой, пишет
 * `procurement_notifications_run_finished` (runId, instanceId, startedAt/finishedAt, счётчики, правила) — по нему
 * откат убеждается, что прошёл проход, начавшийся после выключения правил (план 2026-10-02 §3, R2-1).
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

  private readonly instanceId = `${hostname()}:${process.pid}`;

  async tick(): Promise<void> {
    if (this.running) {
      this.logger.log({ event: 'procurement_notifications_run_skipped', instanceId: this.instanceId, at: new Date().toISOString(), reason: 'previous_run_in_progress' });
      return;
    }
    this.running = true;
    const runId = randomUUID();
    const started = new Date();
    try {
      const summary = await this.service.runOnce();
      const finished = new Date();
      this.logger.log({
        event: 'procurement_notifications_run_finished', runId, instanceId: this.instanceId,
        startedAt: started.toISOString(), finishedAt: finished.toISOString(), durationMs: finished.getTime() - started.getTime(), ...summary,
      });
    } catch (error) {
      const finished = new Date();
      this.logger.error({
        event: 'procurement_notifications_run_failed', runId, instanceId: this.instanceId,
        startedAt: started.toISOString(), finishedAt: finished.toISOString(), durationMs: finished.getTime() - started.getTime(),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }
}
