import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMdfCorrectionPgFixture } from './mdf-correction-test-fixture.integration';

const enabled=process.env.MDF_ENGINE_INTEGRATION==='1';

describe.skipIf(!enabled)('MDF lineage seal serializes with late evidence insertion', () => {
  const fixture=createMdfCorrectionPgFixture('e2e_mdf_lineage_race');
  const connectionOptions={
    host:process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
    database:process.env.PG_DB,user:process.env.PG_USER,password:process.env.PG_PASSWORD,
    connectionTimeoutMillis:5000,
    options:`-c search_path=${fixture.schema},public -c statement_timeout=12000 -c lock_timeout=8000 -c max_parallel_workers_per_gather=0 -c jit=off`,
  };
  let writer:Client|undefined;
  let sealer:Client|undefined;

  beforeAll(async()=>{
    await fixture.connect();
    await fixture.applyMigrations([
      '165_mdf_engine_foundation.sql','166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql','175_mdf_command_placement.sql',
      '178_mdf_correction_receipts.sql','182_mdf_physical_lineage.sql',
    ]);
    await fixture.assertLocalRelations([
      'mdf_evidence_revisions','mdf_revision_context','mdf_revision_demand','mdf_revision_seals',
      'mdf_evidence_lines','mdf_physical_lineage_contracts','mdf_physical_lineage_transitions',
    ]);
    writer=new Client({...connectionOptions,application_name:`${fixture.schema}_late_writer`});
    sealer=new Client({...connectionOptions,application_name:`${fixture.schema}_lineage_sealer`});
    await Promise.all([writer.connect(),sealer.connect()]);
  },30000);

  afterAll(async()=>{
    await Promise.all([writer?.end(),sealer?.end()]);
    await fixture.drop();
  });

  it('waits for the revision writer, then rejects a seal missing its committed physical transition',async()=>{
    if(!writer || !sealer) throw new Error('MDF_TEST_CLIENTS_NOT_READY');
    const sourceId=`seal-race-${randomUUID()}`;
    const revisionKey='race-r1';
    const sourceKind='bazisCutSet';
    const insertLines=async(client:Client,lines:readonly {lineKey:string;detailId:number;quantity:number;stageCode:string;evidenceKind:string}[])=>{
      for(const line of lines) await client.query(`INSERT INTO mdf_evidence_lines
        (source_kind,source_id,revision_key,line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,false)`,
      [sourceKind,sourceId,revisionKey,line.lineKey,line.detailId,line.quantity,line.stageCode,line.evidenceKind]);
    };

    await fixture.client.query(`INSERT INTO mdf_evidence_revisions
      (source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key)
      VALUES($1,$2,$3,$4,'manual',158,$5,$6)`,
    [sourceKind,sourceId,revisionKey,'a'.repeat(64),`race-${sourceId}`,`race-${sourceId}`]);
    await fixture.client.query(`INSERT INTO mdf_revision_context
      (source_kind,source_id,revision_key,source_created_at,display_name,prior_column,composition_complete,
        demand_digest,acceptance_requested,predecessor_accepted_revision_key,predecessor_received_revision_key)
      VALUES($1,$2,$3,'2026-09-23T00:00:00Z','lineage seal race','parsed',true,$4,true,NULL,NULL)`,
    [sourceKind,sourceId,revisionKey,'b'.repeat(64)]);
    await fixture.client.query(`INSERT INTO mdf_revision_demand
      (source_kind,source_id,revision_key,order_id,detail_id,quantity) VALUES($1,$2,$3,1,901,4)`,
    [sourceKind,sourceId,revisionKey]);
    await insertLines(fixture.client,[
      {lineKey:'membership-901',detailId:901,quantity:4,stageCode:'membership',evidenceKind:'derived'},
      {lineKey:'cut-901',detailId:901,quantity:3,stageCode:'cut',evidenceKind:'physical'},
    ]);
    const rootId=(await fixture.client.query<{evidence_line_id:string}>(`
      SELECT evidence_line_id::text FROM mdf_evidence_lines
      WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3 AND line_key='cut-901'`,
    [sourceKind,sourceId,revisionKey])).rows[0]?.evidence_line_id;
    expect(rootId).toBeTruthy();
    await fixture.client.query(`INSERT INTO mdf_physical_lineage_contracts
      (source_kind,source_id,revision_key,operation,production_authority,predecessor_accepted_revision_key,manifest_digest)
      VALUES($1,$2,$3,'production','manual_production',NULL,$4)`,
    [sourceKind,sourceId,revisionKey,'c'.repeat(64)]);
    await fixture.client.query(`INSERT INTO mdf_physical_lineage_transitions
      (source_kind,source_id,revision_key,evidence_line_id,action,canonical_origin_evidence_line_id)
      VALUES($1,$2,$3,$4,'root',$4)`,[sourceKind,sourceId,revisionKey,rootId]);

    const writerPid=(await writer.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const sealerPid=(await sealer.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let settled=false;
    let sealAttempt:Promise<{ok:true}|{ok:false;error:unknown}>|undefined;
    let observed=false;
    try{
      await writer.query('BEGIN');
      // The historical line-insert guard acquires and holds the revision row lock.
      // This second physical line deliberately has no lineage transition yet.
      await insertLines(writer,[{lineKey:'late-cut-902',detailId:901,quantity:1,stageCode:'cut',evidenceKind:'physical'}]);
      await sealer.query('BEGIN');
      sealAttempt=sealer.query(`INSERT INTO mdf_revision_seals(source_kind,source_id,revision_key)
        VALUES($1,$2,$3)`,[sourceKind,sourceId,revisionKey]).then(
        ()=>({ok:true as const}),error=>({ok:false as const,error})).finally(()=>{settled=true;});

      const deadline=Date.now()+6000;
      while(Date.now()<deadline&&!settled){
        const wait=(await fixture.client.query<{blocked:boolean}>(`SELECT
            wait_event_type='Lock' AND $2::integer=ANY(pg_blocking_pids(pid)) AS blocked
          FROM pg_stat_activity WHERE pid=$1`,[sealerPid,writerPid])).rows[0];
        if(wait?.blocked){observed=true;break;}
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      expect(observed,'seal must be visibly blocked by the exact revision-writer backend').toBe(true);
      await writer.query('COMMIT');
      const outcome=await sealAttempt!;
      expect(outcome.ok).toBe(false);
      if(outcome.ok) throw new Error('MDF_TEST_EXPECTED_INVALID_LINEAGE_SEAL');
      expect(outcome.error).toMatchObject({code:'23514'});
      expect((outcome.error as Error).message).toContain('MDF physical lineage must cover physical lines only');
    }finally{
      await writer.query('ROLLBACK').catch(()=>undefined);
      await sealer.query('ROLLBACK').catch(()=>undefined);
      if(sealAttempt&&!settled) await sealAttempt;
    }

    expect((await fixture.client.query(`SELECT 1 FROM mdf_revision_seals
      WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3`,[sourceKind,sourceId,revisionKey])).rows).toHaveLength(0);
    expect((await fixture.client.query(`SELECT 1 FROM mdf_evidence_lines
      WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3 AND line_key='late-cut-902'`,
    [sourceKind,sourceId,revisionKey])).rows).toHaveLength(1);
  },20000);
});
