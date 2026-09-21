import { describe, expect, it } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import type { TransactionClient } from '../../../database/database.types';
import { enterMdfCommand } from './mdf-command-boundary';

function transaction(mode: unknown = 'legacy') {
  const queries: string[] = [];
  const tx: TransactionClient = {
    raw: {} as TransactionClient['raw'],
    async query<T extends QueryResultRow>(sql: string): Promise<QueryResult<T>> {
      queries.push(sql);
      const rows = sql.includes('SELECT mode FROM mdf_engine_state') ? [{ mode }] : [];
      return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as QueryResult<T>;
    },
  };
  return { tx, queries };
}

describe('MDF command transaction boundary', () => {
  it.each(['legacy', 'shadow'] as const)('preserves legacy routing in %s mode', async mode => {
    const f = transaction(mode);
    expect(await enterMdfCommand(f.tx, { writer: 'manual-move', capability: 'queued' }))
      .toEqual({ mode, queued: false });
    expect(f.queries).toHaveLength(2);
    expect(f.queries[0]).toContain("pg_advisory_xact_lock_shared(hashtextextended('mdf-engine-cutover',0))");
    expect(f.queries[1]).toContain('SELECT mode FROM mdf_engine_state');
  });

  it('routes connected writers to queue in active mode', async () => {
    const f = transaction('active');
    expect(await enterMdfCommand(f.tx, { writer: 'manual-move', capability: 'queued' }))
      .toEqual({ mode: 'active', queued: true });
  });

  it('blocks an unconnected writer before its domain effects in active mode', async () => {
    const f = transaction('active');
    await expect(enterMdfCommand(f.tx, { writer: 'aggregate-save', capability: 'legacy-only' }))
      .rejects.toMatchObject({ code: 'MDF_WRITER_NOT_CONNECTED', statusCode: 503 });
    expect(f.queries).toHaveLength(2);
  });

  it.each(['queued', 'legacy-only'] as const)('blocks %s mutations in read_only', async capability => {
    const f = transaction('read_only');
    await expect(enterMdfCommand(f.tx, { writer: 'manual-move', capability }))
      .rejects.toMatchObject({ code: 'MDF_ENGINE_READ_ONLY', statusCode: 409 });
  });

  it('keeps physical CNC receipt intake available in read_only, never legacy effects', async () => {
    const f = transaction('read_only');
    expect(await enterMdfCommand(f.tx, { writer: 'cnc-receipt', capability: 'cnc-receipt' }))
      .toEqual({ mode: 'read_only', queued: true });
  });

  it('shares one fence and mode snapshot across concurrent nested entry calls', async () => {
    const f = transaction('active');
    await Promise.all(Array.from({ length: 5 }, () => enterMdfCommand(f.tx,
      { writer: 'manual-move', capability: 'queued' })));
    expect(f.queries).toHaveLength(2);
    // Cached mode does not authorize a different writer in the same transaction.
    await expect(enterMdfCommand(f.tx, { writer: 'aggregate-save', capability: 'legacy-only' }))
      .rejects.toMatchObject({ code: 'MDF_WRITER_NOT_CONNECTED' });
  });

  it.each([undefined, null, '', 'unknown', false])('fails closed for invalid mode %s', async mode => {
    const f = transaction(mode === undefined ? null : mode);
    await expect(enterMdfCommand(f.tx, { writer: 'manual-move', capability: 'queued' }))
      .rejects.toMatchObject({ code: 'MDF_ENGINE_STATE_UNAVAILABLE', statusCode: 503 });
  });

  it('does not reuse a mode snapshot across different transaction wrappers', async () => {
    const legacy = transaction('legacy'), active = transaction('active');
    expect((await enterMdfCommand(legacy.tx, { writer: 'manual-move', capability: 'queued' })).queued).toBe(false);
    expect((await enterMdfCommand(active.tx, { writer: 'manual-move', capability: 'queued' })).queued).toBe(true);
  });
});
