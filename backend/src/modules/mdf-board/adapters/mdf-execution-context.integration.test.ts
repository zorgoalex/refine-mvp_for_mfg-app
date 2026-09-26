import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import { recordMdfReceipt, type MdfReceiptInput } from '../application/mdf-receipt';

describe.skipIf(process.env.MDF_ENGINE_INTEGRATION !== '1')('sealed MDF execution context PostgreSQL', () => {
  const schema = `e2e_mdf_context_${randomUUID().replaceAll('-', '')}`;
  const db = new Client({ host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
    database: process.env.PG_DB, user: process.env.PG_USER, password: process.env.PG_PASSWORD,
    connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=10000 -c lock_timeout=1000 -c max_parallel_workers_per_gather=0 -c jit=off' });
  const receipt = (): MdfReceiptInput => ({ sourceKind: 'packet', sourceId: randomUUID(), revisionKey: '1',
    origin: 'cnc', actorUserId: 158, requestId: 'E2E-context', causeKey: 'E2E-context', expectedFence: null,
    accept: true, rules: [], lines: [{ lineKey: 'member', orderId: 1, detailId: 11, quantity: 4,
      stageCode: 'membership', evidenceKind: 'derived', rework: false }, { lineKey: 'cut', orderId: 1,
      detailId: 11, quantity: 4, stageCode: 'cut', evidenceKind: 'physical', rework: false }],
    executionContext: { sourceCreatedAt: '2026-09-01T00:00:00Z', displayName: 'E2E MDF 18', priorColumn: 'parsed',
      compositionComplete: true, demand: [{ orderId: 1, detailId: 11, quantity: 10 }, { orderId: 1, detailId: 12, quantity: 5 }] } });
  async function transaction<T>(fn: (tx: DatabaseClient) => Promise<T>) {
    await db.query('BEGIN');
    try { const result = await fn({ query: (sql,args) => db.query(sql,args ? [...args] : []) });
      await db.query('COMMIT'); return result;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
  }
  beforeAll(async () => {
    await db.connect(); await db.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public`);
    // Repeat the additive context migration deliberately: deployment retries must be safe.
    for (const file of ['165_mdf_engine_foundation.sql','166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql','174_mdf_execution_context.sql',
      '175_mdf_command_placement.sql','175_mdf_command_placement.sql','178_mdf_correction_receipts.sql', '188_mdf_order_cascade_intents.sql']) {
      await db.query(readFileSync(new URL(`../../../../db/migrations/${file}`,import.meta.url),'utf8'));
    }
  });
  afterAll(async () => {
    try { await db.query(`SET search_path=public; DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      expect((await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rows).toHaveLength(0);
    } finally { await db.end(); }
  });
  const save = (input: MdfReceiptInput) => transaction(tx => recordMdfReceipt(tx,input));
  it('seals full owning demand alongside partial file evidence, without publishing', async () => {
    const input = receipt(); await save(input);
    expect((await db.query('SELECT detail_id,quantity FROM mdf_revision_demand WHERE source_id=$1 ORDER BY detail_id',
      [input.sourceId])).rows).toEqual([{ detail_id: '11', quantity: '10' }, { detail_id: '12', quantity: '5' }]);
    expect((await db.query('SELECT published_revision FROM mdf_engine_state')).rows[0].published_revision).toBe('0');
    expect((await db.query('SELECT 1 FROM mdf_published_sources')).rows).toHaveLength(0);
  });
  it('replay is order-independent but changed demand conflicts', async () => {
    const input = receipt(), original = await save(input);
    const context = input.executionContext!;
    expect(await save({ ...input, executionContext: { ...context, demand: [...context.demand].reverse() } }))
      .toEqual({ ...original, replay: true });
    await expect(save({ ...input, executionContext: { ...context,
      demand: context.demand.map(d => ({ ...d, quantity: d.quantity+1 })) } })).rejects.toThrow('MDF_RECEIPT_CONFLICT');
    await expect(save({ ...input,accept: false })).rejects.toThrow('MDF_RECEIPT_CONFLICT');
  });
  it('context and demand cannot be changed, deleted or attached after sealing', async () => {
    const input = receipt(); await save(input);
    for (const sql of ["UPDATE mdf_revision_context SET display_name='changed' WHERE source_id=$1",
      'DELETE FROM mdf_revision_context WHERE source_id=$1',
      'UPDATE mdf_revision_demand SET quantity=100 WHERE source_id=$1',
      'DELETE FROM mdf_revision_demand WHERE source_id=$1',
      "INSERT INTO mdf_revision_demand VALUES('packet',$1,'1',1,99,1)"]) {
      await expect(db.query(sql,[input.sourceId])).rejects.toMatchObject({ code: '55000' });
    }
    const old = { ...receipt(), executionContext: undefined }; await save(old);
    await expect(db.query(`INSERT INTO mdf_revision_context
      (source_kind,source_id,revision_key,source_created_at,display_name,composition_complete,demand_digest)
      VALUES('packet',$1,'1',now(),'late',true,repeat('a',64))`,[old.sourceId])).rejects.toMatchObject({ code: '55000' });
  });
  it('failure rolls context back together with receipt and job', async () => {
    const input = receipt();
    await expect(transaction(async tx => { await recordMdfReceipt(tx,input); await tx.query('SELECT 1/0'); }))
      .rejects.toMatchObject({ code: '22012' });
    expect((await db.query('SELECT 1 FROM mdf_revision_context WHERE source_id=$1',[input.sourceId])).rows).toHaveLength(0);
    expect((await db.query('SELECT 1 FROM mdf_recalculation_jobs WHERE source_id=$1',[input.sourceId])).rows).toHaveLength(0);
  });
  it('rejects acceptance when own evidence is outside frozen demand', async () => {
    const input = receipt(); input.lines = input.lines.map(l => ({ ...l, detailId: 99 }));
    await expect(save(input)).rejects.toThrow('MDF_RECEIPT_INVALID');
  });
  it('freezes actor/pins/context before an awaited lock', async () => {
    const input = receipt(); input.rules = [{ ruleId: 17, version: 1 }];
    let mutated = false;
    await transaction(tx => recordMdfReceipt({ query: (sql,args) => {
      if (!mutated) {
        mutated = true; input.actorUserId = 999; input.rules = [{ ruleId: 17, version: 99 }];
        input.executionContext = { ...input.executionContext!, displayName: 'changed' };
      }
      return tx.query(sql,args);
    } },input));
    expect((await db.query('SELECT actor_user_id FROM mdf_evidence_revisions WHERE source_id=$1',[input.sourceId])).rows[0].actor_user_id).toBe('158');
    expect((await db.query('SELECT display_name FROM mdf_revision_context WHERE source_id=$1',[input.sourceId])).rows[0].display_name).toBe('E2E MDF 18');
  });
  it('seals manual placement separately and binds it into replay identity', async () => {
    const input = receipt();
    input.executionContext = { ...input.executionContext!, manualPlacementColumn: 'completed_laminated' };
    await save(input);
    expect((await db.query('SELECT prior_column,manual_placement_column FROM mdf_revision_context WHERE source_id=$1',
      [input.sourceId])).rows[0]).toEqual({ prior_column: 'parsed', manual_placement_column: 'completed_laminated' });
    await expect(save({ ...input, executionContext: { ...input.executionContext, manualPlacementColumn: null } }))
      .rejects.toThrow('MDF_RECEIPT_CONFLICT');
    await expect(db.query("UPDATE mdf_revision_context SET manual_placement_column=NULL WHERE source_id=$1", [input.sourceId]))
      .rejects.toMatchObject({ code: '55000' });
  });
  it('rejects a bath placement on a machine source before writing anything', async () => {
    const input = receipt();
    input.executionContext = { ...input.executionContext!, manualPlacementColumn: 'baths_ready' };
    await expect(save(input)).rejects.toThrow('MDF_RECEIPT_INVALID');
    expect((await db.query('SELECT 1 FROM mdf_evidence_revisions WHERE source_id=$1', [input.sourceId])).rows).toHaveLength(0);
  });
});
