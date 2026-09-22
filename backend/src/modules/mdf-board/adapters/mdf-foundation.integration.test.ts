import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MdfJobRunner, MdfNeedsAttention } from '../application/mdf-job-runner';
import type { DatabaseClient } from '../../../database/database.types';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';
describe.skipIf(!enabled)('MDF foundation real PostgreSQL', () => {
  const schema = `e2e_mdf_engine_${randomUUID().replaceAll('-', '')}`;
  const connection = {
    host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
    database: process.env.PG_DB, user: process.env.PG_USER, password: process.env.PG_PASSWORD,
    connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=10000 -c lock_timeout=1000 -c max_parallel_workers_per_gather=0 -c jit=off',
  };
  const client = new Client(connection);
  function database(c: Client) {
    return { transaction: async <T>(handler: (tx: DatabaseClient) => Promise<T>): Promise<T> => {
      await c.query('BEGIN');
      try {
        const result = await handler({ query: (sql, params) => c.query(sql, params ? [...params] : []) });
        await c.query('COMMIT');
        return result;
      } catch (error) { await c.query('ROLLBACK'); throw error; }
    } };
  }
  const migration = readFileSync(new URL('../../../../db/migrations/165_mdf_engine_foundation.sql', import.meta.url), 'utf8');
  const executionMigration = readFileSync(new URL('../../../../db/migrations/174_mdf_execution_context.sql', import.meta.url), 'utf8');
  const placementMigration = readFileSync(new URL('../../../../db/migrations/175_mdf_command_placement.sql', import.meta.url), 'utf8');
  const correctionMigration = readFileSync(new URL('../../../../db/migrations/178_mdf_correction_receipts.sql', import.meta.url), 'utf8');
  const digest = 'a'.repeat(64);
  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public`);
    await client.query(migration);
    await client.query(executionMigration);
    await client.query(placementMigration);
    await client.query(correctionMigration);
    await client.query(`INSERT INTO mdf_evidence_revisions
      (source_kind,source_id,revision_key,payload_digest,origin,request_id,cause_key)
      VALUES('packet','E2E-file','1',$1,'cnc','E2E-request','E2E-cause')`, [digest]);
    await client.query(`INSERT INTO mdf_evidence_lines(source_kind,source_id,revision_key,line_key,order_id,detail_id,quantity,stage_code,evidence_kind)
      VALUES('packet','E2E-file','1','E2E-line',1,11,10,'cut','physical')`);
    await client.query(`INSERT INTO mdf_revision_seals(source_kind,source_id,revision_key) VALUES('packet','E2E-file','1')`);
    await client.query(`INSERT INTO mdf_source_heads(source_kind,source_id,received_revision_key,accepted_revision_key)
      VALUES('packet','E2E-file','1','1')`);
    await client.query('CREATE TABLE e2e_effects(value text)');
  });
  afterAll(async () => {
    try {
      await client.query(`SET search_path=public; DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      expect((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows).toHaveLength(0);
    } finally { await client.end(); }
  });
  it('migration is repeatable and defaults to legacy without business effects', async () => {
    await client.query(migration);
    expect((await client.query('SELECT mode,published_revision FROM mdf_engine_state')).rows)
      .toEqual([{ mode: 'legacy', published_revision: '0' }]);
    expect((await client.query('SELECT count(*) FROM mdf_evidence_lines')).rows[0].count).toBe('1');
  });
  it('prevents mutating and deleting frozen evidence', async () => {
    await expect(client.query("UPDATE mdf_evidence_lines SET quantity=20")).rejects.toMatchObject({ code: '55000' });
    await expect(client.query('DELETE FROM mdf_evidence_revisions')).rejects.toMatchObject({ code: '55000' });
  });
  it('cannot append another line to an already published revision', async () => {
    await expect(client.query(`INSERT INTO mdf_evidence_lines
      (source_kind,source_id,revision_key,line_key,order_id,detail_id,quantity,stage_code,evidence_kind)
      VALUES('packet','E2E-file','1','E2E-late-line',1,11,10,'cut','physical')`))
      .rejects.toMatchObject({ code: '55000' });
  });
  it('requires a real accepted source revision', async () => {
    await expect(client.query("UPDATE mdf_source_heads SET accepted_revision_key='missing'"))
      .rejects.toMatchObject({ code: '23503' });
  });
  it('prevents an allocation belonging to another detail', async () => {
    await expect(client.query(`INSERT INTO mdf_bath_allocations(evidence_line_id,bath_id,bath_revision,
      order_id,detail_id,quantity,state,cause_key)
      SELECT evidence_line_id,'E2E-bath','1',1,12,10,'reserved','E2E-wrong' FROM mdf_evidence_lines`))
      .rejects.toMatchObject({ code: '23503' });
  });
  it('rejects negative or unsafe evidence quantity', async () => {
    await client.query(`INSERT INTO mdf_evidence_revisions
      (source_kind,source_id,revision_key,payload_digest,origin,request_id,cause_key)
      VALUES('packet','E2E-file','2',$1,'cnc','E2E-request','E2E-cause')`, [digest]);
    for (const quantity of ['-1', '9007199254740992']) await expect(client.query(`INSERT INTO mdf_evidence_lines
      (source_kind,source_id,revision_key,line_key,order_id,detail_id,quantity,stage_code,evidence_kind)
      VALUES('packet','E2E-file','2',$1,1,11,$2,'cut','physical')`, [`E2E-${quantity}`, quantity]))
      .rejects.toMatchObject({ code: '23514' });
  });
  it('prevents double use, silent reassign and deletion of an allocation', async () => {
    await client.query(`INSERT INTO mdf_bath_allocations(evidence_line_id,bath_id,bath_revision,
      order_id,detail_id,quantity,state,cause_key)
      SELECT evidence_line_id,'E2E-bath','1',1,11,10,'reserved','E2E-reserve' FROM mdf_evidence_lines`);
    await expect(client.query(`INSERT INTO mdf_bath_allocations(evidence_line_id,bath_id,bath_revision,
      order_id,detail_id,quantity,state,cause_key)
      SELECT evidence_line_id,'E2E-second','1',1,11,1,'reserved','E2E-overbook' FROM mdf_evidence_lines`))
      .rejects.toMatchObject({ code: '23514' });
    await expect(client.query("UPDATE mdf_bath_allocations SET bath_id='E2E-other'"))
      .rejects.toMatchObject({ code: '55000' });
    await expect(client.query('DELETE FROM mdf_bath_allocations')).rejects.toMatchObject({ code: '55000' });
    await client.query("UPDATE mdf_bath_allocations SET state='consumed'");
    await expect(client.query('UPDATE mdf_source_heads SET accepted_revision_key=NULL'))
      .rejects.toMatchObject({ code: '23514' });
    await client.query("UPDATE mdf_bath_allocations SET state='released'");
    await expect(client.query("UPDATE mdf_bath_allocations SET state='reserved'"))
      .rejects.toMatchObject({ code: '55000' });
  });
  it('serializes competing allocation transactions, not just sequential requests', async () => {
    const other = new Client(connection);
    await other.connect();
    try {
      await other.query(`SET search_path=${schema},public`);
      await client.query('BEGIN');
      await client.query(`INSERT INTO mdf_bath_allocations(evidence_line_id,bath_id,bath_revision,
        order_id,detail_id,quantity,state,cause_key)
        SELECT evidence_line_id,'E2E-race-a','1',1,11,10,'reserved','E2E-race-a' FROM mdf_evidence_lines`);
      // Attach rejection handler immediately; second writer must wait for first.
      const competing = other.query(`INSERT INTO mdf_bath_allocations(evidence_line_id,bath_id,bath_revision,
        order_id,detail_id,quantity,state,cause_key)
        SELECT evidence_line_id,'E2E-race-b','1',1,11,10,'reserved','E2E-race-b' FROM mdf_evidence_lines`)
        .then(() => 'unexpected-success', (error: { code: string }) => error.code);
      await client.query('COMMIT');
      expect(await competing).toBe('23514');
      expect((await client.query("SELECT sum(quantity) n FROM mdf_bath_allocations WHERE state<>'released'")).rows[0].n).toBe('10');
      await client.query("UPDATE mdf_bath_allocations SET state='released'");
    } finally { await client.query('ROLLBACK'); await other.end(); }
  });
  const enqueue = async (event: string) => {
    const row = await client.query(`INSERT INTO mdf_recalculation_jobs
      (event_key,source_kind,source_id,revision_key,correction_epoch,request_id)
      VALUES($1,'packet','E2E-file','1',0,'E2E-job-request') RETURNING job_id`, [event]);
    return row.rows[0].job_id as string;
  };
  it('does not consume any jobs in legacy or read_only mode', async () => {
    const runner = new MdfJobRunner(database(client), async () => { throw new Error('must not run'); });
    for (const mode of ['legacy', 'shadow', 'read_only']) {
      await client.query('UPDATE mdf_engine_state SET mode=$1', [mode]);
      expect(await runner.processOne()).toEqual({ status: 'disabled' });
    }
    await client.query("UPDATE mdf_engine_state SET mode='active'");
  });
  it('keeps receipt but rolls back partial effects and retries without notification dependency', async () => {
    const jobId = await enqueue('E2E-job-retry');
    await client.query('INSERT INTO mdf_recalculation_job_rules(job_id,rule_id,rule_version) VALUES($1,17,3)', [jobId]);
    const broken = new MdfJobRunner(database(client), async (tx, job, rules) => {
      expect(job.request_id).toBe('E2E-job-request');
      expect(rules).toEqual([{ rule_id: '17', rule_version: '3' }]);
      await tx.query("INSERT INTO e2e_effects VALUES('partial')");
      await tx.query('SELECT 1 / 0');
      return 'done';
    });
    expect(await broken.processOne()).toEqual({ status: 'retry', jobId });
    expect((await client.query('SELECT * FROM e2e_effects')).rows).toEqual([]);
    expect((await client.query('SELECT status,attempts,error_code FROM mdf_recalculation_jobs WHERE job_id=$1', [jobId])).rows[0])
      .toEqual({ status: 'pending', attempts: 1, error_code: 'MDF_PROCESSING_FAILED' });
    await client.query('UPDATE mdf_recalculation_jobs SET next_attempt_at=now() WHERE job_id=$1', [jobId]);
    const working = new MdfJobRunner(database(client), async tx => {
      await tx.query("INSERT INTO e2e_effects VALUES('complete')"); return 'done';
    });
    expect(await working.processOne()).toEqual({ status: 'done', jobId });
    expect(await working.processOne()).toEqual({ status: 'idle' });
    expect((await client.query('SELECT * FROM e2e_effects')).rows).toEqual([{ value: 'complete' }]);
  });
  it('retains deterministic failures for attention instead of infinite replay', async () => {
    const jobId = await enqueue('E2E-job-attention');
    const runner = new MdfJobRunner(database(client), async () => { throw new MdfNeedsAttention('MDF_NONCONVERGENT'); });
    expect(await runner.processOne()).toEqual({ status: 'needs_attention', jobId });
    expect(await runner.processOne()).toEqual({ status: 'idle' });
  });
  it('two runners cannot process the same job while the first holds it', async () => {
    const other = new Client(connection);
    await other.connect();
    let release: () => void = () => {};
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let claimed: () => void = () => {};
    const entered = new Promise<void>(resolve => { claimed = resolve; });
    let first: Promise<unknown> | undefined;
    try {
      await other.query(`SET search_path=${schema},public`);
      const jobId = await enqueue('E2E-job-race');
      first = new MdfJobRunner(database(client), async () => { claimed(); await barrier; return 'done'; }).processOne();
      await entered;
      const second = new MdfJobRunner(database(other), async () => { throw new Error('duplicate execution'); });
      expect(await second.processOne()).toEqual({ status: 'idle' });
      release();
      expect(await first).toEqual({ status: 'done', jobId });
    } finally { release(); await first; await other.end(); }
  });
  it.each([
    { kind: 'physical', rework: true, stage: 'cut' },
    { kind: 'declaration', rework: false, stage: 'cut' },
    { kind: 'derived', rework: false, stage: 'cut' },
    { kind: 'physical', rework: false, stage: 'laminated' },
  ])('refuses non-supply evidence $kind/$rework/$stage', async ({ kind, rework, stage }) => {
    const id = `E2E-${kind}-${rework}-${stage}`;
    await client.query('BEGIN');
    try {
      await client.query(`INSERT INTO mdf_evidence_revisions
        (source_kind,source_id,revision_key,payload_digest,origin,request_id,cause_key)
        VALUES('packet',$1,'1',$2,'manual','E2E-request','E2E-cause')`, [id, digest]);
      await client.query(`INSERT INTO mdf_evidence_lines
        (source_kind,source_id,revision_key,line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework)
        VALUES('packet',$1,'1','E2E-line',1,11,10,$2,$3,$4)`, [id, stage, kind, rework]);
      await client.query("INSERT INTO mdf_revision_seals(source_kind,source_id,revision_key) VALUES('packet',$1,'1')", [id]);
      await client.query(`INSERT INTO mdf_source_heads(source_kind,source_id,received_revision_key,accepted_revision_key)
        VALUES('packet',$1,'1','1')`, [id]);
      await expect(client.query(`INSERT INTO mdf_bath_allocations(evidence_line_id,bath_id,bath_revision,
        order_id,detail_id,quantity,state,cause_key)
        SELECT evidence_line_id,'E2E-non-supply','1',1,11,1,'reserved','E2E-non-supply'
        FROM mdf_evidence_lines WHERE source_id=$1`, [id])).rejects.toMatchObject({ code: '23514' });
    } finally { await client.query('ROLLBACK'); }
  });
});
