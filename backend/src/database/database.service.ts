import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { ApiError } from '../common/errors/api-error';
import type { BackendEnv } from '../config/env.validation';
import type { DatabaseClient, DatabaseQueryOptions, TransactionClient } from './database.types';
import { PerformanceQueryTelemetryService } from '../performance/performance-query-telemetry.service';
import { RequestContextService } from '../common/request-context/request-context.service';
import { beginTransactionHooks, flushTransactionHooks, discardTransactionHooks } from './transaction-hooks';
import { enterMdfCommand, discardMdfCommandBoundary, type MdfCommandWriter } from '../modules/mdf-board/application/mdf-command-boundary';

export interface DatabaseTransactionOptions {
  isolation?: 'read committed' | 'repeatable read' | 'serializable';
  mdf?: MdfCommandWriter;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ApiError(503, 'DATABASE_TIMEOUT', `${label} timed out`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

/** Connections kept free for other requests before a snapshot read takes followers. */
const SNAPSHOT_POOL_RESERVE = 3;

function spareSnapshotFollowers(pool: Pool): number {
  const max = pool.options.max ?? 10;
  return Math.max(0, pool.idleCount + (max - pool.totalCount) - pool.waitingCount - SNAPSHOT_POOL_RESERVE);
}

// PostgreSQL rejects SET TRANSACTION ISOLATION LEVEL after the first query;
// COMMIT/ROLLBACK end the transaction and need no setup.
const SKIPS_DEFERRED = /^\s*(SET\s+TRANSACTION|COMMIT|ROLLBACK)\b/i;

class PgTransactionClient implements TransactionClient {
  private deferred?: { text: string; params: readonly unknown[] };

  constructor(
    readonly raw: PoolClient,
    private readonly defaultTimeoutMs: number,
    private readonly telemetry: PerformanceQueryTelemetryService,
  ) {}

  // Runs right before the handler's first query that is not SET TRANSACTION,
  // so handlers can still choose their isolation level first.
  deferUntilFirstQuery(text: string, params: readonly unknown[]): void {
    this.deferred = { text, params };
  }

  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
    options: DatabaseQueryOptions = {},
  ): Promise<QueryResult<T>> {
    const deferred = this.deferred;
    if (!deferred || SKIPS_DEFERRED.test(text)) return this.run<T>(text, params, options);
    this.deferred = undefined;
    // Both are queued on the connection now, in order; the result is the handler's.
    const setup = this.run(deferred.text, deferred.params, {});
    const result = this.run<T>(text, params, options);
    return Promise.all([setup, result]).then(([, value]) => value);
  }

  private run<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[],
    options: DatabaseQueryOptions,
  ): Promise<QueryResult<T>> {
    return this.telemetry.measure(text, () =>
      withTimeout(
        this.raw.query<T>(text, [...params]),
        options.timeoutMs ?? this.defaultTimeoutMs,
        'Database query',
      ),
    );
  }
}

@Injectable()
export class DatabaseService implements OnModuleDestroy, DatabaseClient {
  private readonly pool?: Pool;
  private readonly queryTimeoutMs: number;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>,
    private readonly telemetry: PerformanceQueryTelemetryService,
    @Optional() private readonly requestContexts?: RequestContextService,
  ) {
    this.queryTimeoutMs = this.config.get('DATABASE_QUERY_TIMEOUT_MS', { infer: true });
    const connectionString = this.config.get('DATABASE_URL', { infer: true });

    if (!connectionString) {
      return;
    }

    this.pool = new Pool({
      connectionString,
      min: this.config.get('DATABASE_POOL_MIN', { infer: true }),
      max: this.config.get('DATABASE_POOL_MAX', { infer: true }),
      ssl: this.config.get('DATABASE_SSL', { infer: true })
        ? { rejectUnauthorized: false }
        : undefined,
      connectionTimeoutMillis: this.queryTimeoutMs,
      statement_timeout: this.queryTimeoutMs,
      query_timeout: this.queryTimeoutMs,
    });
  }

  get isConfigured(): boolean {
    return Boolean(this.pool);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
    options: DatabaseQueryOptions = {},
  ): Promise<QueryResult<T>> {
    const pool = this.requirePool();
    return this.telemetry.measure(text, () =>
      withTimeout(
        pool.query<T>(text, [...params]),
        options.timeoutMs ?? this.queryTimeoutMs,
        'Database query',
      ),
    );
  }

  async transaction<T>(handler: (client: TransactionClient) => Promise<T>, options: DatabaseTransactionOptions = {}): Promise<T> {
    // The boundary's cutover lock is a try-lock (fails fast during a cutover, §5.7b); its
    // snapshot must still not be reused by the following mode SELECT. Unsafe under RR/serializable.
    if (options.mdf && options.isolation && options.isolation !== 'read committed') {
      throw new ApiError(503, 'MDF_COMMAND_ISOLATION_UNSUPPORTED', 'Команда требует отдельного протокола производственной транзакции');
    }
    const isolation = options.mdf ? 'read committed' : options.isolation;
    if (isolation && !['read committed', 'repeatable read', 'serializable'].includes(isolation)) {
      throw new Error('INVALID_TRANSACTION_ISOLATION');
    }
    const pool = this.requirePool();
    const rawClient = await withTimeout(pool.connect(), this.queryTimeoutMs, 'Database connect');
    const client = new PgTransactionClient(rawClient, this.queryTimeoutMs, this.telemetry);

    try {
      await client.query('BEGIN');
      // Explicit RC also protects against a stricter server/pool default.
      if (isolation) await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolation.toUpperCase()}`);
      if (options.mdf) await enterMdfCommand(client, options.mdf);
      beginTransactionHooks(client);
      // Transaction-local: database triggers that write audit (migration 266)
      // correlate it with the HTTP request; pooled connections never keep it.
      const requestId = this.requestContexts?.get()?.requestId;
      if (requestId && requestId !== 'req_unknown') {
        client.deferUntilFirstQuery("SELECT set_config('erp.request_id', $1, true)", [requestId]);
      }
      const result = await handler(client);
      await flushTransactionHooks(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    } finally {
      discardTransactionHooks(client);
      discardMdfCommandBoundary(client);
      rawClient.release();
    }
  }

  /**
   * Read-only REPEATABLE READ view in which every query sees ONE database snapshot, while queries the
   * handler issues concurrently run in parallel: the leader exports its snapshot and up to
   * `parallelism - 1` follower sessions import it (SET TRANSACTION SNAPSHOT). Followers come only from
   * capacity that is spare at the moment they are taken, so a busy pool degrades to the leader alone and
   * never waits for a follower; a follower that cannot import the snapshot is destroyed, never used.
   * Once the handler settles the view closes: later queries (e.g. a sibling branch still chaining after a
   * failure) are rejected, in-flight statements drain, then every session ends and is released — a session
   * whose COMMIT/ROLLBACK is not confirmed is destroyed, not returned to the pool.
   */
  async readSnapshot<T>(handler: (client: DatabaseClient) => Promise<T>,
    options: { parallelism?: number } = {}): Promise<T> {
    const pool = this.requirePool();
    // `clean`: the session's transaction end was confirmed, so it may go back to the pool.
    const lanes: { raw: PoolClient; running: Set<Promise<unknown>>; open: boolean; clean: boolean }[] = [];
    let closed = false;
    const end = async (statement: 'COMMIT' | 'ROLLBACK') => {
      closed = true;
      const outcomes = await Promise.allSettled(lanes.map(async lane => {
        await Promise.allSettled([...lane.running]);
        if (!lane.open) return;
        lane.open = false;
        await withTimeout(lane.raw.query(statement), this.queryTimeoutMs, 'Database snapshot end');
        lane.clean = true;
      }));
      const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      if (failure) throw failure.reason;
    };
    try {
      const leader = await withTimeout(pool.connect(), this.queryTimeoutMs, 'Database connect');
      lanes.push({ raw: leader, running: new Set(), open: false, clean: false });
      await withTimeout(leader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'), this.queryTimeoutMs, 'Database query');
      lanes[0].open = true;
      const wanted = Math.max(0, Math.trunc(options.parallelism ?? 1) - 1);
      const id = wanted > 0 ? (await withTimeout(leader.query<{ id: string }>('SELECT pg_export_snapshot() id'),
        this.queryTimeoutMs, 'Database query')).rows[0]?.id : undefined;
      if (id && /^[0-9A-F-]+$/i.test(id)) {
        // Capacity is read and every follower `connect()` is issued in this same synchronous step, so
        // concurrent snapshot reads cannot all count the same spare connections.
        const acquisitions = Array.from({ length: Math.min(wanted, spareSnapshotFollowers(pool)) }, () => pool.connect());
        await Promise.all(acquisitions.map(async acquisition => {
          const raw = await acquisition.catch(() => null);
          if (!raw) return;
          try {
            await withTimeout(raw.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'), this.queryTimeoutMs, 'Database query');
            await withTimeout(raw.query(`SET TRANSACTION SNAPSHOT '${id}'`), this.queryTimeoutMs, 'Database query');
            lanes.push({ raw, running: new Set(), open: true, clean: false });
          } catch (error) {
            raw.release(error instanceof Error ? error : true);
          }
        }));
      }
      const client: DatabaseClient = {
        query: <R extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = [],
          queryOptions: DatabaseQueryOptions = {}) => {
          if (closed) return Promise.reject(new ApiError(503, 'DATABASE_SNAPSHOT_CLOSED', 'Database snapshot is closed'));
          const lane = lanes.reduce((best, next) => next.running.size < best.running.size ? next : best);
          return this.telemetry.measure(text, () => {
            const running = lane.raw.query<R>(text, [...params]);
            const tracked = running.then(() => undefined, () => undefined);
            lane.running.add(tracked);
            void tracked.then(() => lane.running.delete(tracked));
            return withTimeout(running, queryOptions.timeoutMs ?? this.queryTimeoutMs, 'Database query');
          });
        },
      };
      const result = await handler(client);
      await end('COMMIT');
      return result;
    } catch (error) {
      await end('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      for (const lane of lanes) lane.raw.release(lane.clean ? undefined : true);
    }
  }

  async connectDedicated(label = 'Database dedicated connect'): Promise<PoolClient> {
    const pool = this.requirePool();
    return withTimeout(pool.connect(), this.queryTimeoutMs, label);
  }

  /**
   * Runs a handler while one dedicated PostgreSQL session owns a global
   * advisory lock. No transaction is held across the handler.
   *
   * Returns null when another session owns the lock. The supplied assertion
   * probes the same session, so a disconnected lock holder fails closed before
   * its next external side effect.
   */
  async withAdvisoryLock<T>(
    key: string,
    handler: (assertOwned: () => Promise<void>) => Promise<T>,
  ): Promise<T | null> {
    const pool = this.requirePool();
    const raw = await withTimeout(pool.connect(), this.queryTimeoutMs, 'Database connect');
    let acquired = false;
    try {
      const result = await withTimeout(
        raw.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
          [key],
        ),
        this.queryTimeoutMs,
        'Database advisory lock',
      );
      acquired = Boolean(result.rows[0]?.acquired);
      if (!acquired) return null;

      const assertOwned = async () => {
        await withTimeout(
          raw.query('SELECT 1'),
          this.queryTimeoutMs,
          'Database advisory lock heartbeat',
        );
      };
      return await handler(assertOwned);
    } finally {
      if (acquired) {
        await raw
          .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key])
          .catch(() => undefined);
      }
      raw.release();
    }
  }

  async ping(): Promise<boolean> {
    if (!this.pool) {
      return false;
    }

    await this.query('SELECT 1 AS ok');
    return true;
  }

  private requirePool(): Pool {
    if (!this.pool) {
      throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is not configured');
    }

    return this.pool;
  }
}
