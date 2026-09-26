import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DatabaseQueryOptions, TransactionClient } from '../../../database/database.types';
import { beginTransactionHooks, discardTransactionHooks, flushTransactionHooks } from '../../../database/transaction-hooks';
import { recordMdfReceipt, recordMdfLineageReceipt, type MdfLineageReceiptInput, type MdfReceiptInput } from '../application/mdf-receipt';
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
    for (const file of ['165_mdf_engine_foundation.sql','166_mdf_engine_fences.sql','174_mdf_execution_context.sql','175_mdf_command_placement.sql','178_mdf_correction_receipts.sql', '188_mdf_order_cascade_intents.sql', '189_mdf_placement_inputs.sql', '190_mdf_bath_transitions.sql']) {
      await db.query(readFileSync(new URL(`../../../../db/migrations/${file}`,import.meta.url),'utf8'));
    }
    // Own schema only, no public business mutations or hard-coded production ids.
    for (const table of ['orders','order_details','production_statuses','order_statuses','materials','sheet_material_types',
      'users','cut_result','cnc_telegram_packets','cnc_telegram_import_candidates','cnc_telegram_import_items',
      'status_automation_rules','outbox_events','audit_log','audit_log_related_entity',
      'app_settings','bazis_order_links','bazis_cut_sets','bazis_cut_set_details',
      'order_import_entity_map','order_workshops']) {
      await db.query(`CREATE TABLE ${table} AS TABLE public.${table} WITH NO DATA`);
    }
    await db.query(`ALTER TABLE cnc_telegram_packets ADD PRIMARY KEY(packet_id);
      ALTER TABLE cnc_telegram_import_candidates ADD PRIMARY KEY(candidate_id);
      ALTER TABLE cnc_telegram_import_items ADD PRIMARY KEY(import_item_id)`);
    await db.query(readFileSync(new URL('../../../../db/migrations/179_mdf_active_return.sql',import.meta.url),'utf8'));
    await db.query(readFileSync(new URL('../../../../db/migrations/180_mdf_cnc_observations.sql',import.meta.url),'utf8'));
    await db.query(readFileSync(new URL('../../../../db/migrations/182_mdf_physical_lineage.sql',import.meta.url),'utf8'));
    await db.query(readFileSync(new URL('../../../../db/migrations/185_mdf_bazis_composition.sql',import.meta.url),'utf8'));
    const expectedLocal = ['bazis_cut_set_details','bazis_cut_sets','mdf_bazis_assignment_states','mdf_bazis_composition_intents'];
    expect((await db.query<{relname:string}>(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind='r' AND c.relname=ANY($2::text[]) ORDER BY c.relname`,[schema,expectedLocal]))
      .rows.map(r=>r.relname)).toEqual(expectedLocal);
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

  it('fails closed on a CNC-authority marker without a matching completed observer receipt', async () => {
    const f = await fixture();
    const packetId = f.receipts[0].sourceId;
    const claimId = randomUUID();
    const candidateId = randomUUID();
    const itemId = randomUUID();
    await db.query('INSERT INTO cnc_telegram_packets(packet_id,source_version) VALUES($1,1)', [packetId]);
    await db.query('INSERT INTO cnc_telegram_import_candidates(candidate_id) VALUES($1)', [candidateId]);
    await db.query('INSERT INTO cnc_telegram_import_items(import_item_id) VALUES($1)', [itemId]);
    await db.query(`INSERT INTO mdf_cnc_observation_targets
      (packet_id,import_item_id,candidate_id,source_chat_id,source_group_message_id,message_bindings,
       registered_revision_key,registered_membership_digest,accepted_revision_key,last_observation_version)
      VALUES($1,$2,$3,'-100123',101,$4::jsonb,$5,$6,$5,1)`,
    [packetId, itemId, candidateId, JSON.stringify([{ messageId: '101', role: 'svg', sha256: 'a'.repeat(64) }]),
      f.receipts[0].revisionKey, 'd'.repeat(64)]);
    await db.query(`INSERT INTO mdf_cnc_observation_receipts
      (claim_id,packet_id,claim_generation,claim_token_hash,worker_instance_id,session_generation,
       head_version,correction_epoch,raw_source_version,observation_version,report_state,report_digest,report,result)
      VALUES($1,$2,1,$3,$4,1,1,0,1,1,'completed',$5,'[]','{}')`,
    [claimId, packetId, 'b'.repeat(64), randomUUID(), 'c'.repeat(64)]);
    await db.query(`INSERT INTO mdf_cnc_observation_job_authorities(job_id,packet_id,claim_id,authority)
      VALUES($1,$2,$3,'cnc_autocut')`, [f.jobs[0].jobId, packetId, claimId]);

    const before = {
      statuses: await statuses(f.orderId),
      allocations: (await db.query('SELECT count(*)::text count FROM mdf_bath_allocations WHERE order_id=$1', [f.orderId])).rows[0].count,
      published: (await db.query('SELECT count(*)::text count FROM mdf_published_positions WHERE order_id=$1', [f.orderId])).rows[0].count,
    };
    expect(await runner().processOne()).toMatchObject({ status: 'needs_attention', jobId: f.jobs[0].jobId });
    expect((await db.query('SELECT status,error_code FROM mdf_recalculation_jobs WHERE job_id=$1', [f.jobs[0].jobId])).rows[0])
      .toEqual({ status: 'needs_attention', error_code: 'MDF_CNC_AUTHORITY_MARKER_INVALID' });
    expect({
      statuses: await statuses(f.orderId),
      allocations: (await db.query('SELECT count(*)::text count FROM mdf_bath_allocations WHERE order_id=$1', [f.orderId])).rows[0].count,
      published: (await db.query('SELECT count(*)::text count FROM mdf_published_positions WHERE order_id=$1', [f.orderId])).rows[0].count,
    }).toEqual(before);
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
  it('old forward job waits on owner lock, then fences only corrected-order effects and keeps mixed publication', async () => {
    await db.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    const orders=[++sequence,++sequence], detailIds=orders.map(id=>id*10), sourceId=randomUUID();
    for (let i=0;i<orders.length;i++) {
      await db.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,payment_status_id)
        VALUES($1,$2,'production_order',false,1,4,1)`,[orders[i],`E2E fence ${orders[i]}`]);
      await db.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,material_id)
        VALUES($1,$2,1,10,1,false,1),($3,$2,2,1,1,false,1)`,[detailIds[i],orders[i],detailIds[i]+1]);
    }
    const demand=orders.flatMap((orderId,i)=>[{orderId,detailId:detailIds[i],quantity:10},{orderId,detailId:detailIds[i]+1,quantity:1}]);
    const receipt:MdfReceiptInput={sourceKind:'packet',sourceId,revisionKey:'1',origin:'cnc',actorUserId:1,
      requestId:'E2E mixed suppression',causeKey:`E2E mixed ${sourceId}`,expectedFence:null,accept:true,
      rules:[{ruleId:17,version:1}],executionContext:{sourceCreatedAt:'2026-09-01T00:00:00Z',displayName:'E2E mixed MDF',
        priorColumn:'parsed',compositionComplete:true,demand},
      lines:orders.flatMap((orderId,i)=>[
        {lineKey:`member-${orderId}`,orderId,detailId:detailIds[i],quantity:10,stageCode:'membership',evidenceKind:'derived',rework:false},
        {lineKey:`proof-${orderId}`,orderId,detailId:detailIds[i],quantity:10,stageCode:'cut',evidenceKind:'physical',rework:false},
      ])};
    const saved=await database().transaction(tx=>recordMdfReceipt(tx,receipt));
    const worker=new Client({...config,application_name:'e2e_mdf_effect_fence_waiter'});
    await worker.connect(); await worker.query(`SET search_path=${schema},public`);
    const workerPid=(await worker.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;
    let open=false, workerPromise:Promise<unknown>|undefined;
    try {
      await db.query('BEGIN'); open=true;
      await db.query('SELECT order_id FROM orders WHERE order_id=$1 FOR UPDATE',[orders[0]]);
      workerPromise=new MdfJobRunner(database(worker),executeMdfAcceptedJob).processOne();
      let waiting=false;
      for (let attempt=0;attempt<80&&!waiting;attempt++) {
        const activity=(await db.query<{waiting:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE pid=$1 AND wait_event_type='Lock') waiting`,[workerPid])).rows[0];
        waiting=activity.waiting;
        if (!waiting) await new Promise(resolve=>setTimeout(resolve,20));
      }
      expect(waiting).toBe(true); // The worker claimed the job, then waited for this order.
      await db.query(`INSERT INTO mdf_correction_job_effect_suppressions
        (job_id,affected_order_id,correction_source_kind,correction_source_id,correction_epoch,command_key)
        VALUES($1,$2,'packet',$3,1,'E2E-return')`,[saved.jobId,orders[0],sourceId]);
      await db.query('COMMIT'); open=false;
      expect(await workerPromise).toMatchObject({status:'done',jobId:saved.jobId});
    } finally {
      if (open) await db.query('ROLLBACK');
      if (workerPromise) await workerPromise.catch(()=>undefined);
      await worker.end();
    }
    const published=(await db.query(`SELECT order_id::float8 order_id,credited_cut,issues FROM mdf_published_positions
      WHERE detail_id=ANY($1::bigint[]) ORDER BY order_id`,[detailIds])).rows;
    expect(published).toHaveLength(2);
    expect(published[0]).toMatchObject({order_id:orders[0],credited_cut:'10'});
    expect(published[0].issues).not.toContain('MDF_ACTOR_UNAVAILABLE');
    expect(published[1]).toMatchObject({order_id:orders[1],credited_cut:'10'});
    expect(published[1].issues).not.toContain('MDF_ACTOR_UNAVAILABLE');
    expect((await db.query(`SELECT count(*) n FROM mdf_published_sources
      WHERE source_kind='packet' AND source_id=$1 AND received_revision_key='1'`,[sourceId])).rows[0].n).toBe('1');
    const detailStatus=(await db.query('SELECT order_id::float8 order_id,production_status_id FROM order_details WHERE order_id=ANY($1::bigint[]) ORDER BY order_id,detail_id',[orders])).rows;
    expect(detailStatus).toEqual([{order_id:orders[0],production_status_id:1},{order_id:orders[0],production_status_id:1},
      {order_id:orders[1],production_status_id:2},{order_id:orders[1],production_status_id:1}]);
  });
  it('fully fenced missing-actor forward effects are intentionally quiet but still publish proof', async () => {
    const f=await fixture();
    await db.query('UPDATE mdf_recalculation_jobs SET actor_user_id=NULL WHERE job_id=$1',[f.jobs[0].jobId]);
    await db.query(`INSERT INTO mdf_correction_job_effect_suppressions
      (job_id,affected_order_id,correction_source_kind,correction_source_id,correction_epoch,command_key)
      VALUES($1,$2,'packet',$3,1,'E2E-return-all')`,[f.jobs[0].jobId,f.orderId,f.receipts[0].sourceId]);
    expect(await runner().processOne()).toMatchObject({status:'done',jobId:f.jobs[0].jobId});
    expect((await positions(f.orderId))[0]).toMatchObject({credited_cut:'10',remaining:'0'});
    expect((await db.query('SELECT issues FROM mdf_published_positions WHERE order_id=$1 AND detail_id=$2',[f.orderId,f.detailId])).rows[0].issues)
      .not.toContain('MDF_ACTOR_UNAVAILABLE');
    expect((await db.query(`SELECT issues FROM mdf_published_sources WHERE source_kind='packet' AND source_id=$1`,
      [f.receipts[0].sourceId])).rows[0].issues).not.toContain('MDF_ACTOR_UNAVAILABLE');
  });
  it('missing-actor warning remains only on an unfenced order in a mixed job', async () => {
    await db.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    const orders=[++sequence,++sequence],detailIds=orders.map(id=>id*10),sourceId=randomUUID();
    for (let i=0;i<orders.length;i++) {
      await db.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,payment_status_id)
        VALUES($1,$2,'production_order',false,1,4,1)`,[orders[i],`E2E actor fence ${orders[i]}`]);
      await db.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,material_id)
        VALUES($1,$2,1,10,1,false,1),($3,$2,2,1,1,false,1)`,[detailIds[i],orders[i],detailIds[i]+1]);
    }
    const demand=orders.flatMap((orderId,i)=>[{orderId,detailId:detailIds[i],quantity:10},{orderId,detailId:detailIds[i]+1,quantity:1}]);
    const receipt:MdfReceiptInput={sourceKind:'packet',sourceId,revisionKey:'1',origin:'cnc',actorUserId:null,
      requestId:'E2E actor fence',causeKey:`E2E actor ${sourceId}`,expectedFence:null,accept:true,rules:[{ruleId:17,version:1}],
      executionContext:{sourceCreatedAt:'2026-09-01T00:00:00Z',displayName:'E2E actor fence MDF',priorColumn:'parsed',
        compositionComplete:true,demand},lines:orders.flatMap((orderId,i)=>[
        {lineKey:`member-${orderId}`,orderId,detailId:detailIds[i],quantity:10,stageCode:'membership',evidenceKind:'derived',rework:false},
        {lineKey:`proof-${orderId}`,orderId,detailId:detailIds[i],quantity:10,stageCode:'cut',evidenceKind:'physical',rework:false},
      ])};
    const saved=await database().transaction(tx=>recordMdfReceipt(tx,receipt));
    await db.query(`INSERT INTO mdf_correction_job_effect_suppressions
      (job_id,affected_order_id,correction_source_kind,correction_source_id,correction_epoch,command_key)
      VALUES($1,$2,'packet',$3,1,'E2E-actor-return')`,[saved.jobId,orders[0],sourceId]);
    expect(await runner().processOne()).toMatchObject({status:'done',jobId:saved.jobId});
    const rows=(await db.query(`SELECT order_id::float8 order_id,issues FROM mdf_published_positions
      WHERE detail_id=ANY($1::bigint[]) ORDER BY order_id`,[detailIds])).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].issues).not.toContain('MDF_ACTOR_UNAVAILABLE');
    expect(rows[1].issues).toContain('MDF_ACTOR_UNAVAILABLE');
    expect((await positions(orders[0]))[0].credited_cut).toBe('10');
    expect((await positions(orders[1]))[0].credited_cut).toBe('10');
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
  it('keeps legacy v1 aggregate physical proof bounded across multiple lines', async () => {
    const f = await fixture();
    await db.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    const prior = f.receipts[0];
    const receipt = {
      ...prior, revisionKey:'2', requestId:'E2E v1 split aggregate proof', causeKey:'E2E v1 split aggregate proof',
      expectedFence:{version:'1',correctionEpoch:'0'},
      lines:[
        { ...prior.lines[0], lineKey:'member-v2', quantity:10 },
        { ...prior.lines[1], lineKey:'physical-a', quantity:6 },
        { ...prior.lines[1], lineKey:'physical-b', quantity:6 },
      ],
    };
    const saved=await database().transaction(tx=>recordMdfReceipt(tx,receipt));
    expect(saved.accepted).toBe(true);
    expect(await runner().processOne()).toMatchObject({status:'done',jobId:saved.jobId});
    const source=(await db.query(`SELECT issues FROM mdf_published_sources
      WHERE source_kind='packet' AND source_id=$1`,[prior.sourceId])).rows[0];
    expect(source.issues).toContain('MEMBERSHIP_MISMATCH');
    expect((await db.query(`SELECT count(*)::int n FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE e.source_kind='packet' AND e.source_id=$1 AND e.revision_key='2' AND a.state<>'released'`,[prior.sourceId])).rows[0].n)
      .toBe(0);
  });
  it('credits authenticated v2 BASIS carried proof beyond its reduced membership, capped by live order demand', async () => {
    const orderId=++sequence, detailId=orderId*10, sourceId=String(orderId);
    await db.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,payment_status_id)
      VALUES($1,$2,'production_order',false,1,4,1)`,[orderId,`E2E lineage BASIS ${orderId}`]);
    await db.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,delete_flag,material_id)
      VALUES($1,$2,1,10,1,false,1)`,[detailId,orderId]);
    const demand=[{orderId,detailId,quantity:10}];
    const legacy:MdfReceiptInput={sourceKind:'bazisCutSet',sourceId,revisionKey:'legacy',origin:'manual',
      actorUserId:1,requestId:`E2E lineage BASIS ${orderId} legacy`,causeKey:`E2E lineage BASIS ${orderId} legacy`,
      expectedFence:null,accept:true,rules:[],executionContext:{sourceCreatedAt:'2026-09-01T00:00:00Z',
        displayName:'E2E lineage BASIS',priorColumn:'parsed',compositionComplete:true,demand},
      lines:[{lineKey:'member-legacy',orderId,detailId,quantity:10,stageCode:'membership',evidenceKind:'derived',rework:false}]};
    const legacySaved=await database().transaction(tx=>recordMdfReceipt(tx,legacy));
    const v2Input=(revisionKey:string,memberQuantity:number,lineKey:string,
      expectedFence:MdfLineageReceiptInput['expectedFence'],predecessorEvidenceLineId:string|null):MdfLineageReceiptInput=>({
      sourceKind:'bazisCutSet',sourceId,revisionKey,origin:'manual',actorUserId:1,
      requestId:`E2E lineage BASIS ${orderId} ${revisionKey}`,causeKey:`E2E lineage BASIS ${orderId} ${revisionKey}`,
      expectedFence,accept:true,rules:[],executionContext:{sourceCreatedAt:'2026-09-01T00:00:00Z',
        displayName:'E2E lineage BASIS',priorColumn:'parsed',compositionComplete:true,demand},
      lines:[
        {lineKey:`member-${revisionKey}`,orderId,detailId,quantity:memberQuantity,stageCode:'membership',evidenceKind:'derived',rework:false},
        {lineKey,orderId,detailId,quantity:10,stageCode:'cut',evidenceKind:'physical',rework:false},
      ],
      lineage:predecessorEvidenceLineId===null
        ? {operation:'production',authority:'manual_production',actions:[{lineKey,action:'root'}],droppedPredecessorEvidenceLineIds:[]}
        : {operation:'carry',actions:[{lineKey,action:'carry',predecessorEvidenceLineId}],droppedPredecessorEvidenceLineIds:[]},
    });
    const rooted=await database().transaction(tx=>recordMdfLineageReceipt(tx,v2Input('root',10,'root-cut',
      {version:legacySaved.version,correctionEpoch:legacySaved.correctionEpoch},null)));
    const rootLineId=(await db.query<{evidence_line_id:string}>(`SELECT evidence_line_id::text FROM mdf_evidence_lines
      WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key='root' AND line_key='root-cut'`,[sourceId])).rows[0].evidence_line_id;
    const carried=await database().transaction(tx=>recordMdfLineageReceipt(tx,v2Input('carry',8,'carried-cut',
      {version:rooted.version,correctionEpoch:rooted.correctionEpoch},rootLineId)));
    expect(carried.accepted).toBe(true);
    await db.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE job_id<>$1 AND status='pending'",
      [carried.jobId]);

    const executionFailure:string[]=[];
    const diagnosticRunner=new MdfJobRunner(database(),async (tx,job,rules)=>{
      try { return await executeMdfAcceptedJob(tx,job,rules); }
      catch (error) {
        const code=typeof error==='object'&&error!==null&&'code' in error&&typeof error.code==='string'?error.code:'';
        const message=error instanceof Error?error.message:'';
        executionFailure.push(`${error instanceof Error?error.name:'non_error'}:${code}:${/^[A-Z0-9_:-]{1,120}$/.test(message)?message:'OTHER'}`);
        throw error;
      }
    });
    const execution=await diagnosticRunner.processOne();
    const persistedJob=(await db.query('SELECT status,error_code FROM mdf_recalculation_jobs WHERE job_id=$1',[carried.jobId])).rows[0];
    expect({execution,persistedJob,executionFailure}).toMatchObject({execution:{status:'done',jobId:carried.jobId},
      executionFailure:[],
      persistedJob:{status:'done',error_code:null}});
    expect((await db.query(`SELECT accepted_revision_key,received_revision_key FROM mdf_source_heads
      WHERE source_kind='bazisCutSet' AND source_id=$1`,[sourceId])).rows[0])
      .toEqual({accepted_revision_key:'carry',received_revision_key:'carry'});
    expect((await db.query(`SELECT detail_id,quantity FROM mdf_published_source_members
      WHERE source_kind='bazisCutSet' AND source_id=$1`,[sourceId])).rows)
      .toEqual([{detail_id:String(detailId),quantity:'8'}]);
    expect((await positions(orderId))[0]).toMatchObject({cut_quantity:'10',credited_cut:'10',remaining:'0'});
    const published=(await db.query(`SELECT issues FROM mdf_published_sources
      WHERE source_kind='bazisCutSet' AND source_id=$1`,[sourceId])).rows[0];
    expect(published.issues).not.toContain('MDF_ALLOCATION_UNVERIFIED');
    expect(published.issues).not.toContain('MDF_LINEAGE_INVALID');
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
  it('own scope: a mixed card is shown with only the viewer\'s orders, never the other owner\'s data or a token', async () => {
    const f = await fixture(); await runner().processOne();
    const manager: CurrentUser = { ...admin,id: '42',role: 'manager',roleId: 4 };
    await db.query('UPDATE orders SET manager_id=42 WHERE order_id=$1',[f.orderId]);
    const allowed = await readMdfPublishedSnapshot(database(),manager,{ dateTo: '2026-09-21',orderIds: [f.orderId] });
    expect(allowed.cards).toHaveLength(3);
    const another = await fixture();
    // A published mixed card: the viewer may see only its own order of the two.
    await db.query(`INSERT INTO mdf_published_source_members(source_kind,source_id,order_id,detail_id,quantity)
      VALUES('packet',$1,$2,$3,1)`,[f.receipts[0].sourceId,another.orderId,another.detailId]);
    const restricted = await readMdfPublishedSnapshot(database(),manager,{ dateTo: '2026-09-21',
      focus: { kind: 'packet',id: f.receipts[0].sourceId },orderIds: [f.orderId,another.orderId] });
    expect(restricted.cards.find(c => c.id===f.receipts[0].sourceId)).toMatchObject({
      issues: expect.arrayContaining(['MDF_PARTIAL_ACCESS']),commandToken: null });
    expect(restricted.positions.length).toBeGreaterThan(0);
    expect(restricted.positions.every(p => p.orderId===f.orderId)).toBe(true);
    expect(restricted.pendingJobs.some(j => j.orderIds.includes(another.orderId))).toBe(false);
    expect(restricted.members.some(m => m.orderId===another.orderId)).toBe(false);
    expect(restricted.members.some(m => m.id===f.receipts[0].sourceId && m.orderId===f.orderId)).toBe(true);
    // The other owner's viewer sees the same card with only its own order.
    await db.query('UPDATE orders SET manager_id=43 WHERE order_id=$1',[another.orderId]);
    const other: CurrentUser = { ...admin,id: '43',role: 'manager',roleId: 4 };
    const otherView = await readMdfPublishedSnapshot(database(),other,{ dateTo: '2026-09-21',
      focus: { kind: 'packet',id: f.receipts[0].sourceId } });
    expect(otherView.cards.find(c => c.id===f.receipts[0].sourceId)).toMatchObject({ commandToken: null,
      issues: expect.arrayContaining(['MDF_PARTIAL_ACCESS']) });
    expect(otherView.members.every(m => m.orderId===another.orderId)).toBe(true);
    expect(otherView.positions.every(p => p.orderId===another.orderId)).toBe(true);
    // A caller cannot widen visibility with explicit order IDs of a denied order.
    const probe = await readMdfPublishedSnapshot(database(),other,{ dateTo: '2026-09-21',orderIds: [f.orderId] });
    expect(probe.positions.some(p => p.orderId===f.orderId)).toBe(false);
    // A deleted owner is never allowed: no token even for full scope, card stays visible.
    await db.query('UPDATE orders SET delete_flag=true WHERE order_id=$1',[another.orderId]);
    const full = await readMdfPublishedSnapshot(database(),admin,{ dateTo: '2026-09-21',focus: { kind: 'packet',id: f.receipts[0].sourceId } });
    expect(full.cards.find(c => c.id===f.receipts[0].sourceId)?.commandToken).toBeNull();
  });
  it('assigned scope: workshop-assigned worker sees a mixed card only with its assigned order', async () => {
    const f = await fixture(); await runner().processOne();
    const another = await fixture();
    await db.query(`INSERT INTO mdf_published_source_members(source_kind,source_id,order_id,detail_id,quantity)
      VALUES('packet',$1,$2,$3,1)`,[f.receipts[0].sourceId,another.orderId,another.detailId]);
    await db.query(`INSERT INTO users(user_id,username,is_active,employee_id) VALUES(77,'E2E-Тест worker',true,9077)
      ON CONFLICT DO NOTHING`);
    const worker: CurrentUser = { ...admin,id: '77',role: 'worker',roleId: 20 };
    const focus = { dateTo: '2026-09-21',focus: { kind: 'packet' as const,id: f.receipts[0].sourceId } };
    expect((await readMdfPublishedSnapshot(database(),worker,focus)).cards.some(c => c.id===f.receipts[0].sourceId)).toBe(false);
    await db.query(`INSERT INTO order_workshops(order_workshop_id,order_id,responsible_employee_id,delete_flag)
      VALUES(900077,$1,9077,false)`,[f.orderId]);
    try {
      const view = await readMdfPublishedSnapshot(database(),worker,focus);
      expect(view.cards.find(c => c.id===f.receipts[0].sourceId)).toMatchObject({ commandToken: null,
        issues: expect.arrayContaining(['MDF_PARTIAL_ACCESS']) });
      expect(view.members.every(m => m.orderId===f.orderId)).toBe(true);
      expect(view.positions.length).toBeGreaterThan(0);
      expect(view.positions.every(p => p.orderId===f.orderId)).toBe(true);
      // A deleted assignment revokes access again.
      await db.query('UPDATE order_workshops SET delete_flag=true WHERE order_workshop_id=900077');
      expect((await readMdfPublishedSnapshot(database(),worker,focus)).cards.some(c => c.id===f.receipts[0].sourceId)).toBe(false);
    } finally {
      await db.query('DELETE FROM order_workshops WHERE order_workshop_id=900077');
      await db.query('DELETE FROM users WHERE user_id=77');
    }
  });
  it('retained demand owner outside membership authorizes visibility and selects its positions, token needs all owners', async () => {
    const f=await fixture(),other=await fixture();
    await db.query("UPDATE mdf_recalculation_jobs SET status='superseded',finished_at=now() WHERE status='pending'");
    const sourceId=randomUUID();
    const receipt={ ...f.receipts[0],sourceId,causeKey: randomUUID(),executionContext: {
      ...f.receipts[0].executionContext!,demand: [...f.receipts[0].executionContext!.demand,
        { orderId: other.orderId,detailId: other.detailId,quantity: 10 }] } };
    const saved=await database().transaction(tx => recordMdfReceipt(tx,receipt));
    expect(await runner().processOne()).toMatchObject({ jobId: saved.jobId });
    const members=(await db.query('SELECT order_id::float8 o FROM mdf_published_source_members WHERE source_id=$1',[sourceId])).rows.map(r => r.o);
    expect(members).not.toContain(other.orderId); // owner only through the frozen revision demand
    await db.query('UPDATE orders SET manager_id=43 WHERE order_id=$1',[other.orderId]);
    const onlyOther: CurrentUser={ ...admin,id: '43',role: 'manager',roleId: 4 };
    const view=await readMdfPublishedSnapshot(database(),onlyOther,{ dateTo: '2026-09-22' });
    expect(view.cards.find(c => c.id===sourceId)).toMatchObject({ commandToken: null,
      issues: expect.arrayContaining(['MDF_PARTIAL_ACCESS']) });
    expect(view.members.some(m => m.id===sourceId)).toBe(false);
    expect(view.positions.some(p => p.orderId===other.orderId)).toBe(true);
    expect(view.positions.some(p => p.orderId===f.orderId)).toBe(false);
    const adminView=await readMdfPublishedSnapshot(database(),admin,{ dateTo: '2026-09-22' });
    expect(adminView.cards.find(c => c.id===sourceId)?.issues).not.toContain('MDF_PARTIAL_ACCESS');
    // Without any allowed owner the card stays hidden.
    const stranger: CurrentUser={ ...admin,id: '44',role: 'manager',roleId: 4 };
    expect((await readMdfPublishedSnapshot(database(),stranger,{ dateTo: '2026-09-22',
      focus: { kind: 'packet',id: sourceId } })).cards.some(c => c.id===sourceId)).toBe(false);
  });
  it('visibility is decided before the page limit: 1001 newer denied cards cannot hide an authorized one', async () => {
    const f = await fixture(); await runner().processOne();
    const denied = await fixture();
    await db.query('UPDATE orders SET manager_id=42 WHERE order_id=$1',[f.orderId]);
    const manager: CurrentUser = { ...admin,id: '42',role: 'manager',roleId: 4 };
    // Synthetic publication rows only (test schema): bypass lineage guards/FKs for bulk setup.
    await db.query('SET session_replication_role=replica');
    try {
      await db.query(`INSERT INTO mdf_source_heads(source_kind,source_id,received_revision_key,accepted_revision_key,correction_epoch,version,updated_at)
        SELECT 'packet','E2E-denied-'||g,'1','1',0,1,now() FROM generate_series(1,1001) g`);
      await db.query(`INSERT INTO mdf_published_sources(source_kind,source_id,received_revision_key,accepted_revision_key,
          source_created_at,display_name,column_key,reason,issues,published_revision)
        SELECT 'packet','E2E-denied-'||g,'1','1','2026-09-21T12:00:00Z'::timestamptz,'E2E-Тест denied '||g,'parsed',
          'awaiting_cut','{}'::text[],(SELECT published_revision FROM mdf_engine_state) FROM generate_series(1,1001) g`);
      await db.query(`INSERT INTO mdf_published_source_members(source_kind,source_id,order_id,detail_id,quantity)
        SELECT 'packet','E2E-denied-'||g,$1,$2,1 FROM generate_series(1,1001) g`,[denied.orderId,denied.detailId]);
    } finally { await db.query('SET session_replication_role=origin'); }
    try {
    const view = await readMdfPublishedSnapshot(database(),manager,{ dateTo: '2026-09-21' });
    expect(view.cards.some(c => c.id===f.receipts[0].sourceId)).toBe(true);
    expect(view.cards.some(c => c.id.startsWith('E2E-denied-'))).toBe(false);
    const focused = await readMdfPublishedSnapshot(database(),manager,{ dateTo: '2026-09-21',
      focus: { kind: 'packet',id: f.receipts[0].sourceId } });
    expect(focused.cards.some(c => c.id===f.receipts[0].sourceId)).toBe(true);
    // Full scope really has >1000 visible cards: existing overflow guard still applies.
    await expect(readMdfPublishedSnapshot(database(),admin,{ dateTo: '2026-09-21' }))
      .rejects.toMatchObject({ code: 'MDF_PUBLICATION_SCOPE_LIMIT' });
    } finally {
      // Remove own synthetic rows: later tests share this schema.
      await db.query('SET session_replication_role=replica');
      try {
        for (const table of ['mdf_published_source_members','mdf_published_sources','mdf_source_heads'])
          await db.query(`DELETE FROM ${table} WHERE source_kind='packet' AND source_id LIKE 'E2E-denied-%'`);
      } finally { await db.query('SET session_replication_role=origin'); }
      expect((await db.query("SELECT count(*)::int n FROM mdf_source_heads WHERE source_id LIKE 'E2E-denied-%'")).rows[0].n).toBe(0);
    }
  });
  it('read-only MVCC snapshot cannot mix revisions when publication commits halfway through GET', async () => {
    const f = await fixture(); await runner().processOne();
    const other = new Client(config); await other.connect();
    try {
      await other.query(`SET search_path=${schema},public`);
      const revision = (await db.query('SELECT published_revision FROM mdf_engine_state')).rows[0].published_revision;
      let changed = false;
      const intercepted = { transaction: async <T>(fn: (tx: TransactionClient) => Promise<T>) => database().transaction(tx => fn({
        ...tx, query: async <R extends QueryResultRow = QueryResultRow>(sql: string,args?: readonly unknown[],
            options?: DatabaseQueryOptions) => {
          const result = await tx.query<R>(sql,args,options);
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
