import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '../../../database/database.types';
import { beginTransactionHooks, discardTransactionHooks, flushTransactionHooks } from '../../../database/transaction-hooks';
import { recordMdfReceipt, type MdfReceiptInput } from '../application/mdf-receipt';
import { MdfJobRunner } from '../application/mdf-job-runner';
import { executeMdfAcceptedJob } from '../application/mdf-accepted-job';
import { readMdfPublishedSnapshot } from './mdf-published-snapshot';
import type { CurrentUser } from '../../../permissions/current-user';

describe.skipIf(process.env.MDF_ENGINE_INTEGRATION !== '1')('MDF receipt → queue → allocation → rules → publication PostgreSQL', () => {
  const schema = `e2e_mdf_job_${randomUUID().replaceAll('-','')}`;
  const config = { host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
    database: process.env.PG_DB, user: process.env.PG_USER, password: process.env.PG_PASSWORD, connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=15000 -c lock_timeout=3000 -c max_parallel_workers_per_gather=0 -c jit=off' };
  const db = new Client(config); let sequence = 0;
  const database = (client = db) => ({ transaction: async <T>(fn: (tx: TransactionClient) => Promise<T>) => {
    await client.query('BEGIN');
    const tx: TransactionClient = { raw: client as TransactionClient['raw'], query: (sql,args) => client.query(sql,args ? [...args] : []) };
    beginTransactionHooks(tx);
    try { const result = await fn(tx); await flushTransactionHooks(tx); await client.query('COMMIT'); return result; }
    catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { discardTransactionHooks(tx); }
  } });
  const runner = () => new MdfJobRunner(database(),executeMdfAcceptedJob);
  const admin: CurrentUser = { id: '1',username: 'E2E reader',role: 'admin',roleId: 2,permissions: ['orders.view'] };
  beforeAll(async () => {
    vi.stubEnv('BACKEND_STATUS_AUTOMATION','true');
    vi.stubEnv('BACKEND_ENABLE_NOTIFICATION_ENGINE','false'); // MDF processing is independent.
    await db.connect(); await db.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public`);
    for (const file of ['165_mdf_engine_foundation.sql','166_mdf_engine_fences.sql','174_mdf_execution_context.sql','175_mdf_command_placement.sql','178_mdf_correction_receipts.sql']) {
      await db.query(readFileSync(new URL(`../../../../db/migrations/${file}`,import.meta.url),'utf8'));
    }
    // Own schema only, no public business mutations or hard-coded production ids.
    for (const table of ['orders','order_details','production_statuses','order_statuses','materials','sheet_material_types',
      'users','cut_result','status_automation_rules','outbox_events','audit_log','audit_log_related_entity',
      'app_settings','bazis_order_links','order_import_entity_map','order_workshops']) {
      await db.query(`CREATE TABLE ${table} AS TABLE public.${table} WITH NO DATA`);
    }
    await db.query(`ALTER TABLE audit_log ALTER COLUMN audit_id SET DEFAULT gen_random_uuid();
      CREATE UNIQUE INDEX e2e_audit_related ON audit_log_related_entity(audit_id,entity_type,entity_id);
      CREATE UNIQUE INDEX e2e_outbox ON outbox_events(idempotency_key);
      UPDATE mdf_engine_state SET mode='active';
      INSERT INTO users(user_id,username,role_id,is_active) VALUES(1,'E2E MDF job',1,true);
      INSERT INTO materials(material_id,material_name) VALUES(1,'MDF 10 mm');
      INSERT INTO production_statuses(production_status_id,production_status_code,production_status_name,sort_order,is_active)
      VALUES(1,'new','E2E new',1,true),(2,'cut','Распилен',20,true),(3,'laminated','Закатан',30,true),
        (4,'packed','Упакован',40,true),(5,'issued','Выдан',50,true);
      INSERT INTO status_automation_rules(id,name,event_type,action_type,target_status_id,conditions_json,priority,is_enabled,version,action_config_json)
      VALUES(17,'E2E queued cut','mdf.board.completed','change_details_production_status',2,'{}',100,true,1,'{}'),
        (18,'E2E queued bath','mdf.board.baths_laminated','change_details_production_status',3,'{}',100,true,1,'{}')`);
    // Copy exact existing pure summary/recalc functions into this test schema.
    // Their unqualified relations resolve here. Do NOT invoke a public-bound body.
    for (const signature of ['order_production_summary(bigint,bigint[])','recalc_order_production_status(bigint)']) {
      const definition = (await db.query<{ definition: string }>('SELECT pg_get_functiondef($1::regprocedure) definition',
        [`public.${signature}`])).rows[0].definition;
      expect(definition).not.toMatch(/(?:FROM|UPDATE|JOIN)\s+public\./i);
      await db.query(definition.replace('FUNCTION public.',`FUNCTION ${schema}.`));
    }
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    try { await db.query(`SET search_path=public; DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      expect((await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rows).toHaveLength(0);
    } finally { await db.end(); }
  });
  async function fixture(options: { rolled?: boolean; context?: boolean } = {}) {
    // Previous fixtures must not leave claimable jobs ahead of this scenario.
    await db.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    const orderId = ++sequence, detailId = orderId*10;
    await db.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,payment_status_id)
      VALUES($1,$2,'production_order',false,1,4,1);
    `,[orderId,`E2E queued ${orderId}`]);
    await db.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,material_id)
      VALUES($1,$2,1,10,1,false,1),($3,$2,2,1,1,false,1)`,[detailId,orderId,detailId+1]);
    await db.query("INSERT INTO cut_result(cut_result_id,created_at) VALUES($1,'2026-09-01')",[orderId]);
    const demand = [{ orderId,detailId,quantity: 10 },{ orderId,detailId: detailId+1,quantity: 1 }];
    const make = (kind: 'packet'|'bazisCutSet'|'bath', id: string, quantity: number): MdfReceiptInput => ({
      sourceKind: kind,sourceId: id,revisionKey: '1',origin: kind==='packet' ? 'cnc' : 'manual',actorUserId: 1,
      requestId: 'E2E queued',causeKey: `E2E ${id}`,expectedFence: null,accept: true,
      rules: [{ ruleId: 17,version: 1 },{ ruleId: 18,version: 1 }],
      executionContext: options.context===false ? undefined : { sourceCreatedAt: '2026-09-01T00:00:00Z',
        displayName: `E2E ${kind}`,priorColumn: kind==='bath' ? 'baths' : 'parsed',compositionComplete: true,demand },
      lines: [{ lineKey: 'member',orderId,detailId,quantity,stageCode: 'membership',evidenceKind: 'derived',rework: false },
        ...(kind!=='bath' || options.rolled ? [{ lineKey: 'proof',orderId,detailId,quantity,
          stageCode: kind==='bath' ? 'laminated' : 'cut',evidenceKind: 'physical' as const,rework: false }] : [])] });
    const receipts = [make('packet',randomUUID(),4),make('bazisCutSet',String(orderId),6),make('bath',`cut-result:${orderId}`,10)];
    const jobs = [];
    for (const r of receipts) jobs.push(await database().transaction(tx => recordMdfReceipt(tx,r)));
    return { orderId,detailId,receipts,jobs };
  }
  const positions = async (orderId: number) => (await db.query(`SELECT detail_id,required_quantity,cut_quantity,rolled_quantity,
    credited_cut,credited_rolled,remaining FROM mdf_published_positions WHERE order_id=$1 ORDER BY detail_id`,[orderId])).rows;
  const statuses = async (orderId: number) => (await db.query('SELECT production_status_id FROM order_details WHERE order_id=$1 ORDER BY detail_id',
    [orderId])).rows.map(r => r.production_status_id);
  it('executes real pinned actions, allocation, audit and publication once; unrelated detail unchanged', async () => {
    const f = await fixture();
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: f.jobs[0].jobId });
    expect(await statuses(f.orderId)).toEqual([2,1]);
    expect((await positions(f.orderId))[0]).toMatchObject({ credited_cut: '10',remaining: '0' });
    expect((await positions(f.orderId))[1]).toMatchObject({ credited_cut: '0',remaining: '1' });
    expect((await db.query('SELECT quantity,state FROM mdf_bath_allocations WHERE order_id=$1 ORDER BY quantity',[f.orderId])).rows)
      .toEqual([{ quantity: '4',state: 'reserved' },{ quantity: '6',state: 'reserved' }]);
    expect((await db.query("SELECT column_key FROM mdf_published_sources WHERE source_kind='bath' AND source_id=$1",[f.receipts[2].sourceId])).rows[0].column_key)
      .toBe('baths_ready');
    const revision = (await db.query('SELECT published_revision FROM mdf_engine_state')).rows[0].published_revision;
    await runner().processOne(); await runner().processOne();
    expect(await runner().processOne()).toEqual({ status: 'idle' });
    expect((await db.query('SELECT count(*) n FROM outbox_events WHERE aggregate_id=$1',[String(f.orderId)])).rows[0].n).toBe('1');
    expect(BigInt((await db.query('SELECT published_revision FROM mdf_engine_state')).rows[0].published_revision)).toBe(BigInt(revision)+2n);
  });
  it('failed final publication rolls back allocation, rules, audit and revision; durable receipt retries', async () => {
    const f = await fixture();
    const before = (await db.query('SELECT published_revision FROM mdf_engine_state')).rows[0].published_revision;
    await db.query(`ALTER TABLE mdf_published_positions ADD CONSTRAINT e2e_reject CHECK(order_id<>${f.orderId})`);
    try {
      expect(await runner().processOne()).toMatchObject({ status: 'retry',jobId: f.jobs[0].jobId });
      expect(await statuses(f.orderId)).toEqual([1,1]);
      expect((await db.query('SELECT 1 FROM mdf_bath_allocations WHERE order_id=$1',[f.orderId])).rows).toHaveLength(0);
      expect((await db.query('SELECT published_revision FROM mdf_engine_state')).rows[0].published_revision).toBe(before);
      expect((await db.query('SELECT attempts,error_code FROM mdf_recalculation_jobs WHERE job_id=$1',[f.jobs[0].jobId])).rows[0])
        .toEqual({ attempts: 1,error_code: 'MDF_PROCESSING_FAILED' });
    } finally { await db.query('ALTER TABLE mdf_published_positions DROP CONSTRAINT e2e_reject'); }
    await db.query("UPDATE mdf_recalculation_jobs SET next_attempt_at=now()-interval '1 hour' WHERE job_id=$1",[f.jobs[0].jobId]);
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: f.jobs[0].jobId });
    expect(await statuses(f.orderId)).toEqual([2,1]);
  });
  it('correction job publishes accounting without forwarding its pinned rules', async () => {
    const forward = await fixture();
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: forward.jobs[0].jobId });
    expect(await statuses(forward.orderId)).toEqual([2,1]); // Same pinned rule is effective on an ordinary forward job.

    const f = await fixture();
    // The initial receipt is intentionally prevented from applying its pinned
    // rule, leaving a clean status baseline for the correction publication.
    await db.query('UPDATE status_automation_rules SET version=2 WHERE id=17');
    try {
      expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: f.jobs[0].jobId });
    } finally {
      await db.query('UPDATE status_automation_rules SET version=1 WHERE id=17');
    }
    await db.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    const original = f.receipts[0];
    const independentBasis = f.receipts[1];
    const basisAllocations = (await db.query(`SELECT a.allocation_id,a.state,a.quantity FROM mdf_bath_allocations a
      JOIN mdf_evidence_lines e USING(evidence_line_id) WHERE e.source_kind=$1 AND e.source_id=$2 AND e.revision_key=$3
        AND a.state<>'released' ORDER BY a.allocation_id`,
    [independentBasis.sourceKind,independentBasis.sourceId,independentBasis.revisionKey])).rows;
    expect(basisAllocations.length).toBeGreaterThan(0);
    // The owner command has released the old reservation before submitting
    // the correction, so its guard sees no active allocation for the old proof.
    await db.query(`UPDATE mdf_bath_allocations a SET state='released' FROM mdf_evidence_lines e
      WHERE a.evidence_line_id=e.evidence_line_id AND e.source_kind=$1 AND e.source_id=$2
        AND e.revision_key=$3 AND a.state<>'released'`,
    [original.sourceKind,original.sourceId,original.revisionKey]);
    // Simulate a delayed old-epoch delivery; it must be consumed as stale before
    // the correction job is claimable.
    await db.query("UPDATE mdf_recalculation_jobs SET status='pending',finished_at=NULL,next_attempt_at=now()-interval '1 hour' WHERE job_id=$1", [f.jobs[0].jobId]);
    const correction: MdfReceiptInput = {
      ...original, revisionKey: '2', correction: true,
      expectedFence: { version: '1',correctionEpoch: '0' },
      executionContext: { ...original.executionContext!, displayName: 'E2E corrected CNC source' },
      // Preserve this source's cut proof. Together with the independent BASIS
      // source it still covers all 10; a forward job demonstrably applies rule 17.
      lines: original.lines,
    };
    const saved = await database().transaction(tx => recordMdfReceipt(tx,correction));
    expect(saved).toMatchObject({ accepted: true,version: '2',correctionEpoch: '1' });
    expect((await db.query('SELECT effect_policy FROM mdf_recalculation_jobs WHERE job_id=$1',[saved.jobId])).rows[0].effect_policy)
      .toBe('publish_only');
    expect((await db.query('SELECT correction_epoch FROM mdf_source_heads WHERE source_id=$1',[original.sourceId])).rows[0].correction_epoch)
      .toBe('1');
    expect(await runner().processOne()).toMatchObject({ status: 'superseded',jobId: f.jobs[0].jobId });
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: saved.jobId });
    expect((await db.query(`SELECT a.allocation_id,a.state,a.quantity FROM mdf_bath_allocations a
      JOIN mdf_evidence_lines e USING(evidence_line_id) WHERE e.source_kind=$1 AND e.source_id=$2 AND e.revision_key=$3
        AND a.state<>'released' ORDER BY a.allocation_id`,
    [independentBasis.sourceKind,independentBasis.sourceId,independentBasis.revisionKey])).rows).toEqual(basisAllocations);
    expect(await statuses(f.orderId)).toEqual([1,1]);
    expect((await positions(f.orderId))[0]).toMatchObject({ credited_cut: '10',remaining: '0' });
    expect((await db.query("SELECT count(*) n FROM audit_log WHERE event='status_automation.rule_applied' AND related_order_id=$1",[f.orderId])).rows[0].n)
      .toBe('0');
    expect((await db.query("SELECT count(*) n FROM audit_log WHERE event='mdf_board.forward_revision_accepted' AND entity_id=$1",[`packet:${original.sourceId}`])).rows[0].n)
      .toBe('0');
    expect((await db.query('SELECT status,effect_policy FROM mdf_recalculation_jobs WHERE job_id=$1',[saved.jobId])).rows[0])
      .toEqual({ status: 'done',effect_policy: 'publish_only' });
  });
  it('publish_only jobs with a missing historical actor do not publish a false actor warning', async () => {
    const f = await fixture();
    await db.query('UPDATE status_automation_rules SET version=2 WHERE id=17');
    try {
      expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: f.jobs[0].jobId });
    } finally {
      await db.query('UPDATE status_automation_rules SET version=1 WHERE id=17');
    }
    await db.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    const original = f.receipts[0];
    await db.query(`UPDATE mdf_bath_allocations a SET state='released' FROM mdf_evidence_lines e
      WHERE a.evidence_line_id=e.evidence_line_id AND e.source_kind=$1 AND e.source_id=$2
        AND e.revision_key=$3 AND a.state<>'released'`,
    [original.sourceKind,original.sourceId,original.revisionKey]);
    const correction = { ...original,revisionKey: '2',correction: true as const,actorUserId: 999,
      expectedFence: { version: '1',correctionEpoch: '0' } };
    const saved = await database().transaction(tx => recordMdfReceipt(tx,correction));
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: saved.jobId });
    expect((await db.query(`SELECT issues FROM mdf_published_sources WHERE source_kind='packet' AND source_id=$1`,[original.sourceId])).rows[0].issues)
      .not.toContain('MDF_ACTOR_UNAVAILABLE');
  });
  it('accepted bath lamination consumes reservations and advances only own position', async () => {
    const f = await fixture({ rolled: true });
    expect(await runner().processOne()).toMatchObject({ status: 'done' });
    expect(await statuses(f.orderId)).toEqual([3,1]);
    expect((await positions(f.orderId))[0]).toMatchObject({ cut_quantity: '0',rolled_quantity: '10',credited_rolled: '10' });
    expect((await db.query('SELECT DISTINCT state FROM mdf_bath_allocations WHERE order_id=$1',[f.orderId])).rows).toEqual([{ state: 'consumed' }]);
  });
  it('old context-free accepted fixture is quarantined rather than treated as executable proof', async () => {
    const f = await fixture({ context: false });
    expect(await runner().processOne()).toMatchObject({ status: 'done' });
    expect(await statuses(f.orderId)).toEqual([1,1]);
    expect((await positions(f.orderId))[0]).toMatchObject({ credited_cut: '0',remaining: '10' });
    expect((await db.query('SELECT issues FROM mdf_published_sources WHERE source_kind=$1 AND source_id=$2',
      ['packet',f.receipts[0].sourceId])).rows[0].issues).toContain('MDF_CONTEXT_REQUIRED');
  });
  it('changed owning demand quarantines stale evidence without moving additional quantities', async () => {
    const f = await fixture(); await db.query('UPDATE order_details SET quantity=12 WHERE detail_id=$1',[f.detailId]);
    expect(await runner().processOne()).toMatchObject({ status: 'done' });
    expect(await statuses(f.orderId)).toEqual([1,1]);
    expect((await positions(f.orderId))[0]).toMatchObject({ required_quantity: '12',credited_cut: '0',remaining: '12' });
    expect((await db.query('SELECT issues FROM mdf_published_sources WHERE source_kind=$1 AND source_id=$2',
      ['packet',f.receipts[0].sourceId])).rows[0].issues).toContain('MDF_DEMAND_CHANGED');
  });
  it('changed pinned rule is skipped but accounting/publication still run', async () => {
    const f = await fixture(); await db.query('UPDATE status_automation_rules SET version=2 WHERE id=17');
    try {
      expect(await runner().processOne()).toMatchObject({ status: 'done' });
      expect(await statuses(f.orderId)).toEqual([1,1]);
      expect((await positions(f.orderId))[0].credited_cut).toBe('10');
      expect((await db.query("SELECT metadata_json->>'reason' reason FROM audit_log WHERE event='status_automation.rule_skipped' AND related_order_id=$1",[f.orderId])).rows)
        .toContainEqual({ reason: 'pinned_rule_version_changed' });
    } finally { await db.query('UPDATE status_automation_rules SET version=1 WHERE id=17'); }
  });
  it('unaccepted newer receipt schedules quarantine publication and preserves already spent stock', async () => {
    const f = await fixture(); await runner().processOne();
    await db.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    const receipt = { ...f.receipts[0],revisionKey: '2',expectedFence: { version: '1',correctionEpoch: '0' } };
    receipt.accept=false; // no originating command authority to advance this receipt
    const saved = await database().transaction(tx => recordMdfReceipt(tx,receipt));
    expect(saved.accepted).toBe(false); // allocated old evidence cannot be silently replaced
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: saved.jobId });
    expect((await positions(f.orderId))[0].credited_cut).toBe('6');
    expect((await db.query('SELECT count(*) n FROM mdf_bath_allocations WHERE order_id=$1 AND state<>\'released\'',[f.orderId])).rows[0].n).toBe('2');
    expect((await db.query('SELECT issues FROM mdf_published_sources WHERE source_kind=$1 AND source_id=$2',
      ['packet',f.receipts[0].sourceId])).rows[0].issues).toContain('ACCEPTANCE_PENDING');
  });
  it('unaccepted received revision publishes its new membership/metadata, never labels rev1 as rev2', async () => {
    const f = await fixture(); await runner().processOne();
    await db.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    const receipt = { ...f.receipts[0],revisionKey: '2',expectedFence: { version: '1',correctionEpoch: '0' },
      executionContext: { ...f.receipts[0].executionContext!,displayName: 'E2E changed received composition' },
      lines: f.receipts[0].lines.map(l => ({ ...l,detailId: f.detailId+1,quantity: 1 })) };
    const saved = await database().transaction(tx => recordMdfReceipt(tx,receipt));
    expect(saved.accepted).toBe(false);
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: saved.jobId });
    expect((await db.query('SELECT detail_id,quantity FROM mdf_published_source_members WHERE source_kind=$1 AND source_id=$2',
      ['packet',receipt.sourceId])).rows).toEqual([{ detail_id: String(f.detailId+1),quantity: '1' }]);
    expect((await db.query('SELECT received_revision_key,display_name,column_key FROM mdf_published_sources WHERE source_kind=$1 AND source_id=$2',
      ['packet',receipt.sourceId])).rows[0]).toEqual({ received_revision_key: '2',display_name: 'E2E changed received composition',column_key: 'completed' });
    expect((await positions(f.orderId))[1].credited_cut).toBe('0');
    expect((await db.query('SELECT issues FROM mdf_published_positions WHERE detail_id=$1',[f.detailId+1])).rows[0].issues).toContain('ACCEPTANCE_PENDING');
    expect((await db.query('SELECT issues FROM mdf_published_positions WHERE detail_id=$1',[f.detailId])).rows[0].issues).toContain('MDF_ALLOCATION_UNVERIFIED');
  });
  it('normal bath ready → laminated forwards reservations without releasing actual stock', async () => {
    const f=await fixture(); await runner().processOne();
    await db.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    const bath=f.receipts[2];
    const next={ ...bath,revisionKey: '2',expectedFence: { version: '1',correctionEpoch: '0' },
      lines: [...bath.lines,{ ...bath.lines[0],lineKey: 'rolled',stageCode: 'laminated',evidenceKind: 'physical' as const }] };
    const saved=await database().transaction(tx => recordMdfReceipt(tx,next));
    expect(saved.accepted).toBe(false); // raw signal is durable before downstream acceptance
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: saved.jobId });
    expect((await db.query('SELECT state,bath_revision,SUM(quantity)::text quantity FROM mdf_bath_allocations WHERE order_id=$1 GROUP BY state,bath_revision ORDER BY bath_revision',
      [f.orderId])).rows).toEqual([{ state: 'released',bath_revision: '1',quantity: '10' },{ state: 'consumed',bath_revision: '2',quantity: '10' }]);
    expect(await statuses(f.orderId)).toEqual([3,1]);
    expect((await positions(f.orderId))[0]).toMatchObject({ credited_rolled: '10',remaining: '0' });
    expect((await db.query("SELECT count(*) n FROM audit_log WHERE event='mdf_board.bath_supply_reserved' AND related_order_id=$1",[f.orderId])).rows[0].n).toBe('1');
    expect((await db.query("SELECT count(*) n FROM audit_log WHERE event='mdf_board.forward_revision_accepted' AND entity_id=$1",[`bath:${bath.sourceId}`])).rows[0].n).toBe('1');
  });
  it('compatible supply metadata revision retains consumed balances and cannot produce a second shipment', async () => {
    const f=await fixture({ rolled: true }); await runner().processOne();
    await db.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    const next={ ...f.receipts[0],revisionKey: '2',expectedFence: { version: '1',correctionEpoch: '0' },
      executionContext: { ...f.receipts[0].executionContext!,displayName: 'renamed only' } };
    const saved=await database().transaction(tx => recordMdfReceipt(tx,next));
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: saved.jobId });
    expect((await db.query("SELECT e.revision_key,a.quantity,a.state FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id) WHERE e.source_id=$1 ORDER BY e.revision_key",
      [next.sourceId])).rows).toEqual([{ revision_key: '1',quantity: '4',state: 'released' },{ revision_key: '2',quantity: '4',state: 'consumed' }]);
    expect((await positions(f.orderId))[0]).toMatchObject({ credited_rolled: '10',remaining: '0' });
    expect((await db.query("SELECT count(*) n FROM audit_log WHERE event='mdf_board.bath_supply_consumed' AND related_order_id=$1",[f.orderId])).rows[0].n).toBe('1');
  });
  it('failed forward publication restores accepted head, original reservations and receipt retry', async () => {
    const f=await fixture(); await runner().processOne();
    await db.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    const next={ ...f.receipts[0],revisionKey: '2',expectedFence: { version: '1',correctionEpoch: '0' } };
    const saved=await database().transaction(tx => recordMdfReceipt(tx,next));
    await db.query(`ALTER TABLE mdf_published_positions ADD CONSTRAINT e2e_reject_forward CHECK(order_id<>${f.orderId}) NOT VALID`);
    try {
      expect(await runner().processOne()).toMatchObject({ status: 'retry',jobId: saved.jobId });
      expect((await db.query('SELECT accepted_revision_key,received_revision_key FROM mdf_source_heads WHERE source_id=$1',[next.sourceId])).rows[0])
        .toEqual({ accepted_revision_key: '1',received_revision_key: '2' });
      expect((await db.query('SELECT count(*) n FROM mdf_bath_allocations WHERE order_id=$1',[f.orderId])).rows[0].n).toBe('2');
      expect((await db.query("SELECT 1 FROM audit_log WHERE event='mdf_board.forward_revision_accepted' AND entity_id=$1",[`packet:${next.sourceId}`])).rows).toHaveLength(0);
    } finally { await db.query('ALTER TABLE mdf_published_positions DROP CONSTRAINT e2e_reject_forward'); }
    await db.query('UPDATE mdf_recalculation_jobs SET next_attempt_at=now() WHERE job_id=$1',[saved.jobId]);
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: saved.jobId });
  });
  it('one job cannot promote a compatible received revision belonging to another job', async () => {
    const f=await fixture(); await runner().processOne();
    await db.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    const packet=await database().transaction(tx => recordMdfReceipt(tx,{ ...f.receipts[0],revisionKey: '2',
      expectedFence: { version: '1',correctionEpoch: '0' } }));
    await db.query("UPDATE mdf_recalculation_jobs SET next_attempt_at=now()+interval '1 hour' WHERE job_id=$1",[packet.jobId]);
    const basis=await database().transaction(tx => recordMdfReceipt(tx,{ ...f.receipts[1],revisionKey: '2',
      expectedFence: { version: '1',correctionEpoch: '0' } }));
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: basis.jobId });
    expect((await db.query('SELECT accepted_revision_key FROM mdf_source_heads WHERE source_id=$1',[f.receipts[0].sourceId])).rows[0].accepted_revision_key).toBe('1');
    expect((await db.query('SELECT accepted_revision_key FROM mdf_source_heads WHERE source_kind=\'bazisCutSet\' AND source_id=$1',[f.receipts[1].sourceId])).rows[0].accepted_revision_key).toBe('2');
    expect((await positions(f.orderId))[0].credited_cut).toBe('6');
  });
  it('never jumps over an earlier unaccepted source revision even when latest composition matches', async () => {
    const f=await fixture(); await runner().processOne();
    await db.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    await database().transaction(tx => recordMdfReceipt(tx,{ ...f.receipts[0],revisionKey: '2',accept: false,
      expectedFence: { version: '1',correctionEpoch: '0' } }));
    const latest=await database().transaction(tx => recordMdfReceipt(tx,{ ...f.receipts[0],revisionKey: '3',
      expectedFence: { version: '2',correctionEpoch: '0' } }));
    expect(await runner().processOne()).toMatchObject({ status: 'superseded' });
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: latest.jobId });
    expect((await db.query('SELECT accepted_revision_key FROM mdf_source_heads WHERE source_id=$1',[f.receipts[0].sourceId])).rows[0].accepted_revision_key).toBe('1');
    expect((await positions(f.orderId))[0].credited_cut).toBe('6');
  });
  it('two workers claim separate jobs but cannot reserve the same cut twice', async () => {
    const f = await fixture(); const other = new Client(config); await other.connect();
    try {
      await other.query(`SET search_path=${schema},public`);
      const results = await Promise.all([runner().processOne(),new MdfJobRunner(database(other),executeMdfAcceptedJob).processOne()]);
      expect(results.every(r => r.status==='done')).toBe(true);
      expect(new Set(results.map(r => r.jobId)).size).toBe(2);
      expect((await db.query('SELECT SUM(quantity)::text n FROM mdf_bath_allocations WHERE order_id=$1',[f.orderId])).rows[0].n).toBe('10');
      expect((await db.query('SELECT count(*) n FROM outbox_events WHERE aggregate_id=$1',[String(f.orderId)])).rows[0].n).toBe('1');
    } finally { await other.end(); }
  });
  it('frozen order declaration provides a coverage floor, not physical stock for a bath', async () => {
    const f = await fixture();
    for (const source of f.receipts.slice(0,2)) await database().transaction(tx => recordMdfReceipt(tx,{
      ...source,revisionKey: '2',expectedFence: { version: '1',correctionEpoch: '0' },accept: false,
    }));
    await db.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    const order = { ...f.receipts[0],sourceKind: 'order' as const,sourceId: String(f.orderId),origin: 'order_cascade' as const,
      lines: f.receipts[0].lines.map(l => ({ ...l,quantity: 10,
        ...(l.stageCode==='cut' ? { stageCode: 'laminated',evidenceKind: 'declaration' as const } : {}) })) };
    const saved = await database().transaction(tx => recordMdfReceipt(tx,order));
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: saved.jobId });
    expect((await positions(f.orderId))[0]).toMatchObject({ cut_quantity: '0',rolled_quantity: '0',credited_rolled: '10',remaining: '0' });
    expect((await db.query('SELECT 1 FROM mdf_bath_allocations WHERE order_id=$1',[f.orderId])).rows).toHaveLength(0);
    expect(await statuses(f.orderId)).toEqual([1,1]);
  });
  it('reader exposes brand-new pending sources before publication; GET never runs the jobs', async () => {
    const f = await fixture();
    const before = (await db.query('SELECT published_revision FROM mdf_engine_state')).rows[0].published_revision;
    const read = await readMdfPublishedSnapshot(database(),admin,{ dateTo: '2026-09-21' });
    expect(read.pendingJobs.filter(j => j.orderIds.includes(f.orderId))).toHaveLength(3);
    expect(read.cards.some(c => c.id===f.receipts[0].sourceId)).toBe(false);
    expect(read.positions.some(p => p.orderId===f.orderId)).toBe(false);
    expect((await db.query('SELECT published_revision FROM mdf_engine_state')).rows[0].published_revision).toBe(before);
    expect((await db.query('SELECT attempts FROM mdf_recalculation_jobs WHERE job_id=$1',[f.jobs[0].jobId])).rows[0].attempts).toBe(0);
    expect(await statuses(f.orderId)).toEqual([1,1]);
  });
  it('unlinked historic card remains visible for full-scope users without quantity credit or global blockage', async () => {
    const f=await fixture();
    await db.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    const sourceId=randomUUID();
    const saved=await database().transaction(tx => recordMdfReceipt(tx,{ ...f.receipts[0],sourceId,accept: false,lines: [],
      executionContext: { sourceCreatedAt: '2026-09-01T00:00:00Z',displayName: 'Unlinked historical card',
        priorColumn: 'completed',compositionComplete: false,demand: [] } }));
    expect((await readMdfPublishedSnapshot(database(),admin,{ dateTo: '2026-09-21' })).pendingJobs.some(j => j.jobId===saved.jobId)).toBe(true);
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: saved.jobId });
    const read=await readMdfPublishedSnapshot(database(),admin,{ dateTo: '2026-09-21' });
    expect(read.cards.find(c => c.id===sourceId)).toMatchObject({ displayName: 'Unlinked historical card',column: 'completed',
      issues: expect.arrayContaining(['MEMBERSHIP_MISSING','ACCEPTANCE_PENDING']) });
    const restricted=await readMdfPublishedSnapshot(database(),{ ...admin,role: 'manager' },{ dateTo: '2026-09-21',focus: { kind: 'packet',id: sourceId } });
    expect(restricted.cards.some(c => c.id===sourceId)).toBe(false);
    expect((await db.query('SELECT 1 FROM mdf_bath_allocations WHERE order_id=$1',[f.orderId])).rows).toHaveLength(0);
  });
  it('unknown bath membership with known frozen owner blocks that owner balance, never disappears from discovery', async () => {
    const f=await fixture();
    await db.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    const sourceId=`cut-result:${100000+f.orderId}`;
    const saved=await database().transaction(tx => recordMdfReceipt(tx,{ ...f.receipts[2],sourceId,accept: false,lines: [],
      executionContext: { ...f.receipts[2].executionContext!,compositionComplete: false } }));
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: saved.jobId });
    expect((await db.query('SELECT 1 FROM mdf_bath_allocations WHERE order_id=$1',[f.orderId])).rows).toHaveLength(0);
    // Independent cut proof is verified; only uncertain bath readiness is blocked.
    expect((await positions(f.orderId))[0].credited_cut).toBe('10');
    expect((await db.query('SELECT issues FROM mdf_published_positions WHERE detail_id=$1',[f.detailId])).rows[0].issues).toContain('MDF_ALLOCATION_UNVERIFIED');
    expect((await db.query('SELECT column_key FROM mdf_published_sources WHERE source_kind=\'bath\' AND source_id=$1',[f.receipts[2].sourceId])).rows[0].column_key).toBe('baths');
    expect((await db.query('SELECT column_key,issues FROM mdf_published_sources WHERE source_kind=\'bath\' AND source_id=$1',[sourceId])).rows[0])
      .toMatchObject({ column_key: 'baths',issues: expect.arrayContaining(['MDF_COMPOSITION_UNRESOLVED','ACCEPTANCE_PENDING']) });
  });
  it('withholds a verified laminated bath on a blocked balance without deleting proof or independent cut', async () => {
    const independent=await fixture({ rolled: true });
    expect(await runner().processOne()).toMatchObject({ status: 'done' });
    const f=await fixture({ rolled: true });
    expect(await runner().processOne()).toMatchObject({ status: 'done' });
    expect((await positions(f.orderId))[0]).toMatchObject({ credited_rolled: '10',credited_cut: '0' });
    const allocations=(await db.query('SELECT * FROM mdf_bath_allocations WHERE order_id=$1 ORDER BY allocation_id',[f.orderId])).rows;
    const evidence=(await db.query('SELECT * FROM mdf_evidence_lines WHERE source_kind=\'bath\' AND source_id=$1 ORDER BY evidence_line_id',
      [f.receipts[2].sourceId])).rows;
    const effects=(await db.query('SELECT count(*) n FROM outbox_events WHERE aggregate_id=$1',[String(f.orderId)])).rows;
    await db.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    // Unknown sibling bath blocks the balance, although the original laminated
    // bath still has a sealed accepted revision and fully consumed allocations.
    const saved=await database().transaction(tx => recordMdfReceipt(tx,{ ...f.receipts[2],
      sourceId: `cut-result:${200000+f.orderId}`,accept: false,lines: [],
      executionContext: { ...f.receipts[2].executionContext!,compositionComplete: false } }));
    expect(await runner().processOne()).toMatchObject({ status: 'done',jobId: saved.jobId });
    expect((await positions(f.orderId))[0]).toMatchObject({ cut_quantity: '10',rolled_quantity: '0',
      credited_cut: '10',credited_rolled: '0',remaining: '0' });
    expect((await positions(f.orderId))[1]).toMatchObject({ credited_cut: '0',credited_rolled: '0',remaining: '1' });
    expect((await positions(independent.orderId))[0]).toMatchObject({ rolled_quantity: '10',credited_rolled: '10',remaining: '0' });
    expect((await db.query('SELECT column_key,issues FROM mdf_published_sources WHERE source_kind=\'bath\' AND source_id=$1',
      [f.receipts[2].sourceId])).rows[0]).toEqual({ column_key: 'baths_laminated',issues: ['ALLOCATION_BASELINE_UNKNOWN'] });
    expect((await db.query('SELECT * FROM mdf_bath_allocations WHERE order_id=$1 ORDER BY allocation_id',[f.orderId])).rows).toEqual(allocations);
    expect((await db.query('SELECT * FROM mdf_evidence_lines WHERE source_kind=\'bath\' AND source_id=$1 ORDER BY evidence_line_id',
      [f.receipts[2].sourceId])).rows).toEqual(evidence);
    expect((await db.query('SELECT count(*) n FROM outbox_events WHERE aggregate_id=$1',[String(f.orderId)])).rows).toEqual(effects);
    expect(await statuses(f.orderId)).toEqual([3,1]); // Uncertainty alone is not a confirmed return.
  });
  it('period/focus affect visibility only; selected order without visible files retains complete totals', async () => {
    const f = await fixture(); await runner().processOne();
    const hidden = await readMdfPublishedSnapshot(database(),admin,{ dateTo: '2026-12-21',orderIds: [f.orderId] });
    expect(hidden.cards.some(c => c.id===f.receipts[0].sourceId)).toBe(false);
    expect(hidden.positions.filter(p => p.orderId===f.orderId)).toMatchObject([
      { detailId: f.detailId,creditedCut: 10,remaining: 0 },{ detailId: f.detailId+1,remaining: 1 },
    ]);
    const focused = await readMdfPublishedSnapshot(database(),admin,{ dateTo: '2026-12-21',
      focus: { kind: 'packet',id: f.receipts[0].sourceId },orderIds: [f.orderId] });
    expect(focused.cards).toHaveLength(1);
    expect(focused.positions).toEqual(hidden.positions);
  });
  it('tracks exact jobs outside the period and after they leave pending, without treating absence as done', async () => {
    const f=await fixture();
    const query={ dateTo: '2026-12-21',jobIds: [...f.jobs.map(j => j.jobId!),randomUUID()] };
    const before=await readMdfPublishedSnapshot(database(),admin,query);
    expect(before.pendingJobs).toHaveLength(0);
    expect(before.trackedJobs.map(j => j.status)).toEqual(['pending','pending','pending']);
    await runner().processOne();
    await db.query("UPDATE mdf_recalculation_jobs SET status='superseded' WHERE job_id=$1",[f.jobs[1].jobId]);
    await db.query("UPDATE mdf_recalculation_jobs SET status='needs_attention',error_code='E2E_REVIEW' WHERE job_id=$1",[f.jobs[2].jobId]);
    // Move the source head past the completed command. Tracking must still
    // return that command, not substitute its newer pending job.
    await database().transaction(tx => recordMdfReceipt(tx,{ ...f.receipts[0],revisionKey: '2',accept: false,
      expectedFence: { version: '1',correctionEpoch: '0' } }));
    const after=await readMdfPublishedSnapshot(database(),admin,query);
    expect(after.trackedJobs).toHaveLength(3);
    expect(after.trackedJobs.find(j => j.jobId===f.jobs[0].jobId)?.status).toBe('done');
    expect(after.trackedJobs.find(j => j.jobId===f.jobs[1].jobId)?.status).toBe('superseded');
    expect(after.trackedJobs.find(j => j.jobId===f.jobs[2].jobId)).toMatchObject({ status: 'needs_attention',code: 'E2E_REVIEW' });
  });
  it('hides tracked jobs unless every frozen demand owner remains visible, even outside membership', async () => {
    const f=await fixture(),other=await fixture();
    await db.query('UPDATE orders SET manager_id=42 WHERE order_id=$1',[f.orderId]);
    const manager: CurrentUser={ ...admin,id: '42',role: 'manager',roleId: 4 };
    const receipt={ ...f.receipts[0],sourceId: randomUUID(),causeKey: randomUUID(),executionContext: {
      ...f.receipts[0].executionContext!,demand: [...f.receipts[0].executionContext!.demand,
        { orderId: other.orderId,detailId: other.detailId,quantity: 10 }],
    } };
    const mixed=await database().transaction(tx => recordMdfReceipt(tx,receipt));
    const query={ dateTo: '2026-09-22',jobIds: [f.jobs[0].jobId!,other.jobs[0].jobId!,mixed.jobId!] };
    const view=await readMdfPublishedSnapshot(database(),manager,query);
    expect(view.trackedJobs.map(j => j.jobId)).toEqual([f.jobs[0].jobId]);
    expect(view.pendingJobs.some(j => j.jobId===mixed.jobId || j.orderIds.includes(other.orderId))).toBe(false);
    expect((await readMdfPublishedSnapshot(database(),admin,query)).trackedJobs).toHaveLength(3);
    await db.query('UPDATE orders SET delete_flag=true WHERE order_id=$1',[f.orderId]);
    expect((await readMdfPublishedSnapshot(database(),manager,query)).trackedJobs).toEqual([]);
  });
  it('own scope cannot read other owners via explicit IDs or mixed-card focus', async () => {
    const f = await fixture(); await runner().processOne();
    const manager: CurrentUser = { ...admin,id: '42',role: 'manager',roleId: 4 };
    await db.query('UPDATE orders SET manager_id=42 WHERE order_id=$1',[f.orderId]);
    const allowed = await readMdfPublishedSnapshot(database(),manager,{ dateTo: '2026-09-21',orderIds: [f.orderId] });
    expect(allowed.cards).toHaveLength(3);
    const another = await fixture();
    // Simulate a published mixed card without granting ownership of its other order.
    await db.query(`INSERT INTO mdf_published_source_members(source_kind,source_id,order_id,detail_id,quantity)
      VALUES('packet',$1,$2,$3,1)`,[f.receipts[0].sourceId,another.orderId,another.detailId]);
    const restricted = await readMdfPublishedSnapshot(database(),manager,{ dateTo: '2026-09-21',
      focus: { kind: 'packet',id: f.receipts[0].sourceId },orderIds: [f.orderId,another.orderId] });
    expect(restricted.cards.some(c => c.id===f.receipts[0].sourceId)).toBe(false);
    expect(restricted.positions.every(p => p.orderId===f.orderId)).toBe(true);
    expect(restricted.pendingJobs.some(j => j.orderIds.includes(another.orderId))).toBe(false);
    expect(restricted.members.some(m => m.orderId===another.orderId)).toBe(false);
  });
  it('read-only MVCC snapshot cannot mix revisions when publication commits halfway through GET', async () => {
    const f = await fixture(); await runner().processOne();
    const other = new Client(config); await other.connect();
    try {
      await other.query(`SET search_path=${schema},public`);
      const revision = (await db.query('SELECT published_revision FROM mdf_engine_state')).rows[0].published_revision;
      let changed = false;
      const intercepted = { transaction: async <T>(fn: (tx: TransactionClient) => Promise<T>) => database().transaction(tx => fn({
        ...tx, query: async (sql,args) => {
          const result = await tx.query(sql,args);
          if (!changed && sql.includes('transaction_timestamp()')) {
            changed=true;
            await other.query('BEGIN');
            await other.query("UPDATE mdf_published_sources SET display_name='newer publication' WHERE source_kind='packet' AND source_id=$1",[f.receipts[0].sourceId]);
            await other.query('UPDATE mdf_engine_state SET published_revision=published_revision+1');
            await other.query('COMMIT');
          }
          return result;
        },
      })) };
      const snapshot = await readMdfPublishedSnapshot(intercepted,admin,{ dateTo: '2026-09-21' });
      expect(snapshot.revision).toBe(revision);
      expect(snapshot.cards.find(c => c.id===f.receipts[0].sourceId)?.displayName).toBe('E2E packet');
      expect((await readMdfPublishedSnapshot(database(),admin,{ dateTo: '2026-09-21' })).cards
        .find(c => c.id===f.receipts[0].sourceId)?.displayName).toBe('newer publication');
    } finally { await other.end(); }
  });
  it('explicit terminal placement does not manufacture cut proof; clear preserves real proof', async () => {
    const f = await fixture();
    await runner().processOne();
    await db.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    // This source contributes six real cut pieces before/after changing placement.
    const source = f.receipts[1];
    const next = { ...source, revisionKey: 'terminal', expectedFence: { version: '1', correctionEpoch: '0' },
      executionContext: { ...source.executionContext!, manualPlacementColumn: 'completed_laminated' } };
    await database().transaction(tx => recordMdfReceipt(tx, next));
    expect(await runner().processOne()).toMatchObject({ status: 'done' });
    expect((await db.query('SELECT column_key FROM mdf_published_sources WHERE source_kind=$1 AND source_id=$2',
      [source.sourceKind,source.sourceId])).rows[0].column_key).toBe('completed_laminated');
    const head = (await db.query('SELECT version,correction_epoch FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2',
      [source.sourceKind,source.sourceId])).rows[0];
    await database().transaction(tx => recordMdfReceipt(tx, { ...next, revisionKey: 'clear',
      expectedFence: { version: head.version, correctionEpoch: head.correction_epoch },
      executionContext: { ...next.executionContext, manualPlacementColumn: null } }));
    expect(await runner().processOne()).toMatchObject({ status: 'done' });
    expect((await positions(f.orderId))[0].credited_cut).toBe('10');
    expect((await db.query('SELECT column_key FROM mdf_published_sources WHERE source_kind=$1 AND source_id=$2',
      [source.sourceKind,source.sourceId])).rows[0].column_key).toBe('completed');
    // Membership-only terminal card has no physical quantity to credit.
    const uncut = { ...source, sourceId: String(100000 + f.orderId), revisionKey: '1',
      lines: source.lines.filter(l => l.stageCode === 'membership'), expectedFence: null,
      executionContext: { ...source.executionContext!, manualPlacementColumn: 'completed_laminated' } };
    await database().transaction(tx => recordMdfReceipt(tx, uncut));
    expect(await runner().processOne()).toMatchObject({ status: 'done' });
    expect((await positions(f.orderId))[0].credited_cut).toBe('10');
    expect((await db.query("SELECT 1 FROM mdf_evidence_lines WHERE source_id=$1 AND stage_code='cut'", [uncut.sourceId])).rows).toHaveLength(0);
  });
});
