import { describe, expect, it } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import type { TransactionClient } from '../../../database/database.types';
import { enterMdfCommand, enterMdfSerializableLegacyCommand, requireMdfCommandBoundary } from './mdf-command-boundary';

function transaction(mode: unknown = 'legacy', isolation = 'serializable') {
  const queries: string[] = [];
  const tx: TransactionClient = {
    raw: {} as TransactionClient['raw'],
    async query<T extends QueryResultRow>(sql: string): Promise<QueryResult<T>> {
      queries.push(sql);
      const rows = sql.includes('SELECT mode FROM mdf_engine_state') ? [{ mode }]
        : sql === 'SHOW transaction_isolation' ? [{ transaction_isolation: isolation }] : [];
      return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as QueryResult<T>;
    },
  };
  return { tx, queries };
}

describe('MDF command transaction boundary', () => {
  it.each(['legacy', 'shadow'] as const)('serializable legacy entry locks current state in %s', async mode => {
    const f = transaction(mode);
    expect(await enterMdfSerializableLegacyCommand(f.tx, 'mdf.production_return')).toEqual({ mode, queued: false });
    expect(f.queries).toEqual(['SHOW transaction_isolation',
      "SELECT pg_advisory_xact_lock_shared(hashtextextended('mdf-engine-cutover',0))",
      'SELECT mode FROM mdf_engine_state WHERE singleton=true FOR SHARE']);
    expect(await requireMdfCommandBoundary(f.tx, { writer: 'nested-return', capability: 'legacy-only' }))
      .toEqual({ mode, queued: false });
    await expect(requireMdfCommandBoundary(f.tx, { writer: 'queued', capability: 'queued' }))
      .rejects.toMatchObject({ code: 'MDF_COMMAND_ISOLATION_UNSUPPORTED' });
    await expect(enterMdfCommand(f.tx, { writer: 'queued', capability: 'queued' }))
      .rejects.toMatchObject({ code: 'MDF_COMMAND_ISOLATION_UNSUPPORTED' });
    await expect(enterMdfSerializableLegacyCommand(f.tx, 'again'))
      .rejects.toMatchObject({ code: 'MDF_COMMAND_BOUNDARY_CONFLICT' });
    expect(f.queries).toHaveLength(3);
  });

  it.each(['active', 'read_only', 'invalid', null])('serializable legacy entry fails closed for %s', async mode => {
    const f = transaction(mode);
    await expect(enterMdfSerializableLegacyCommand(f.tx, 'mdf.production_return')).rejects.toMatchObject({
      code: mode === 'active' ? 'MDF_WRITER_NOT_CONNECTED' : mode === 'read_only'
        ? 'MDF_ENGINE_READ_ONLY' : 'MDF_ENGINE_STATE_UNAVAILABLE',
    });
    expect(f.queries.at(-1)).toContain('FOR SHARE');
  });

  it.each(['read committed', 'repeatable read', 'unknown'])('serializable legacy entry rejects isolation %s', async isolation => {
    const f = transaction('legacy', isolation);
    await expect(enterMdfSerializableLegacyCommand(f.tx, 'mdf.production_return'))
      .rejects.toMatchObject({ code: 'MDF_COMMAND_ISOLATION_UNSUPPORTED' });
    expect(f.queries).toEqual(['SHOW transaction_isolation']);
  });

  it('serializable legacy entry never reuses an existing RC boundary cache', async () => {
    const f = transaction('legacy');
    await enterMdfCommand(f.tx, { writer: 'other', capability: 'queued' });
    await expect(enterMdfSerializableLegacyCommand(f.tx, 'mdf.production_return'))
      .rejects.toMatchObject({ code: 'MDF_COMMAND_BOUNDARY_CONFLICT' });
    expect(f.queries).toHaveLength(2);
  });

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

  it('allows only the dedicated private cut-lease settlement in read_only',async()=>{
    const f=transaction('read_only');
    expect(await enterMdfCommand(f.tx,{ writer:'cut.calculate.settlement',capability:'cut-settlement' }))
      .toEqual({ mode:'read_only',queued:true });
    await expect(enterMdfCommand(f.tx,{ writer:'manual-move',capability:'cut-settlement' })).rejects.toMatchObject({ code:'MDF_WRITER_NOT_CONNECTED' });
    await expect(enterMdfCommand(f.tx,{ writer:'manual-move',capability:'queued' })).rejects.toMatchObject({ code:'MDF_ENGINE_READ_ONLY' });
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
