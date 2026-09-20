import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import { recordMdfReceipt, type MdfReceiptInput } from '../application/mdf-receipt';
import { MdfJobRunner } from '../application/mdf-job-runner';

describe.skipIf(process.env.MDF_ENGINE_INTEGRATION !== '1')('MDF receipt PostgreSQL', () => {
  const schema = `e2e_mdf_receipt_${randomUUID().replaceAll('-', '')}`;
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
        await c.query('COMMIT'); return result;
      } catch (error) { await c.query('ROLLBACK'); throw error; }
    } };
  }
  function receipt(id: string): MdfReceiptInput {
    return { sourceKind: 'packet', sourceId: `E2E-${id}`, revisionKey: '1', origin: 'cnc',
      actorUserId: 158, requestId: 'E2E-request', causeKey: `E2E-cause-${id}`, expectedFence: null,
      accept: true, rules: [{ ruleId: 17, version: 3 }],
      lines: [{ lineKey: '1', orderId: 1, detailId: 11, quantity: 10,
        stageCode: 'cut', evidenceKind: 'physical', rework: false }] };
  }
  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public`);
    for (const file of ['165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql']) {
      await client.query(readFileSync(new URL(`../../../../db/migrations/${file}`, import.meta.url), 'utf8'));
    }
  });
  afterAll(async () => {
    try {
      await client.query(`SET search_path=public; DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      expect((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows).toHaveLength(0);
    } finally { await client.end(); }
  });
  const save = (input: MdfReceiptInput) => database(client).transaction(tx => recordMdfReceipt(tx, input));
  it('atomically freezes receipt, composition, accepted head, job and rule versions', async () => {
    const result = await save(receipt('new'));
    expect(result).toMatchObject({ replay: false, accepted: true, version: '1', correctionEpoch: '0' });
    expect((await client.query('SELECT rule_id,rule_version FROM mdf_recalculation_job_rules WHERE job_id=$1', [result.jobId])).rows)
      .toEqual([{ rule_id: '17', rule_version: '3' }]);
    expect((await client.query("SELECT quantity FROM mdf_evidence_lines WHERE source_id='E2E-new'")).rows)
      .toEqual([{ quantity: '10' }]);
  });
  it('replay keeps original pins, actor and event instead of creating more quantity', async () => {
    const original = await save(receipt('replay'));
    const retry = await save({ ...receipt('replay'), requestId: 'E2E-retry', rules: [{ ruleId: 17, version: 4 }] });
    expect(retry).toEqual({ ...original, replay: true });
    expect((await client.query("SELECT count(*) n FROM mdf_evidence_lines WHERE source_id='E2E-replay'")).rows[0].n).toBe('1');
    expect((await client.query('SELECT rule_version FROM mdf_recalculation_job_rules WHERE job_id=$1', [original.jobId])).rows[0].rule_version).toBe('3');
  });
  it('rejects changed content under the same revision key', async () => {
    const input = receipt('conflict'); await save(input);
    await expect(save({ ...input, lines: [{ ...input.lines[0], quantity: 20 }] }))
      .rejects.toMatchObject({ code: 'MDF_RECEIPT_CONFLICT' });
  });
  it('rejects mismatched source fence without writing a second revision', async () => {
    const input = receipt('stale'); await save(input);
    await expect(save({ ...input, revisionKey: '2', expectedFence: { version: '2', correctionEpoch: '0' } }))
      .rejects.toMatchObject({ code: 'MDF_SOURCE_STALE' });
    expect((await client.query("SELECT count(*) n FROM mdf_evidence_revisions WHERE source_id='E2E-stale'")).rows[0].n).toBe('1');
  });
  it('new accepted revision replaces accounting head, retaining historical receipt', async () => {
    const input = receipt('advance'); await save(input);
    const next = await save({ ...input, revisionKey: '2', expectedFence: { version: '1', correctionEpoch: '0' },
      lines: [{ ...input.lines[0], quantity: 15 }] });
    expect(next).toMatchObject({ version: '2', accepted: true });
    expect((await client.query("SELECT accepted_revision_key FROM mdf_source_heads WHERE source_id='E2E-advance'")).rows[0].accepted_revision_key).toBe('2');
    const replay = await save(input);
    expect(replay).toMatchObject({ replay: true, accepted: false, version: '2' });
    expect((await client.query("SELECT accepted_revision_key FROM mdf_source_heads WHERE source_id='E2E-advance'")).rows[0].accepted_revision_key).toBe('2');
  });
  it('records unaccepted evidence for attention without replacing accepted quantities', async () => {
    const input = receipt('pending'); await save(input);
    const next = await save({ ...input, revisionKey: '2', accept: false,
      expectedFence: { version: '1', correctionEpoch: '0' } });
    expect(next.accepted).toBe(false);
    expect((await client.query('SELECT status,error_code FROM mdf_recalculation_jobs WHERE job_id=$1', [next.jobId])).rows[0])
      .toEqual({ status: 'needs_attention', error_code: 'MDF_ACCEPTANCE_REQUIRED' });
    expect((await client.query("SELECT accepted_revision_key FROM mdf_source_heads WHERE source_id='E2E-pending'")).rows[0].accepted_revision_key).toBe('1');
  });
  it('rolls receipt and queue back with the owning command transaction', async () => {
    await expect(database(client).transaction(async tx => {
      await recordMdfReceipt(tx, receipt('rollback')); await tx.query('SELECT 1/0');
    })).rejects.toMatchObject({ code: '22012' });
    expect((await client.query("SELECT count(*) n FROM mdf_evidence_revisions WHERE source_id='E2E-rollback'")).rows[0].n).toBe('0');
    expect((await client.query("SELECT count(*) n FROM mdf_recalculation_jobs WHERE source_id='E2E-rollback'")).rows[0].n).toBe('0');
  });
  it('retains a newer receipt without accepting a change to already allocated supply', async () => {
    const input = receipt('allocated'); await save(input);
    await client.query(`INSERT INTO mdf_bath_allocations
      (evidence_line_id,bath_id,bath_revision,order_id,detail_id,quantity,state,cause_key)
      SELECT evidence_line_id,'E2E-bath','1',order_id,detail_id,quantity,'consumed','E2E-allocation'
      FROM mdf_evidence_lines WHERE source_id=$1`, [input.sourceId]);
    const next = await save({ ...input, revisionKey: '2', expectedFence: { version: '1', correctionEpoch: '0' },
      lines: [{ ...input.lines[0], quantity: 5 }] });
    expect(next.accepted).toBe(false);
    expect((await client.query('SELECT received_revision_key,accepted_revision_key FROM mdf_source_heads WHERE source_id=$1', [input.sourceId])).rows[0])
      .toEqual({ received_revision_key: '2', accepted_revision_key: '1' });
    expect((await client.query('SELECT error_code FROM mdf_recalculation_jobs WHERE job_id=$1', [next.jobId])).rows[0].error_code)
      .toBe('MDF_ACCEPTANCE_REQUIRED');
  });
  it('concurrent identical receipts have one head, one job, and one set of lines', async () => {
    const other = new Client(connection); await other.connect();
    try {
      await other.query(`SET search_path=${schema},public`);
      const input = receipt('race');
      const results = await Promise.all([save(input), database(other).transaction(tx => recordMdfReceipt(tx, input))]);
      expect(results.filter(r => r.replay)).toHaveLength(1);
      expect(new Set(results.map(r => r.jobId)).size).toBe(1);
      expect((await client.query("SELECT count(*) n FROM mdf_evidence_lines WHERE source_id='E2E-race'")).rows[0].n).toBe('1');
    } finally { await other.end(); }
  });
  it('a committed receipt survives downstream SQL processing failure', async () => {
    await client.query("UPDATE mdf_recalculation_jobs SET status='superseded' WHERE status='pending'");
    const result = await save(receipt('worker'));
    await client.query("UPDATE mdf_engine_state SET mode='active'");
    const runner = new MdfJobRunner(database(client), async tx => { await tx.query('SELECT 1/0'); return 'done'; });
    expect(await runner.processOne()).toEqual({ status: 'retry', jobId: result.jobId });
    expect((await client.query("SELECT count(*) n FROM mdf_evidence_revisions WHERE source_id='E2E-worker'")).rows[0].n).toBe('1');
    expect((await client.query('SELECT status,attempts FROM mdf_recalculation_jobs WHERE job_id=$1', [result.jobId])).rows[0])
      .toEqual({ status: 'pending', attempts: 1 });
  });
});
