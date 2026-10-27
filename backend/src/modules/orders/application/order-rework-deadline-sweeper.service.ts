import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { DatabaseService } from '../../../database/database.service';

export const ORDER_REWORK_DEADLINE_SWEEP_MS = 30_000;
/** A mark younger than this belongs to a command whose own after-commit reconciliation may still be running. */
export const ORDER_REWORK_DEADLINE_SWEEP_GRACE_MS = 30_000;
const SWEEP_BATCH = 20;
/** A failing order is retried after 30 s, 1 min, 2 min … up to 30 min — the queue moves on meanwhile. */
const BACKOFF_MAX_MS = 30 * 60_000;

interface PendingRow {
  order_id: string | number;
  round_id: string | number;
}

/**
 * «Переделка» 1.1 §6.3: rounds whose `deadline_sync_requested_at` mark survived (the after-commit reconciliation
 * failed or the process stopped right after commit) get the final deadline of their order reconciled. The
 * reconciliation itself is idempotent and clears the marks when the state is reached. It runs as the system actor;
 * the initiator and correlation come from the newest mark of the snapshot it acts on. Oldest marks first; deleted
 * orders are skipped (their marks are cleared by any reconciliation); an order that keeps failing backs off so the
 * rest of the queue is still served.
 */
export class OrderReworkDeadlineSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderReworkDeadlineSweeper.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly backoff = new Map<number, { failures: number; retryAt: number }>();

  constructor(
    private readonly ports: {
      database: DatabaseService;
      enabled: () => boolean;
      reconcile: (input: {
        orderId: number;
        requestId: string;
        context: { fromSnapshotMarks: true };
      }) => Promise<void>;
    },
  ) {}

  onModuleInit(): void {
    if (!this.ports.enabled()) return;
    this.timer = setInterval(() => void this.sweep(), ORDER_REWORK_DEADLINE_SWEEP_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass; returns the number of orders reconciled (exposed for tests). Never rejects. */
  async sweep(now: Date = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const waiting = [...this.backoff].filter(([, state]) => state.retryAt > now.getTime()).map(([orderId]) => orderId);
      const pending = await this.ports.database.query<PendingRow>(
        `SELECT order_id, round_id FROM (
           SELECT DISTINCT ON (r.order_id) r.order_id, r.order_production_round_id AS round_id, r.deadline_sync_requested_at
             FROM order_production_rounds r
             JOIN orders o ON o.order_id = r.order_id AND COALESCE(o.delete_flag, false) = false
            WHERE r.deadline_sync_requested_at IS NOT NULL
              AND r.deadline_sync_requested_at < $1::timestamptz
              AND r.order_id <> ALL($3::bigint[])
            ORDER BY r.order_id, r.deadline_sync_requested_at
         ) oldest
         ORDER BY deadline_sync_requested_at, order_id
         LIMIT $2`,
        [new Date(now.getTime() - ORDER_REWORK_DEADLINE_SWEEP_GRACE_MS).toISOString(), SWEEP_BATCH, waiting],
      );
      let done = 0;
      for (const row of pending.rows) {
        const orderId = Number(row.order_id);
        try {
          await this.ports.reconcile({
            orderId,
            requestId: `order-final-deadline-reconcile:${row.round_id}:${now.getTime()}`,
            context: { fromSnapshotMarks: true },
          });
          this.backoff.delete(orderId);
          done += 1;
        } catch (error) {
          const failures = (this.backoff.get(orderId)?.failures ?? 0) + 1;
          const delay = Math.min(ORDER_REWORK_DEADLINE_SWEEP_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
          this.backoff.set(orderId, { failures, retryAt: now.getTime() + delay });
          this.logger.warn(`Final deadline reconciliation of order ${orderId} failed (${failures}); retried in ${Math.round(delay / 1000)} s: ${
            error instanceof Error ? error.message : String(error)}`);
        }
      }
      return done;
    } catch (error) {
      // The queue read itself failed (DB down, timeout): the next pass tries again.
      this.logger.warn(`Final deadline background pass failed; retried on the next pass: ${
        error instanceof Error ? error.message : String(error)}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
