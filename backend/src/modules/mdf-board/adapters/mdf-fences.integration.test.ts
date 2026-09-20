import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe.skipIf(process.env.MDF_ENGINE_INTEGRATION !== '1')('MDF runtime fences PostgreSQL', () => {
  const schema = `e2e_mdf_fences_${randomUUID().replaceAll('-', '')}`;
  const client = new Client({
    host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
    database: process.env.PG_DB, user: process.env.PG_USER, password: process.env.PG_PASSWORD,
    connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=10000 -c lock_timeout=1000 -c max_parallel_workers_per_gather=0 -c jit=off',
  });
  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public`);
    for (const file of ['165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql']) {
      await client.query(readFileSync(new URL(`../../../../db/migrations/${file}`, import.meta.url), 'utf8'));
    }
    await client.query(`INSERT INTO mdf_evidence_revisions
      (source_kind,source_id,revision_key,payload_digest,origin,request_id,cause_key)
      SELECT 'packet','E2E-fence',r,repeat('a',64),'cnc','E2E-request','E2E-cause' FROM unnest(ARRAY['1','2']) r`);
    await client.query(`INSERT INTO mdf_revision_seals(source_kind,source_id,revision_key)
      SELECT source_kind,source_id,revision_key FROM mdf_evidence_revisions`);
    await client.query(`INSERT INTO mdf_source_heads(source_kind,source_id,received_revision_key,accepted_revision_key,version,correction_epoch)
      VALUES('packet','E2E-fence','1','1',10,2)`);
    await client.query('UPDATE mdf_engine_state SET published_revision=10');
  });
  afterAll(async () => {
    try {
      await client.query(`SET search_path=public; DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      expect((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows).toHaveLength(0);
    } finally { await client.end(); }
  });
  it.each([
    'DELETE FROM mdf_source_heads',
    "UPDATE mdf_source_heads SET source_id='E2E-other'",
    'UPDATE mdf_source_heads SET version=9',
    'UPDATE mdf_source_heads SET correction_epoch=1,version=11',
    "UPDATE mdf_source_heads SET received_revision_key='2'",
    "UPDATE mdf_source_heads SET accepted_revision_key='2'",
    'UPDATE mdf_source_heads SET correction_epoch=3',
    'DELETE FROM mdf_engine_state',
    'UPDATE mdf_engine_state SET published_revision=9',
  ])('rejects stale/destructive state: %s', async sql => {
    await expect(client.query(sql)).rejects.toMatchObject({ code: '55000' });
  });
  it('permits a forward revision and explicit correction fence bump', async () => {
    await client.query(`UPDATE mdf_source_heads SET received_revision_key='2',accepted_revision_key='2',
      correction_epoch=3,version=11`);
    expect((await client.query('SELECT version,correction_epoch,accepted_revision_key FROM mdf_source_heads')).rows)
      .toEqual([{ version: '11', correction_epoch: '3', accepted_revision_key: '2' }]);
  });
  it('permits no-op/head timestamp refresh and forward published revision', async () => {
    await client.query('UPDATE mdf_source_heads SET updated_at=now()');
    await client.query('UPDATE mdf_engine_state SET published_revision=11');
    expect((await client.query('SELECT published_revision FROM mdf_engine_state')).rows)
      .toEqual([{ published_revision: '11' }]);
  });
  it('migration is repeatable without resetting fences', async () => {
    await client.query(readFileSync(new URL('../../../../db/migrations/166_mdf_engine_fences.sql', import.meta.url), 'utf8'));
    expect((await client.query('SELECT version,correction_epoch FROM mdf_source_heads')).rows)
      .toEqual([{ version: '11', correction_epoch: '3' }]);
  });
});
