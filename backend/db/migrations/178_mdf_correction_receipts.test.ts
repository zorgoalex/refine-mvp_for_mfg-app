import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';
describe.skipIf(!enabled)('MDF correction receipt migration, isolated PostgreSQL schema', () => {
  const schema = `e2e_mdf_178_${randomUUID().replaceAll('-', '')}`;
  const missingSchema = `e2e_mdf_178_empty_${randomUUID().replaceAll('-', '')}`;
  const client = new Client({
    host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
    database: process.env.PG_DB, user: process.env.PG_USER, password: process.env.PG_PASSWORD,
    connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=10000 -c lock_timeout=1000 -c max_parallel_workers_per_gather=0 -c jit=off',
  });
  const migration = readFileSync(new URL('./178_mdf_correction_receipts.sql', import.meta.url), 'utf8');
  const apply = async (file: string) => client.query(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'));

  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public`);
    expect((await client.query('SELECT current_schema() AS schema')).rows[0]).toEqual({ schema });
    expect((await client.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname='mdf_recalculation_jobs'`, [schema])).rows).toHaveLength(0);
    for (const file of ['165_mdf_engine_foundation.sql','166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql','175_mdf_command_placement.sql']) await apply(file);
    expect((await client.query(`SELECT n.nspname AS jobs_schema FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname='mdf_recalculation_jobs'`, [schema])).rows)
      .toEqual([{ jobs_schema: schema }]);
    await client.query(`INSERT INTO mdf_evidence_revisions
      (source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key)
      VALUES('packet','E2E-legacy-job','1',$1,'cnc',158,'E2E-old request','E2E-old cause')`, ['a'.repeat(64)]);
    await client.query(`INSERT INTO mdf_revision_context(source_kind,source_id,revision_key,source_created_at,display_name,prior_column,
      composition_complete,demand_digest,acceptance_requested,manual_placement_column)
      VALUES('packet','E2E-legacy-job','1','2026-09-01','E2E old context','parsed',true,$1,true,NULL)`, ['b'.repeat(64)]);
    await client.query(`INSERT INTO mdf_revision_demand(source_kind,source_id,revision_key,order_id,detail_id,quantity)
      VALUES('packet','E2E-legacy-job','1',1,11,10)`);
    await client.query(`INSERT INTO mdf_revision_seals(source_kind,source_id,revision_key) VALUES('packet','E2E-legacy-job','1')`);
    await client.query(`INSERT INTO mdf_source_heads(source_kind,source_id,received_revision_key,accepted_revision_key)
      VALUES('packet','E2E-legacy-job','1','1')`);
    await client.query(`INSERT INTO mdf_recalculation_jobs(event_key,source_kind,source_id,revision_key,correction_epoch,actor_user_id,request_id)
      VALUES('E2E-old-job','packet','E2E-legacy-job','1',0,158,'E2E-old request')`);
  });

  afterAll(async () => {
    try {
      await client.query('SET search_path=public');
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.query(`DROP SCHEMA IF EXISTS ${missingSchema} CASCADE`);
      expect((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows).toHaveLength(0);
      expect((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [missingSchema])).rows).toHaveLength(0);
    } finally { await client.end(); }
  });

  it('fails closed when migration dependencies are only visible from public', async () => {
    await client.query(`CREATE SCHEMA ${missingSchema}; SET search_path=${missingSchema},public`);
    const publicColumns = async () => (await client.query(`SELECT COALESCE(array_agg(a.attname::text ORDER BY a.attnum),ARRAY[]::text[]) columns
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      WHERE n.nspname='public' AND c.relname='mdf_recalculation_jobs'`)).rows[0].columns;
    const before = await publicColumns();
    try {
      await expect(client.query(migration)).rejects.toMatchObject({ code: 'P0001' });
    } finally {
      await client.query('ROLLBACK');
      await client.query(`SET search_path=${schema},public`);
    }
    expect(await publicColumns()).toEqual(before);
  });

  it('adds immutable forward defaults idempotently without losing old receipt jobs', async () => {
    await client.query(migration);
    await client.query(migration);
    expect((await client.query(`SELECT c.effect_policy AS context_policy,j.effect_policy AS job_policy,j.status
      FROM mdf_revision_context c JOIN mdf_recalculation_jobs j USING(source_kind,source_id,revision_key)
      WHERE source_id='E2E-legacy-job' AND revision_key='1'`)).rows)
      .toEqual([{ context_policy: 'forward',job_policy: 'forward',status: 'pending' }]);
    expect((await client.query(`SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relname='mdf_recalculation_jobs' AND c.relkind='r' AND n.nspname=$1`, [schema])).rows)
      .toEqual([{ nspname: schema }]);
  });

  it('binds job policy to sealed context and keeps both policies immutable', async () => {
    await expect(client.query(`UPDATE mdf_recalculation_jobs SET effect_policy='publish_only'
      WHERE event_key='E2E-old-job'`)).rejects.toMatchObject({ code: '55000' });
    await expect(client.query(`UPDATE mdf_revision_context SET effect_policy='publish_only'
      WHERE source_id='E2E-legacy-job'`)).rejects.toMatchObject({ code: '55000' });
    await expect(client.query(`DELETE FROM mdf_revision_context WHERE source_id='E2E-legacy-job'`))
      .rejects.toMatchObject({ code: '55000' });

    await client.query(`INSERT INTO mdf_evidence_revisions
      (source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key)
      VALUES('packet','E2E-policy-mismatch','1',$1,'cnc',158,'E2E policy request','E2E policy cause')`, ['c'.repeat(64)]);
    await client.query(`INSERT INTO mdf_revision_context(source_kind,source_id,revision_key,source_created_at,display_name,prior_column,
      composition_complete,demand_digest,acceptance_requested,manual_placement_column,effect_policy)
      VALUES('packet','E2E-policy-mismatch','1','2026-09-01','E2E policy context','parsed',true,$1,true,NULL,'forward')`, ['d'.repeat(64)]);
    await client.query(`INSERT INTO mdf_revision_demand(source_kind,source_id,revision_key,order_id,detail_id,quantity)
      VALUES('packet','E2E-policy-mismatch','1',1,12,10)`);
    await client.query(`INSERT INTO mdf_revision_seals(source_kind,source_id,revision_key) VALUES('packet','E2E-policy-mismatch','1')`);
    await expect(client.query(`INSERT INTO mdf_recalculation_jobs
      (event_key,source_kind,source_id,revision_key,correction_epoch,actor_user_id,request_id,effect_policy)
      VALUES('E2E-policy-mismatch-job','packet','E2E-policy-mismatch','1',0,158,'E2E policy request','publish_only')`))
      .rejects.toMatchObject({ code: '23514' });
    await client.query(`INSERT INTO mdf_recalculation_jobs
      (event_key,source_kind,source_id,revision_key,correction_epoch,actor_user_id,request_id,effect_policy)
      VALUES('E2E-policy-match-job','packet','E2E-policy-mismatch','1',0,158,'E2E policy request','forward')`);
  });
});
