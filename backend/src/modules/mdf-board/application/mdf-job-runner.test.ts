import { describe, expect, it, vi } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../../database/database.types';
import { mdfRetrySeconds, MdfJobRunner, MdfNeedsAttention } from './mdf-job-runner';

describe('MDF job retry policy', () => {
  it('retries independently of notifications with bounded backoff', () => {
    expect([1, 2, 3, 4, 5, 20].map(mdfRetrySeconds)).toEqual([5, 15, 60, 300, 300, 300]);
  });
  it('rejects invalid attempts and unsafe diagnostic codes', () => {
    expect(() => mdfRetrySeconds(0)).toThrow();
    expect(() => new MdfNeedsAttention('password=secret')).toThrow('INVALID_MDF_ERROR_CODE');
    expect(new MdfNeedsAttention('MDF_UNRESOLVED_COMPOSITION').code).toBe('MDF_UNRESOLVED_COMPOSITION');
  });
});

describe('MdfJobRunner cutover fence', () => {
  // §5.7b: never wait behind a population run holding the exclusive lock;
  // report disabled immediately and claim nothing so the caller can retry on the next tick.
  it('reports disabled without claiming a job when the try-lock is unavailable', async () => {
    const queries: string[] = [];
    const tx: DatabaseClient = {
      async query<T extends QueryResultRow>(sql: string): Promise<QueryResult<T>> {
        queries.push(sql);
        const rows = sql.includes('pg_try_advisory_xact_lock_shared') ? [{ locked: false }] : [];
        return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as QueryResult<T>;
      },
    };
    const database = { transaction: (handler: (client: DatabaseClient) => Promise<unknown>) => handler(tx) };
    const handle = vi.fn();
    const runner = new MdfJobRunner(database, handle);

    await expect(runner.processOne()).resolves.toEqual({ status: 'disabled' });

    expect(queries).toEqual(["SELECT pg_try_advisory_xact_lock_shared(hashtextextended('mdf-engine-cutover',0)) AS locked"]);
    expect(handle).not.toHaveBeenCalled();
  });
});
