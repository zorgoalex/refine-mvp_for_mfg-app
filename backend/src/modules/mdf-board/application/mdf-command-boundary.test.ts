import { describe, expect, it } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import type { TransactionClient } from '../../../database/database.types';
import { MDF_BASELINE_WRITER, enterMdfCommand, enterMdfSerializableLegacyCommand, requireMdfCommandBoundary } from './mdf-command-boundary';

function transaction(mode: unknown = 'legacy', isolation = 'serializable', locked = true,
  freezeRunId: string | null = null, guardMissing = false) {
  const queries: string[] = [];
  const params: unknown[][] = [];
  const tx: TransactionClient = {
    raw: {} as TransactionClient['raw'],
    async query<T extends QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<T>> {
      queries.push(sql);
      params.push(values ?? []);
      const rows = sql.includes('pg_try_advisory_xact_lock_shared') ? [{ locked }]
        : sql.includes('SELECT mode FROM mdf_engine_state') ? [{ mode }]
        : sql.includes('freeze_run_id FROM mdf_freeze_guard') ? (guardMissing ? [] : [{ freeze_run_id: freezeRunId }])
        : sql === 'SHOW transaction_isolation' ? [{ transaction_isolation: isolation }] : [];
      return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as QueryResult<T>;
    },
  };
  return { tx, queries, params };
}

describe('MDF command transaction boundary', () => {
  it.each(['legacy', 'shadow'] as const)('serializable legacy entry locks current state in %s', async mode => {
    const f = transaction(mode);
    expect(await enterMdfSerializableLegacyCommand(f.tx, 'mdf.production_return')).toEqual({ mode, queued: false });
    expect(f.queries).toEqual(['SHOW transaction_isolation',
      "SELECT pg_try_advisory_xact_lock_shared(hashtextextended('mdf-engine-cutover',0)) AS locked",
      'SELECT mode FROM mdf_engine_state WHERE singleton=true FOR SHARE',
      'SELECT freeze_run_id FROM mdf_freeze_guard WHERE singleton=true FOR SHARE',
      "SELECT set_config('mdf.command_writer',$1,true)"]);
    expect(await requireMdfCommandBoundary(f.tx, { writer: 'nested-return', capability: 'legacy-only' }))
      .toEqual({ mode, queued: false });
    await expect(requireMdfCommandBoundary(f.tx, { writer: 'queued', capability: 'queued' }))
      .rejects.toMatchObject({ code: 'MDF_COMMAND_ISOLATION_UNSUPPORTED' });
    await expect(enterMdfCommand(f.tx, { writer: 'queued', capability: 'queued' }))
      .rejects.toMatchObject({ code: 'MDF_COMMAND_ISOLATION_UNSUPPORTED' });
    await expect(enterMdfSerializableLegacyCommand(f.tx, 'again'))
      .rejects.toMatchObject({ code: 'MDF_COMMAND_BOUNDARY_CONFLICT' });
    expect(f.queries).toHaveLength(5);
  });

  it.each(['active', 'read_only', 'invalid', null])('serializable legacy entry fails closed for %s', async mode => {
    const f = transaction(mode);
    await expect(enterMdfSerializableLegacyCommand(f.tx, 'mdf.production_return')).rejects.toMatchObject({
      code: mode === 'active' ? 'MDF_WRITER_NOT_CONNECTED' : mode === 'read_only'
        ? 'MDF_ENGINE_READ_ONLY' : 'MDF_ENGINE_STATE_UNAVAILABLE',
    });
    const modeQuery = f.queries.find(q => q.includes('SELECT mode FROM mdf_engine_state'));
    expect(modeQuery).toContain('FOR SHARE');
    if (mode === 'active' || mode === 'read_only') {
      // valid mode: loadMode ran to completion (freeze guard read + writer tag set) before checkCapability threw.
      expect(f.queries.some(q => q.includes('freeze_run_id'))).toBe(true);
      expect(f.queries.some(q => q.includes('set_config'))).toBe(true);
    } else {
      // invalid mode: loadMode fails closed right after the mode read, never reaching the freeze guard.
      expect(f.queries.some(q => q.includes('freeze_run_id'))).toBe(false);
    }
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
    expect(f.queries).toHaveLength(4);
  });

  it.each(['legacy', 'shadow'] as const)('preserves legacy routing in %s mode', async mode => {
    const f = transaction(mode);
    expect(await enterMdfCommand(f.tx, { writer: 'manual-move', capability: 'queued' }))
      .toEqual({ mode, queued: false });
    expect(f.queries).toHaveLength(4);
    expect(f.queries[0]).toContain("pg_try_advisory_xact_lock_shared(hashtextextended('mdf-engine-cutover',0))");
    expect(f.queries[1]).toContain('SELECT mode FROM mdf_engine_state');
    expect(f.queries[2]).toContain('freeze_run_id FROM mdf_freeze_guard');
    expect(f.queries[3]).toContain("set_config('mdf.command_writer'");
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
    expect(f.queries).toHaveLength(4);
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
    expect(f.queries).toHaveLength(4);
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

  // §5.7b: fail-fast cutover fence + durable baseline freeze.
  it('try-lock false throws MDF_CUTOVER_IN_PROGRESS before any mode read', async () => {
    const f = transaction('legacy', 'serializable', false);
    await expect(enterMdfCommand(f.tx, { writer: 'manual-move', capability: 'queued' }))
      .rejects.toMatchObject({ code: 'MDF_CUTOVER_IN_PROGRESS', statusCode: 409 });
    expect(f.queries).toHaveLength(1);
    expect(f.queries[0]).toContain('pg_try_advisory_xact_lock_shared');
    expect(f.queries.some(q => q.includes('mdf_engine_state'))).toBe(false);
  });

  it('try-lock false also fails fast the serializable legacy entrance', async () => {
    const f = transaction('legacy', 'serializable', false);
    await expect(enterMdfSerializableLegacyCommand(f.tx, 'mdf.production_return'))
      .rejects.toMatchObject({ code: 'MDF_CUTOVER_IN_PROGRESS', statusCode: 409 });
    expect(f.queries.some(q => q.includes('mdf_engine_state'))).toBe(false);
  });

  it('a durable freeze rejects an ordinary writer with MDF_CUTOVER_IN_PROGRESS via enterMdfCommand', async () => {
    const f = transaction('legacy', 'serializable', true, 'run-123');
    await expect(enterMdfCommand(f.tx, { writer: 'manual-move', capability: 'queued' }))
      .rejects.toMatchObject({ code: 'MDF_CUTOVER_IN_PROGRESS', statusCode: 409 });
  });

  it('a durable freeze rejects an ordinary writer with MDF_CUTOVER_IN_PROGRESS via the serializable legacy entrance', async () => {
    const f = transaction('legacy', 'serializable', true, 'run-123');
    await expect(enterMdfSerializableLegacyCommand(f.tx, 'manual-move'))
      .rejects.toMatchObject({ code: 'MDF_CUTOVER_IN_PROGRESS', statusCode: 409 });
  });

  it('admits the baseline writer only while frozen and in read_only mode', async () => {
    const f = transaction('read_only', 'serializable', true, 'run-1');
    expect(await enterMdfCommand(f.tx, { writer: MDF_BASELINE_WRITER, capability: 'baseline' }))
      .toEqual({ mode: 'read_only', queued: true });
  });

  it('rejects the baseline writer with MDF_BASELINE_NOT_RUNNING when no run is frozen', async () => {
    const f = transaction('read_only', 'serializable', true, null);
    await expect(enterMdfCommand(f.tx, { writer: MDF_BASELINE_WRITER, capability: 'baseline' }))
      .rejects.toMatchObject({ code: 'MDF_BASELINE_NOT_RUNNING', statusCode: 409 });
  });

  it('rejects the baseline writer with MDF_BASELINE_MODE_INVALID when frozen but not in read_only mode', async () => {
    const f = transaction('active', 'serializable', true, 'run-1');
    await expect(enterMdfCommand(f.tx, { writer: MDF_BASELINE_WRITER, capability: 'baseline' }))
      .rejects.toMatchObject({ code: 'MDF_BASELINE_MODE_INVALID', statusCode: 409 });
  });

  it('rejects a wrong writer claiming baseline capability with MDF_WRITER_NOT_CONNECTED regardless of freeze', async () => {
    const f = transaction('read_only', 'serializable', true, 'run-1');
    await expect(enterMdfCommand(f.tx, { writer: 'not-the-baseline-writer', capability: 'baseline' }))
      .rejects.toMatchObject({ code: 'MDF_WRITER_NOT_CONNECTED', statusCode: 503 });
  });

  it('issues set_config with the entering writer name', async () => {
    const f = transaction('active');
    await enterMdfCommand(f.tx, { writer: 'manual-move', capability: 'queued' });
    const idx = f.queries.findIndex(q => q.includes("set_config('mdf.command_writer'"));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(f.params[idx]).toEqual(['manual-move']);
  });

  it('fails closed MDF_ENGINE_STATE_UNAVAILABLE when the freeze guard row is missing', async () => {
    const f = transaction('active', 'serializable', true, null, true);
    await expect(enterMdfCommand(f.tx, { writer: 'manual-move', capability: 'queued' }))
      .rejects.toMatchObject({ code: 'MDF_ENGINE_STATE_UNAVAILABLE', statusCode: 503 });
  });
});
