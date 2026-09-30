import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, type QueryResultRow } from 'pg';
import type { BackendEnv } from '../../../config/env.validation';

/**
 * Delivery of realtime emissions deferred by production-round commands
 * («Переделка», plan §5.7 п.5). A round command never locks
 * `order_realtime_stream` inside its transaction: `order_realtime_emit_one`
 * queues the emission in `order_realtime_deferred` instead. This service
 * replays the queue per order in a short transaction that never waits for a
 * lock: tables are locked NOWAIT before any row, queue rows SKIP LOCKED, the
 * stream and order rows NOWAIT. Any conflict rolls the attempt back, keeps the
 * queue and retries later with backoff — the attempt can never be a link of a
 * lock cycle, so it cannot make another command its deadlock victim.
 *
 * Runs on its own connection with application_name
 * `erp-order-realtime-drain`, which `ops/apply-migrations.sh` checks before
 * DDL (accepted residual risk §5.9: stop the drain for migrations/maintenance).
 */

export const ORDER_REALTIME_DRAIN_APPLICATION_NAME = 'erp-order-realtime-drain';

/**
 * Every table that `order_realtime_emit_one` and its helpers read or write
 * (migration 220 §6c, 098 helpers: `order_realtime_bridge_config`,
 * `order_realtime_bridge_max_detail_ids` → app_settings; stream; event log and
 * its FK to orders; the queue). Update together with `emit_one`.
 */
export const ORDER_REALTIME_DRAIN_TABLE_LOCKS = [
  'LOCK TABLE app_settings, orders IN ROW EXCLUSIVE MODE NOWAIT',
  'LOCK TABLE order_realtime_stream, realtime_event_log, order_realtime_deferred IN ROW EXCLUSIVE MODE NOWAIT',
] as const;

export const ORDER_REALTIME_DRAIN_SWEEP_MS = 5000;
const SWEEP_BATCH = 100;
const STALE_WARNING_MINUTES = 5;
const LOCK_NOT_AVAILABLE = '55P03';

interface QueueRow extends QueryResultRow {
  order_realtime_deferred_id: string | number;
  domains: string[];
  detail_ids: Array<string | number> | null;
  source_type: string;
}

export type DrainAttemptResult = 'delivered' | 'empty' | 'busy' | 'stream_missing' | 'bridge_disabled' | 'failed';

export interface DrainConnection {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
  on?(event: 'error', listener: (error: Error) => void): unknown;
}

@Injectable()
export class OrderRealtimeDeferredDrainService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderRealtimeDeferredDrainService.name);
  private connection: DrainConnection | null = null;
  private readonly requested = new Set<number>();
  private running: Promise<void> | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweepPending = false;
  private stopped = false;

  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  get enabled(): boolean {
    return this.config.get('BACKEND_ORDER_REALTIME_DEFERRED_DRAIN', { infer: true }) === true
      && Boolean(this.config.get('DATABASE_URL', { infer: true }));
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Deferred realtime drain disabled (BACKEND_ORDER_REALTIME_DEFERRED_DRAIN=false)');
      return;
    }
    this.sweepTimer = setInterval(() => this.sweep(), ORDER_REALTIME_DRAIN_SWEEP_MS);
    this.sweepTimer.unref();
    this.sweep();
  }

  /** Stops new attempts, waits for the active one, closes the connection. */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.requested.clear();
    await this.running?.catch(() => undefined);
    await this.closeConnection();
    if (this.enabled) this.logger.log('drain stopped');
  }

  /** Fire-and-forget after a round command commit; never throws. */
  request(orderIds: readonly number[]): void {
    if (!this.enabled || this.stopped) return;
    for (const orderId of orderIds) if (Number.isSafeInteger(orderId) && orderId > 0) this.requested.add(orderId);
    this.kick();
  }

  /** Periodic pass over due queue rows (also delivers after a crash before the immediate drain). */
  sweep(): void {
    if (!this.enabled || this.stopped) return;
    this.kick(true);
  }

  private kick(withSweep = false): void {
    if (this.running) {
      if (withSweep) this.sweepPending = true;
      return;
    }
    this.sweepPending = this.sweepPending || withSweep;
    this.running = this.loop().finally(() => {
      this.running = null;
      if (!this.stopped && (this.requested.size > 0 || this.sweepPending)) this.kick();
    });
  }

  private async loop(): Promise<void> {
    try {
      if (this.sweepPending) {
        this.sweepPending = false;
        for (const orderId of await this.dueOrders()) this.requested.add(orderId);
      }
      while (!this.stopped && this.requested.size > 0) {
        const [orderId] = [...this.requested].sort((a, b) => a - b);
        this.requested.delete(orderId);
        await this.drainOrder(orderId);
      }
    } catch (error) {
      this.logger.warn(`Deferred realtime drain pass failed: ${message(error)}`);
      await this.closeConnection();
    }
  }

  /** Orders with due rows; the queue table is locked NOWAIT so DDL is never waited for. */
  private async dueOrders(): Promise<number[]> {
    const db = await this.db();
    try {
      await db.query('BEGIN');
      await db.query("SET LOCAL lock_timeout = '50ms'");
      await db.query('LOCK TABLE order_realtime_deferred IN ACCESS SHARE MODE NOWAIT');
      const due = await db.query<{ order_id: string | number }>(
        `SELECT DISTINCT order_id FROM order_realtime_deferred
         WHERE next_attempt_at <= now() ORDER BY order_id LIMIT ${SWEEP_BATCH}`,
      );
      const stale = await db.query<{ count: string | number }>(
        `SELECT count(*) AS count FROM order_realtime_deferred
         WHERE created_at < now() - interval '${STALE_WARNING_MINUTES} minutes'`,
      );
      await db.query('COMMIT');
      const staleCount = Number(stale.rows[0]?.count ?? 0);
      if (staleCount > 0) {
        this.logger.warn(`Deferred realtime queue has ${staleCount} row(s) older than ${STALE_WARNING_MINUTES} min`);
      }
      return due.rows.map((row) => Number(row.order_id));
    } catch (error) {
      await db.query('ROLLBACK').catch(() => undefined);
      if (sqlState(error) !== LOCK_NOT_AVAILABLE) throw error;
      return [];
    }
  }

  /** One non-waiting attempt for one order (plan §5.7 п.5 steps 0–5). */
  async drainOrder(orderId: number): Promise<DrainAttemptResult> {
    const db = await this.db();
    let ids: number[] = [];
    try {
      await db.query('BEGIN');
      // Safety net only; the guarantee is that every lock below is NOWAIT / SKIP LOCKED.
      await db.query("SET LOCAL lock_timeout = '50ms'");
      for (const statement of ORDER_REALTIME_DRAIN_TABLE_LOCKS) await db.query(statement);
      const rows = (await db.query<QueueRow>(
        `SELECT order_realtime_deferred_id, domains, detail_ids, source_type
         FROM order_realtime_deferred
         WHERE order_id = $1
         ORDER BY order_realtime_deferred_id
         FOR UPDATE SKIP LOCKED`,
        [orderId],
      )).rows;
      ids = rows.map((row) => Number(row.order_realtime_deferred_id));
      if (rows.length === 0) {
        await db.query('COMMIT');
        return 'empty';
      }
      // The stream row exists in advance (migration 220 backfill + order insert trigger);
      // the drain never creates it (no speculative insert wait).
      const stream = await db.query('SELECT 1 FROM order_realtime_stream WHERE order_id = $1 FOR UPDATE NOWAIT', [orderId]);
      if (stream.rows.length === 0) {
        await db.query('ROLLBACK');
        this.logger.warn(`Deferred realtime drain: no stream row for order ${orderId}; queue kept`);
        await this.backoff(orderId, ids, 'stream row missing');
        return 'stream_missing';
      }
      await this.afterStreamLocked(orderId);
      await db.query('SELECT 1 FROM orders WHERE order_id = $1 FOR KEY SHARE NOWAIT', [orderId]);
      for (const row of rows) {
        const result = await db.query<{ emitted: boolean }>(
          'SELECT order_realtime_emit_one($1::bigint, $2::text[], $3::bigint[], $4::text) AS emitted',
          [orderId, row.domains, row.detail_ids, row.source_type],
        );
        if (result.rows[0]?.emitted !== true) {
          // Bridge switched off since the command: keep the queue, deliver after it is on again.
          await db.query('ROLLBACK');
          await this.backoff(orderId, ids, 'realtime bridge disabled');
          return 'bridge_disabled';
        }
      }
      await db.query('DELETE FROM order_realtime_deferred WHERE order_realtime_deferred_id = ANY($1::bigint[])', [ids]);
      await db.query("SELECT pg_notify('erp_realtime', 'wake')");
      await db.query('COMMIT');
      return 'delivered';
    } catch (error) {
      await db.query('ROLLBACK').catch(() => undefined);
      const busy = sqlState(error) === LOCK_NOT_AVAILABLE;
      if (!busy) this.logger.warn(`Deferred realtime drain for order ${orderId} failed: ${message(error)}`);
      await this.backoff(orderId, ids, busy ? 'lock not available' : message(error)).catch(() => undefined);
      return busy ? 'busy' : 'failed';
    }
  }

  /** Test seam between the stream lock (step 2) and the order lock (step 3); no-op in production. */
  protected async afterStreamLocked(_orderId: number): Promise<void> {}

  /** attempts++ and exponential next_attempt_at, itself without waiting (NOWAIT / SKIP LOCKED). */
  private async backoff(orderId: number, ids: number[], reason: string): Promise<void> {
    const db = await this.db();
    try {
      await db.query('BEGIN');
      await db.query("SET LOCAL lock_timeout = '50ms'");
      await db.query('LOCK TABLE order_realtime_deferred IN ROW EXCLUSIVE MODE NOWAIT');
      await db.query(
        `UPDATE order_realtime_deferred
         SET attempts = attempts + 1,
             next_attempt_at = now() + least(interval '5 minutes', interval '1 second' * power(2, least(attempts, 8))),
             last_error = left($3, 500)
         WHERE order_realtime_deferred_id IN (
           SELECT order_realtime_deferred_id FROM order_realtime_deferred
           WHERE order_id = $1 AND (cardinality($2::bigint[]) = 0 OR order_realtime_deferred_id = ANY($2::bigint[]))
           FOR UPDATE SKIP LOCKED)`,
        [orderId, ids, reason],
      );
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK').catch(() => undefined);
      if (sqlState(error) !== LOCK_NOT_AVAILABLE) throw error;
    }
  }

  private async db(): Promise<DrainConnection> {
    if (!this.connection) {
      const connection = await this.openConnection();
      connection.on?.('error', (error) => {
        this.logger.warn(`Deferred realtime drain connection error: ${error.message}`);
        if (this.connection === connection) this.connection = null;
      });
      this.connection = connection;
    }
    return this.connection;
  }

  private async closeConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    await connection?.end().catch(() => undefined);
  }

  /** Own connection (not the pool): its application_name marks an active drain for apply-migrations.sh. */
  protected async openConnection(): Promise<DrainConnection> {
    const timeout = this.config.get('DATABASE_QUERY_TIMEOUT_MS', { infer: true });
    const client = new Client({
      connectionString: this.config.get('DATABASE_URL', { infer: true }),
      ssl: this.config.get('DATABASE_SSL', { infer: true }) ? { rejectUnauthorized: false } : undefined,
      application_name: ORDER_REALTIME_DRAIN_APPLICATION_NAME,
      connectionTimeoutMillis: timeout,
      statement_timeout: timeout,
      query_timeout: timeout,
    });
    await client.connect();
    return client;
  }
}

function sqlState(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
