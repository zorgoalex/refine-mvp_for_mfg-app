import { randomUUID } from 'node:crypto';
import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import { mapUserRow } from '../../../permissions/visibility/order-visibility-filter';
import { runMdfDemandReconcileTick } from '../adapters/mdf-demand-reconciler';

/** §5.8 demand-drift reconciler poller (one bounded tick per minute; source/order locks serialize other instances).
 * Enabled only with the job worker flag AND a configured, active system actor; every tick checks the engine is
 * `active` (never read_only, never during a baseline or recovery freeze — the boundary rejects those). */
export class MdfDemandReconcileScheduler implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  /** Round-robin position across ticks (process-local; losing it on restart only restarts the rotation). */
  private cursor: string | null = null;
  constructor(private readonly database: DatabaseService,
    private readonly actorId = () => process.env.BACKEND_MDF_RECONCILER_ACTOR_ID,
    private readonly enabled = () => process.env.BACKEND_MDF_JOB_WORKER === 'true' && Boolean(process.env.BACKEND_MDF_RECONCILER_ACTOR_ID),
    private readonly logger: Pick<Logger, 'error' | 'log'> = new Logger(MdfDemandReconcileScheduler.name)) {}

  onModuleInit(): void {
    if (this.timer || !this.enabled() || this.stopped) return;
    this.timer = setInterval(() => { void this.runTick(); }, 60_000);
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
    this.running = this.tick().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async tick(): Promise<void> {
    try {
      const mode = (await this.database.query<{ mode: string }>('SELECT mode FROM mdf_engine_state WHERE singleton')).rows[0]?.mode;
      if (mode !== 'active') return;
      const actorId = Number(this.actorId());
      const row = Number.isSafeInteger(actorId) && actorId > 0 ? (await this.database.query<{ user_id: string; username: string;
        role_id: number }>('SELECT user_id,username,role_id FROM users WHERE user_id=$1 AND is_active', [actorId])).rows[0] : undefined;
      const user = row ? mapUserRow(row) : null;
      if (!user) { this.logger.error({ event: 'mdf_reconcile_actor_unavailable', code: 'MDF_RECONCILE_ACTOR_UNAVAILABLE' }); return; }
      const result = await runMdfDemandReconcileTick({ user, requestId: `mdf-reconcile:${randomUUID()}`, cursor: this.cursor,
        transaction: <T>(handler: (tx: TransactionClient) => Promise<T>) => this.database.transaction(handler,
          { mdf: { writer: 'mdf.demand_reconcile', capability: 'order-demand' } }) });
      this.cursor = result.cursor;
      if (result.closures) this.logger.log({ event: 'mdf_reconcile_tick', ...result });
    } catch (error) {
      // No raw SQL/payload in logs; the next tick re-evaluates from the database.
      this.logger.error({ event: 'mdf_reconcile_failed', code: error instanceof Error && /^MDF_[A-Z_]+$/.test(error.message)
        ? error.message : 'MDF_RECONCILE_FAILED' });
    }
  }
}
