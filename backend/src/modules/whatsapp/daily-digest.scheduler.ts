import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DailyDigestService } from './daily-digest.service';

@Injectable()
export class DailyDigestScheduler implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private ticking = false;

  constructor(@Inject(DailyDigestService) private readonly service: DailyDigestService) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
    // Retention is deliberately decoupled from WhatsApp runtime and auto-send flags.
    this.cleanupTimer = setInterval(() => void this.service.cleanupImages().catch(() => false), 60_000);
    this.cleanupTimer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try { await this.service.tick(); }
    catch { /* The service records safe event codes where possible; the next bounded tick retries pre-intent work. */ }
    finally { this.ticking = false; }
  }
}
