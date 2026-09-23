import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMdfCorrectionPgFixture } from '../../src/modules/mdf-board/adapters/mdf-correction-test-fixture.integration';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';

describe.skipIf(!enabled)('MDF active-return migration 179, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e179mig');
  const packetId = randomUUID();
  const migration = readFileSync(new URL('./179_mdf_active_return.sql', import.meta.url), 'utf8');

  beforeAll(async () => {
    await fixture.connect();
    await fixture.clonePublicTables(['cnc_telegram_packets']);
    await fixture.client.query(`ALTER TABLE ${fixture.schema}.cnc_telegram_packets
      ADD PRIMARY KEY(packet_id)`);
    await fixture.applyMigrations(['165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql', '179_mdf_active_return.sql']);
  }, 30000);

  afterAll(async () => fixture.drop());

  it('fails closed when migration dependencies are visible only through public', async () => {
    const missingSchema = `e2e179m_${randomUUID().replaceAll('-', '')}`;
    await fixture.client.query(`CREATE SCHEMA "${missingSchema}"; SET search_path="${missingSchema}",public`);
    const before = await fixture.client.query(`SELECT n.nspname,c.relname,array_agg(a.attname ORDER BY a.attnum)
      AS columns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      WHERE n.nspname='public' AND c.relname IN ('mdf_correction_command_results',
        'mdf_correction_job_effect_suppressions','mdf_cnc_return_fences')
      GROUP BY n.nspname,c.relname ORDER BY c.relname`);
    try {
      await expect(fixture.client.query(
        migration,
      )).rejects.toMatchObject({ code: 'P0001' });
    } finally {
      await fixture.client.query('ROLLBACK');
      await fixture.client.query(`SET search_path="${fixture.schema}",public; DROP SCHEMA "${missingSchema}" CASCADE`);
    }
    const after = await fixture.client.query(`SELECT n.nspname,c.relname,array_agg(a.attname ORDER BY a.attnum)
      AS columns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      WHERE n.nspname='public' AND c.relname IN ('mdf_correction_command_results',
        'mdf_correction_job_effect_suppressions','mdf_cnc_return_fences')
      GROUP BY n.nspname,c.relname ORDER BY c.relname`);
    expect(after.rows).toEqual(before.rows);
    expect((await fixture.client.query('SELECT current_schema() AS schema')).rows[0].schema).toBe(fixture.schema);
  });

  it('creates local durable command, suppression, and CNC barrier tables idempotently', async () => {
    await fixture.assertLocalRelations(['mdf_source_heads', 'mdf_recalculation_jobs', 'cnc_telegram_packets',
      'mdf_correction_command_results', 'mdf_correction_job_effect_suppressions', 'mdf_cnc_return_fences']);
    await fixture.applyMigrations(['179_mdf_active_return.sql']);
    const tables = await fixture.client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind='r' AND c.relname=ANY($2::text[]) ORDER BY c.relname`,
    [fixture.schema, ['mdf_correction_command_results', 'mdf_correction_job_effect_suppressions', 'mdf_cnc_return_fences']]);
    expect(tables.rows.map(row => row.relname)).toEqual([
      'mdf_cnc_return_fences', 'mdf_correction_command_results', 'mdf_correction_job_effect_suppressions',
    ]);
    const suppressionForeignKeys = await fixture.client.query(`SELECT 1 FROM pg_constraint c
      JOIN pg_class r ON r.oid=c.confrelid JOIN pg_namespace n ON n.oid=r.relnamespace
      WHERE n.nspname=$1 AND c.conrelid=to_regclass($2) AND r.relname='mdf_recalculation_jobs' AND c.contype='f'`,
    [fixture.schema, `${fixture.schema}.mdf_correction_job_effect_suppressions`]);
    expect(suppressionForeignKeys.rows).toHaveLength(0);
  });

  it('persists only monotonic fresh CNC pending→completion transitions and epoch resets', async () => {
    await fixture.client.query('INSERT INTO cnc_telegram_packets(packet_id) VALUES($1)', [packetId]);
    await fixture.client.query(`INSERT INTO mdf_cnc_return_fences
      (packet_id,correction_epoch,baseline_source_version,state) VALUES($1,1,7,'waiting_pending')`, [packetId]);
    await expect(fixture.client.query(`UPDATE mdf_cnc_return_fences SET state='waiting_completion',pending_source_version=7
      WHERE packet_id=$1`, [packetId])).rejects.toMatchObject({ code: '23514' });
    await fixture.client.query('ROLLBACK');
    await fixture.client.query(`UPDATE mdf_cnc_return_fences SET state='waiting_completion',pending_source_version=8
      WHERE packet_id=$1`, [packetId]);
    await expect(fixture.client.query(`UPDATE mdf_cnc_return_fences SET state='satisfied',completion_source_version=8
      WHERE packet_id=$1`, [packetId])).rejects.toMatchObject({ code: '23514' });
    await fixture.client.query('ROLLBACK');
    await fixture.client.query(`UPDATE mdf_cnc_return_fences SET state='satisfied',completion_source_version=9
      WHERE packet_id=$1`, [packetId]);
    await expect(fixture.client.query(`UPDATE mdf_cnc_return_fences SET baseline_source_version=10 WHERE packet_id=$1`, [packetId]))
      .rejects.toMatchObject({ code: '55000' });
    await fixture.client.query('ROLLBACK');
    await expect(fixture.client.query(`UPDATE mdf_cnc_return_fences SET created_at=created_at+interval '1 second'
      WHERE packet_id=$1`, [packetId])).rejects.toMatchObject({ code: '55000' });
    await fixture.client.query('ROLLBACK');
    await expect(fixture.client.query('DELETE FROM mdf_cnc_return_fences WHERE packet_id=$1', [packetId]))
      .rejects.toMatchObject({ code: '55000' });
    await fixture.client.query('ROLLBACK');
    await fixture.client.query(`UPDATE mdf_cnc_return_fences SET correction_epoch=2,baseline_source_version=9,
      state='waiting_pending',pending_source_version=NULL,completion_source_version=NULL WHERE packet_id=$1`, [packetId]);
    expect((await fixture.client.query(`SELECT correction_epoch,baseline_source_version,pending_source_version,
      completion_source_version,state FROM mdf_cnc_return_fences WHERE packet_id=$1`, [packetId])).rows[0])
      .toEqual({ correction_epoch: '2', baseline_source_version: '9', pending_source_version: null,
        completion_source_version: null, state: 'waiting_pending' });
    await expect(fixture.client.query(`UPDATE mdf_cnc_return_fences SET correction_epoch=3,baseline_source_version=8,
      state='waiting_pending',pending_source_version=NULL,completion_source_version=NULL WHERE packet_id=$1`, [packetId]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('keeps saved command responses and per-order effect suppressions immutable', async () => {
    const jobId = randomUUID();
    await fixture.client.query(`INSERT INTO mdf_correction_command_results
      (actor_user_id,command_key,request_digest,source_kind,source_id,order_ids,response)
      VALUES(1,'E2E-key',$1,'packet',$2,ARRAY[1,2],'{}')`, ['a'.repeat(64), packetId]);
    await fixture.client.query(`INSERT INTO mdf_correction_job_effect_suppressions
      (job_id,affected_order_id,correction_source_kind,correction_source_id,correction_epoch,command_key)
      VALUES($1,1,'packet',$2,2,'E2E-key')`, [jobId, packetId]);
    await expect(fixture.client.query("UPDATE mdf_correction_command_results SET response='{}' WHERE command_key='E2E-key'"))
      .rejects.toMatchObject({ code: '55000' });
    await fixture.client.query('ROLLBACK');
    await expect(fixture.client.query('DELETE FROM mdf_correction_command_results WHERE command_key=$1', ['E2E-key']))
      .rejects.toMatchObject({ code: '55000' });
    await fixture.client.query('ROLLBACK');
    await expect(fixture.client.query('UPDATE mdf_correction_job_effect_suppressions SET correction_epoch=3 WHERE job_id=$1', [jobId]))
      .rejects.toMatchObject({ code: '55000' });
    await fixture.client.query('ROLLBACK');
    await expect(fixture.client.query('DELETE FROM mdf_correction_job_effect_suppressions WHERE job_id=$1', [jobId]))
      .rejects.toMatchObject({ code: '55000' });
    await fixture.client.query('ROLLBACK');
  });
});
