import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl=process.env.WHATSAPP_DAILY_DIGEST_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const enabled=Boolean(databaseUrl);

// The migration is applied exactly once here, mirroring the ledger-guarded
// runner policy; raw re-application is not part of the migration contract.
describe.skipIf(!enabled)('WhatsApp daily digest schedule migration 184, isolated PostgreSQL schema',()=>{
  const schema=`e2e184_${randomUUID().replaceAll('-','')}`;
  let pool:Pool;
  let client:PoolClient;

  beforeAll(async()=>{
    pool=new Pool({connectionString:databaseUrl,max:1});
    client=await pool.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path="${schema}",public`);
    for (const file of ['183_whatsapp_daily_digest.sql','184_whatsapp_daily_digest_schedule.sql']) {
      const sql=await readFile(new URL(`./${file}`,import.meta.url),'utf8');
      await client.query(sql);
    }
  },30000);

  afterAll(async()=>{
    if (client) {
      try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { client.release(); }
    }
    await pool?.end();
  });

  it('installs the window column, named checks and the durable schedule table',async()=>{
    const probe=async()=>client.query(`SELECT
      (SELECT data_type='integer' AND is_nullable='NO' AND column_default='0' FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='whatsapp_daily_digest_settings' AND column_name='send_window_minutes') AS column_ok,
      (SELECT count(*)=3 FROM pg_constraint WHERE conrelid=to_regclass($1||'.whatsapp_daily_digest_settings') AND contype='c' AND convalidated
        AND conname IN ('chk_whatsapp_daily_digest_window_minutes_range','chk_whatsapp_daily_digest_window_same_day','chk_whatsapp_daily_digest_deadline_after_window')) AS named_checks_ok,
      EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass($1||'.whatsapp_daily_digest_settings') AND contype='c' AND convalidated
        AND pg_get_constraintdef(oid) LIKE '%catch_up_deadline >= send_time%') AS legacy_check_kept,
      EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass($1||'.whatsapp_daily_digest_schedules') AND contype='p'
        AND pg_get_constraintdef(oid) LIKE '%business_date%') AS pk_ok,
      (SELECT count(*)=8 FROM pg_constraint WHERE conrelid=to_regclass($1||'.whatsapp_daily_digest_schedules') AND contype='c' AND convalidated) AS schedule_checks_ok,
      (SELECT count(*)=2 FROM pg_constraint WHERE conrelid=to_regclass($1||'.whatsapp_daily_digest_schedules') AND contype='c' AND convalidated
        AND pg_get_constraintdef(oid) LIKE '%AT TIME ZONE%') AS timezone_checks_ok`,[schema]);
    expect((await probe()).rows[0]).toEqual({column_ok:true,named_checks_ok:true,legacy_check_kept:true,pk_ok:true,schedule_checks_ok:true,timezone_checks_ok:true});
    // The probe asserts catalog facts, never operator-mutable settings values.
    await client.query(`UPDATE whatsapp_daily_digest_settings SET send_window_minutes=45,enabled=true,group_chat_id='1234567890-1234567890@g.us' WHERE singleton_id=1`);
    expect((await probe()).rows[0]).toEqual({column_ok:true,named_checks_ok:true,legacy_check_kept:true,pk_ok:true,schedule_checks_ok:true,timezone_checks_ok:true});
  });

  it('bounds the window and keeps it inside the same day, including second-bearing TIME values',async()=>{
    await expect(client.query(`UPDATE whatsapp_daily_digest_settings SET send_window_minutes=-1 WHERE singleton_id=1`)).rejects.toMatchObject({code:'23514'});
    await expect(client.query(`UPDATE whatsapp_daily_digest_settings SET send_window_minutes=1440 WHERE singleton_id=1`)).rejects.toMatchObject({code:'23514'});
    await expect(client.query(`UPDATE whatsapp_daily_digest_settings SET send_time='23:50:00',send_window_minutes=10 WHERE singleton_id=1`)).rejects.toMatchObject({code:'23514'});
    // Second-bearing TIME arithmetic must not truncate: 08:45:59 + 30min ends at 09:15:59.
    await client.query(`UPDATE whatsapp_daily_digest_settings SET send_time='08:45:59',send_window_minutes=30,catch_up_policy='until_deadline',catch_up_deadline='10:00:00' WHERE singleton_id=1`);
    await expect(client.query(`UPDATE whatsapp_daily_digest_settings SET catch_up_deadline='09:15:00' WHERE singleton_id=1`)).rejects.toMatchObject({code:'23514'});
    await client.query(`UPDATE whatsapp_daily_digest_settings SET catch_up_deadline='09:15:59' WHERE singleton_id=1`);
    await expect(client.query(`UPDATE whatsapp_daily_digest_settings SET catch_up_deadline='09:15:58' WHERE singleton_id=1`)).rejects.toMatchObject({code:'23514'});
    // The retained legacy check still requires deadline >= send_time on its own.
    await client.query(`UPDATE whatsapp_daily_digest_settings SET send_window_minutes=0,send_time='08:45:00',catch_up_deadline='10:00:00' WHERE singleton_id=1`);
    await expect(client.query(`UPDATE whatsapp_daily_digest_settings SET catch_up_deadline='08:44:59' WHERE singleton_id=1`)).rejects.toMatchObject({code:'23514'});
    await client.query(`UPDATE whatsapp_daily_digest_settings SET send_window_minutes=30,send_time='08:45',catch_up_policy='until_deadline',catch_up_deadline='09:15' WHERE singleton_id=1`);
  });

  it('enforces a self-coherent durable schedule row',async()=>{
    const insert=(overrides:{scheduled_at?:string;window_start?:string;window_end?:string;duration?:number;deadline?:string;policy?:string;date?:string})=>{
      const date=overrides.date ?? '2026-10-10';
      return client.query(
      `INSERT INTO whatsapp_daily_digest_schedules(business_date,scheduled_at,window_start,window_end,send_window_minutes,catch_up_policy,catch_up_deadline,settings_version)
       VALUES($1::date,$2::timestamptz,$3::time,$4::time,$5,$6,$7::time,1)`,
      [date,overrides.scheduled_at ?? `${date}T08:52:00.000+05:00`,overrides.window_start ?? '08:45',
        overrides.window_end ?? '09:15',overrides.duration ?? 30,overrides.policy ?? 'until_deadline',overrides.deadline ?? '10:00']);
    };

    await insert({});
    // Duplicate business dates are impossible; insert-on-conflict keeps the winner.
    await expect(insert({scheduled_at:'2026-10-10T08:53:00.000+05:00'})).rejects.toMatchObject({code:'23505'});
    // Each negative keeps every other field valid so it isolates one check.
    await expect(insert({date:'2026-10-11',scheduled_at:'2026-10-11T08:52:30.000+05:00'})).rejects.toMatchObject({code:'23514'}); // not a whole minute
    await expect(insert({date:'2026-10-12',scheduled_at:'2026-10-12T09:15:00.000+05:00'})).rejects.toMatchObject({code:'23514'}); // chosen at exclusive window end
    await expect(insert({date:'2026-10-13',scheduled_at:'2026-10-13T08:44:00.000+05:00'})).rejects.toMatchObject({code:'23514'}); // before window start
    await expect(insert({date:'2026-10-14',scheduled_at:'2026-10-13T08:52:00.000+05:00'})).rejects.toMatchObject({code:'23514'}); // chosen minute on the wrong Almaty date
    await expect(insert({date:'2026-10-15',window_end:'09:16'})).rejects.toMatchObject({code:'23514'}); // end != start+duration
    await expect(insert({date:'2026-10-16',deadline:'09:14'})).rejects.toMatchObject({code:'23514'});   // deadline before window end
    await insert({date:'2026-10-16',deadline:'09:15'});                                                 // deadline at window end is allowed
    await insert({date:'2026-10-17',scheduled_at:'2026-10-17T08:45:00.000+05:00',window_end:'08:45',duration:0,deadline:'08:45'}); // zero window: exact send time
    await expect(insert({date:'2026-10-18',scheduled_at:'2026-10-18T08:46:00.000+05:00',window_end:'08:45',duration:0,deadline:'08:45'})).rejects.toMatchObject({code:'23514'}); // zero window must pick start exactly
    // TIME '24:00:00' is a representable midnight value and must not slip
    // through epoch equality as a window end.
    await expect(insert({date:'2026-10-19',window_start:'00:30',window_end:'24:00',duration:1410,scheduled_at:'2026-10-19T00:35:00.000+05:00',policy:'skip'})).rejects.toMatchObject({code:'23514'});
    expect((await client.query('SELECT count(*)::int n FROM whatsapp_daily_digest_schedules')).rows[0].n).toBe(3);
  });
});
