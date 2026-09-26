import { createHash, randomUUID } from 'node:crypto';
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
    for (const file of ['165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql', '175_mdf_command_placement.sql', '178_mdf_correction_receipts.sql', '188_mdf_order_cascade_intents.sql', '189_mdf_placement_inputs.sql', '190_mdf_bath_transitions.sql']) {
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
    const line = receipt('new').lines[0];
    const legacyDigest = createHash('sha256').update(JSON.stringify([
      'cnc', [[line.lineKey,line.orderId,line.detailId,line.quantity,line.stageCode,line.evidenceKind,line.rework]], null,
    ])).digest('hex');
    expect((await client.query("SELECT payload_digest FROM mdf_evidence_revisions WHERE source_id='E2E-new'")).rows[0].payload_digest)
      .toBe(legacyDigest);
    expect((await client.query('SELECT effect_policy FROM mdf_recalculation_jobs WHERE job_id=$1',[result.jobId])).rows[0].effect_policy)
      .toBe('forward');
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
  it('accepts an explicitly fenced correction as publish_only and exact replay does not advance either fence', async () => {
    const original = await save(receipt('correction'));
    const correction: MdfReceiptInput = {
      ...receipt('correction'), revisionKey: '2', correction: true,
      expectedFence: { version: original.version, correctionEpoch: original.correctionEpoch },
      executionContext: { sourceCreatedAt: '2026-09-01T00:00:00Z', displayName: 'E2E correction',
        priorColumn: 'parsed', compositionComplete: true, demand: [{ orderId: 1, detailId: 11, quantity: 10 }] },
      lines: [{ ...receipt('correction').lines[0], quantity: 8 }],
    };
    const saved = await save(correction);
    expect(saved).toMatchObject({ replay: false, accepted: true, version: '2', correctionEpoch: '1' });
    expect((await client.query(`SELECT accepted_revision_key,received_revision_key,version,correction_epoch
      FROM mdf_source_heads WHERE source_id=$1`, [correction.sourceId])).rows[0])
      .toEqual({ accepted_revision_key: '2', received_revision_key: '2', version: '2', correction_epoch: '1' });
    expect((await client.query('SELECT effect_policy,status FROM mdf_recalculation_jobs WHERE job_id=$1', [saved.jobId])).rows[0])
      .toEqual({ effect_policy: 'publish_only', status: 'pending' });
    expect((await client.query(`SELECT effect_policy FROM mdf_revision_context
      WHERE source_kind='packet' AND source_id=$1 AND revision_key='2'`, [correction.sourceId])).rows[0])
      .toEqual({ effect_policy: 'publish_only' });
    const replay = await save(correction);
    expect(replay).toEqual({ ...saved, replay: true });
    expect((await client.query(`SELECT version,correction_epoch FROM mdf_source_heads WHERE source_id=$1`, [correction.sourceId])).rows[0])
      .toEqual({ version: '2', correction_epoch: '1' });
    await expect(save({ ...correction, correction: undefined }))
      .rejects.toMatchObject({ code: 'MDF_RECEIPT_CONFLICT' });
  });
  it('refuses corrections unless the fence, acceptance, and complete frozen context all agree', async () => {
    const original = await save(receipt('correction-gates'));
    const correction: MdfReceiptInput = {
      ...receipt('correction-gates'), revisionKey: '2', correction: true,
      expectedFence: { version: original.version, correctionEpoch: original.correctionEpoch },
      executionContext: { sourceCreatedAt: '2026-09-01T00:00:00Z', displayName: 'E2E correction',
        priorColumn: 'parsed', compositionComplete: true, demand: [{ orderId: 1, detailId: 11, quantity: 10 }] },
      lines: [{ ...receipt('correction-gates').lines[0], quantity: 8 }],
    };
    await expect(save({ ...correction, expectedFence: null })).rejects.toMatchObject({ code: 'MDF_SOURCE_STALE' });
    await expect(save({ ...correction, accept: false })).rejects.toMatchObject({ code: 'MDF_RECEIPT_INVALID' });
    await expect(save({ ...correction, executionContext: undefined })).rejects.toMatchObject({ code: 'MDF_RECEIPT_INVALID' });
    await expect(save({ ...correction, executionContext: { ...correction.executionContext!, compositionComplete: false } }))
      .rejects.toMatchObject({ code: 'MDF_RECEIPT_INVALID' });
    expect((await client.query("SELECT count(*) n FROM mdf_evidence_revisions WHERE source_id='E2E-correction-gates' AND revision_key='2'")).rows[0].n)
      .toBe('0');
  });
  it('does not allow correction across an unaccepted received revision or active source allocation', async () => {
    const first = await save(receipt('correction-pending'));
    const pending = await save({ ...receipt('correction-pending'), revisionKey: '2', accept: false,
      expectedFence: { version: first.version, correctionEpoch: first.correctionEpoch } });
    const pendingCorrection: MdfReceiptInput = { ...receipt('correction-pending'), revisionKey: '3', correction: true,
      expectedFence: { version: pending.version, correctionEpoch: pending.correctionEpoch },
      executionContext: { sourceCreatedAt: '2026-09-01T00:00:00Z', displayName: 'E2E correction',
        priorColumn: 'parsed', compositionComplete: true, demand: [{ orderId: 1, detailId: 11, quantity: 10 }] } };
    await expect(save(pendingCorrection)).rejects.toMatchObject({ code: 'MDF_RECEIPT_INVALID' });
    expect((await client.query("SELECT count(*) n FROM mdf_evidence_revisions WHERE source_id='E2E-correction-pending' AND revision_key='3'")).rows[0].n)
      .toBe('0');

    const allocated = await save(receipt('correction-allocated'));
    await client.query(`INSERT INTO mdf_bath_allocations
      (evidence_line_id,bath_id,bath_revision,order_id,detail_id,quantity,state,cause_key)
      SELECT evidence_line_id,'E2E-bath','1',order_id,detail_id,quantity,'reserved','E2E-correction-allocation'
      FROM mdf_evidence_lines WHERE source_id='E2E-correction-allocated'`);
    const blocked: MdfReceiptInput = { ...receipt('correction-allocated'), revisionKey: '2', correction: true,
      expectedFence: { version: allocated.version, correctionEpoch: allocated.correctionEpoch },
      executionContext: { sourceCreatedAt: '2026-09-01T00:00:00Z', displayName: 'E2E correction',
        priorColumn: 'parsed', compositionComplete: true, demand: [{ orderId: 1, detailId: 11, quantity: 10 }] } };
    await expect(save(blocked)).rejects.toMatchObject({ code: 'MDF_RECEIPT_INVALID' });
    expect((await client.query("SELECT count(*) n FROM mdf_evidence_revisions WHERE source_id='E2E-correction-allocated' AND revision_key='2'")).rows[0].n)
      .toBe('0');
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
