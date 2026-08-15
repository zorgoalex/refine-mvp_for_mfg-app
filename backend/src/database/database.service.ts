import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { ApiError } from '../common/errors/api-error';
import type { BackendEnv } from '../config/env.validation';
import type { DatabaseClient, DatabaseQueryOptions, TransactionClient } from './database.types';
import { PerformanceQueryTelemetryService } from '../performance/performance-query-telemetry.service';

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

class PgTransactionClient implements TransactionClient {
  constructor(
    readonly raw: PoolClient,
    private readonly defaultTimeoutMs: number,
    private readonly telemetry: PerformanceQueryTelemetryService,
  ) {}

  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
    options: DatabaseQueryOptions = {},
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

  async transaction<T>(handler: (client: TransactionClient) => Promise<T>): Promise<T> {
    const pool = this.requirePool();
    const rawClient = await withTimeout(pool.connect(), this.queryTimeoutMs, 'Database connect');
    const client = new PgTransactionClient(rawClient, this.queryTimeoutMs, this.telemetry);

    try {
      await client.query('BEGIN');
      const result = await handler(client);
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
      rawClient.release();
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
