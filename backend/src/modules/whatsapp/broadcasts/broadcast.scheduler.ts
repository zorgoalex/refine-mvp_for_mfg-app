import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BroadcastWorker } from './broadcast-worker.service';

/** Separate timers (plan §6.2): fixation 15 s, delivery/preparation 30 s, cleanup 60 s. */
@Injectable()
export class BroadcastScheduler implements OnModuleInit, OnModuleDestroy {
  private timers: NodeJS.Timeout[] = [];

  constructor(@Inject(BroadcastWorker) private readonly worker: BroadcastWorker) {}

  onModuleInit() {
    this.timers = [
      setInterval(() => void this.worker.fixDue().catch(() => undefined), 15_000),
      setInterval(() => void this.worker.work().catch(() => undefined), 30_000),
      // Retention is deliberately decoupled from the WhatsApp runtime and send flags.
      setInterval(() => void this.worker.cleanup().catch(() => false), 60_000),
    ];
    for (const timer of this.timers) timer.unref();
  }

  onModuleDestroy() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}
