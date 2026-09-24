import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl=process.env.WHATSAPP_DAILY_DIGEST_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const enabled=Boolean(databaseUrl);

describe.skipIf(!enabled)('WhatsApp daily digest migration 183, isolated PostgreSQL schema',()=>{
  const schema=`e2e183_${randomUUID().replaceAll('-','')}`;
  let pool:Pool;
  let client:PoolClient;

  beforeAll(async()=>{
    pool=new Pool({connectionString:databaseUrl,max:1});
    client=await pool.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path="${schema}",public`);
    const sql=await readFile(new URL('./183_whatsapp_daily_digest.sql',import.meta.url),'utf8');
    await client.query(sql);
  },30000);

  afterAll(async()=>{
    if (client) {
      try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { client.release(); }
    }
    await pool?.end();
  });

  it('installs private metadata tables and conservative defaults without image payload columns',async()=>{
    const settings=(await client.query(`SELECT version,enabled,send_time,cards_per_message,time_zone,catch_up_policy,catch_up_deadline,partial_policy FROM whatsapp_daily_digest_settings WHERE singleton_id=1`)).rows[0];
    expect(settings).toMatchObject({version:1,enabled:false,send_time:'08:45:00',cards_per_message:2,time_zone:'Asia/Almaty',catch_up_policy:'until_deadline',catch_up_deadline:'10:00:00',partial_policy:'remaining'});
    await client.query(`UPDATE whatsapp_daily_digest_settings SET cards_per_message=1 WHERE singleton_id=1`);
    await expect(client.query(`UPDATE whatsapp_daily_digest_settings SET cards_per_message=3 WHERE singleton_id=1`)).rejects.toMatchObject({code:'23514'});
    expect((await client.query(`SELECT cards_per_message FROM whatsapp_daily_digest_settings WHERE singleton_id=1`)).rows[0].cards_per_message).toBe(1);
    const imageColumns=(await client.query(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name IN ('whatsapp_daily_digest_runs','whatsapp_daily_digest_pages') AND column_name ~* '(image|png|base64|bytes)' ORDER BY table_name,column_name`,[schema])).rows;
    expect(imageColumns.map(row=>row.column_name)).not.toContain('image_bytes');
    expect(imageColumns.map(row=>row.column_name)).not.toContain('base64');
  });

  it('keeps the migration effect probe valid after an operator changes cardsPerMessage',async()=>{
    const probe=async()=>client.query(`SELECT
      (SELECT count(*)=1 FROM whatsapp_daily_digest_settings WHERE singleton_id=1) AS singleton_ok,
      (SELECT count(*)=8 FROM information_schema.columns WHERE table_schema=$1 AND table_name='whatsapp_daily_digest_settings' AND is_nullable='NO' AND ((column_name='version' AND column_default='1') OR (column_name='enabled' AND column_default='false') OR (column_name='send_time' AND column_default LIKE '%08:45%') OR (column_name='time_zone' AND column_default LIKE '%Asia/Almaty%') OR (column_name='catch_up_policy' AND column_default LIKE '%until_deadline%') OR (column_name='catch_up_deadline' AND column_default LIKE '%10:00%') OR (column_name='partial_policy' AND column_default LIKE '%remaining%') OR (column_name='cards_per_message' AND column_default='2'))) AS defaults_ok,
      EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass($1||'.whatsapp_daily_digest_settings') AND conname='chk_whatsapp_daily_digest_cards_per_message' AND contype='c' AND convalidated AND pg_get_constraintdef(oid) LIKE '%cards_per_message%' AND pg_get_constraintdef(oid) LIKE '%ARRAY[1, 2]%') AS check_ok,
      EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass($1||'.whatsapp_daily_digest_pages') AND conname='chk_whatsapp_daily_digest_page_index' AND contype='c' AND convalidated AND pg_get_constraintdef(oid) LIKE '%page_index%' AND pg_get_constraintdef(oid) LIKE '%500%') AS page_limit_ok`,[schema]);
    expect((await probe()).rows[0]).toEqual({singleton_ok:true,defaults_ok:true,check_ok:true,page_limit_ok:true});
    await client.query(`UPDATE whatsapp_daily_digest_settings SET cards_per_message=1 WHERE singleton_id=1`);
    expect((await probe()).rows[0]).toEqual({singleton_ok:true,defaults_ok:true,check_ok:true,page_limit_ok:true});
  });

  it('enforces one automatic date while allowing retry children to reference the original private file',async()=>{
    const runId=randomUUID(), retryId=randomUUID(), date='2026-09-23', key=randomUUID();
    const fileKey=`${randomUUID()}-1.png`, hash='a'.repeat(64);
    const expiresAt=new Date(Date.now()+60_000);
    await client.query(`INSERT INTO whatsapp_daily_digest_runs(run_id,business_date,kind,idempotency_key,request_digest,settings_version,destination_chat_id,
      catch_up_policy,deadline_at,partial_policy,renderer_version,order_count,total_area,state,image_expires_at)
      VALUES($1,$2,'auto',$3,$4,1,'1234567890-1234567890@g.us','until_deadline',$5,'remaining','test',2,1.25,'queued',$5)`,
      [runId,date,key,hash,expiresAt]);
    await expect(client.query(`INSERT INTO whatsapp_daily_digest_runs(run_id,business_date,kind,idempotency_key,request_digest,settings_version,destination_chat_id,
      catch_up_policy,deadline_at,partial_policy,renderer_version,order_count,total_area,state,image_expires_at)
      VALUES($1,$2,'auto',$3,$4,1,'1234567890-1234567890@g.us','until_deadline',$5,'remaining','test',2,1.25,'queued',$5)`,
      [randomUUID(),date,randomUUID(),hash,expiresAt])).rejects.toMatchObject({code:'23505'});
    await client.query(`INSERT INTO whatsapp_daily_digest_pages(run_id,page_index,order_ids,file_key,sha256,size_bytes,expires_at,state)
      VALUES($1,1,'[11,12]'::jsonb,$2,$3,128,$4,'unknown')`,[runId,fileKey,hash,expiresAt]);
    await client.query(`INSERT INTO whatsapp_daily_digest_runs(run_id,business_date,kind,parent_run_id,auto_origin,idempotency_key,request_digest,settings_version,destination_chat_id,
      catch_up_policy,deadline_at,partial_policy,renderer_version,order_count,total_area,state,image_expires_at)
      VALUES($1,$2,'retry',$3,true,$4,$5,1,'1234567890-1234567890@g.us','until_deadline',$6,'remaining','test',2,1.25,'queued',$6)`,
      [retryId,date,runId,randomUUID(),'b'.repeat(64),expiresAt]);
    await client.query(`INSERT INTO whatsapp_daily_digest_pages(run_id,page_index,order_ids,file_key,sha256,size_bytes,expires_at,state)
      VALUES($1,1,'[11,12]'::jsonb,$2,$3,128,$4,'pending')`,[retryId,fileKey,hash,expiresAt]);
    expect((await client.query('SELECT count(DISTINCT file_key)::int files,count(*)::int refs FROM whatsapp_daily_digest_pages')).rows[0]).toEqual({files:1,refs:2});
    await expect(client.query(`UPDATE whatsapp_daily_digest_runs SET destination_chat_id='77001234567@c.us' WHERE run_id=$1`,[runId]))
      .rejects.toMatchObject({code:'23514'});
  });
});
