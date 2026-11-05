import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMdfCorrectionPgFixture } from '../../src/modules/mdf-board/adapters/mdf-correction-test-fixture.integration';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';
let packetId = randomUUID();
let itemId = randomUUID();
let candidateId = randomUUID();
let claimId = randomUUID();

describe.skipIf(!enabled)('MDF CNC observation migration 180, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e180mig');
  const migration = readFileSync(new URL('./180_mdf_cnc_observations.sql', import.meta.url), 'utf8');
  const publicObservationRelations = async () => {
    const names = ['mdf_cnc_observation_targets','mdf_cnc_observation_receipts','mdf_cnc_observation_job_authorities'];
    return (await fixture.client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname`, [names])).rows;
  };

  beforeAll(async () => {
    await fixture.connect();
    await fixture.clonePublicTables(['cnc_telegram_packets']);
    await fixture.client.query(`ALTER TABLE ${fixture.schema}.cnc_telegram_packets ADD PRIMARY KEY(packet_id);
      CREATE TABLE ${fixture.schema}.cnc_telegram_import_candidates(candidate_id uuid PRIMARY KEY);
      CREATE TABLE ${fixture.schema}.cnc_telegram_import_items(import_item_id uuid PRIMARY KEY);`);
    await fixture.applyMigrations([
      '165_mdf_engine_foundation.sql',
      '166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql',
      '175_mdf_command_placement.sql',
      '178_mdf_correction_receipts.sql',
      '179_mdf_active_return.sql',
    ]);
    await fixture.applyMigrations(['180_mdf_cnc_observations.sql']);
  }, 30000);

  afterAll(async () => fixture.drop());
  beforeEach(() => {
    packetId = randomUUID();
    itemId = randomUUID();
    candidateId = randomUUID();
    claimId = randomUUID();
  });

  it('fails closed if prerequisites are visible only in public', async () => {
    const missingSchema = `e2e180m_${randomUUID().replaceAll('-', '')}`;
    await fixture.client.query(`CREATE SCHEMA "${missingSchema}"; SET search_path="${missingSchema}",public`);
    const before = await publicObservationRelations();
    try {
      await expect(fixture.client.query(migration)).rejects.toMatchObject({ code: 'P0001' });
    } finally {
      await fixture.client.query('ROLLBACK');
      await fixture.client.query(`SET search_path="${fixture.schema}",public; DROP SCHEMA "${missingSchema}" CASCADE`);
    }
    expect(await publicObservationRelations()).toEqual(before);
    expect((await fixture.client.query('SELECT current_schema() AS schema')).rows[0].schema).toBe(fixture.schema);
  });

  it('creates only the bounded target, receipt, and CNC-authority marker tables with local references', async () => {
    await fixture.assertLocalRelations([
      'cnc_telegram_packets', 'cnc_telegram_import_candidates', 'cnc_telegram_import_items',
      'mdf_cnc_observation_targets', 'mdf_cnc_observation_receipts', 'mdf_cnc_observation_job_authorities',
    ]);
    await fixture.applyMigrations(['180_mdf_cnc_observations.sql']);
    const refs = await fixture.client.query(`SELECT c.conname, n.nspname referenced_schema, r.relname referenced_table
      FROM pg_constraint c JOIN pg_class r ON r.oid=c.confrelid JOIN pg_namespace n ON n.oid=r.relnamespace
      WHERE c.conrelid=to_regclass($1) AND c.contype='f' ORDER BY c.conname`, [`${fixture.schema}.mdf_cnc_observation_targets`]);
    expect(refs.rows).toEqual([
      { conname: 'mdf_cnc_observation_targets_candidate_id_fkey', referenced_schema: fixture.schema, referenced_table: 'cnc_telegram_import_candidates' },
      { conname: 'mdf_cnc_observation_targets_import_item_id_fkey', referenced_schema: fixture.schema, referenced_table: 'cnc_telegram_import_items' },
      { conname: 'mdf_cnc_observation_targets_packet_id_fkey', referenced_schema: fixture.schema, referenced_table: 'cnc_telegram_packets' },
    ]);
  });

  it('accepts at most three unique typed group bindings and freezes source identity', async () => {
    await insertTarget([binding(101, 'svg'), binding(102, 'gcode'), binding(103, 'image')], { packetId, itemId, candidateId });
    await expect(insertTarget([binding(101, 'svg'), binding(102, 'gcode'), binding(103, 'image'), binding(104, 'image')]))
      .rejects.toMatchObject({ code: '23514' });
    await fixture.client.query('ROLLBACK');
    await expect(insertTarget([binding(101, 'svg'), binding(101, 'gcode')])).rejects.toMatchObject({ code: '23514' });
    await fixture.client.query('ROLLBACK');
    await expect(insertTarget([{ ...binding(101, 'svg'), role: 'message' }])).rejects.toMatchObject({ code: '23514' });
    await fixture.client.query('ROLLBACK');
    await expect(insertTarget([binding(2147483648, 'svg')])).rejects.toMatchObject({ code: '23514' });
    await fixture.client.query('ROLLBACK');
    await expect(fixture.client.query("UPDATE mdf_cnc_observation_targets SET source_chat_id='-999' WHERE packet_id=$1", [packetId]))
      .rejects.toMatchObject({ code: '55000' });
    await fixture.client.query('ROLLBACK');
  });

  it('rejects missing SVG bindings and malformed/null JSON fields', async () => {
    await expect(insertTarget([binding(101, 'gcode')])).rejects.toMatchObject({ code: '23514' });
    await fixture.client.query('ROLLBACK');
    await expect(insertTarget([{ messageId: null, role: 'svg', sha256: 'a'.repeat(64) }]))
      .rejects.toMatchObject({ code: '23514' });
    await fixture.client.query('ROLLBACK');
    await expect(insertTarget([{ messageId: '101', role: 'svg', sha256: null }]))
      .rejects.toMatchObject({ code: '23514' });
    await fixture.client.query('ROLLBACK');
    await expect(insertTarget([{ messageId: 101, role: 'svg', sha256: 'a'.repeat(64) }]))
      .rejects.toMatchObject({ code: '23514' });
    await fixture.client.query('ROLLBACK');
    await expect(insertTarget([{ messageId: '101', role: 'svg', sha256: 101 }]))
      .rejects.toMatchObject({ code: '23514' });
    await fixture.client.query('ROLLBACK');
  });

  it('rejects NULL claim snapshot fields even when the rest of a claim is populated', async () => {
    for (const nullField of ['claim_session_generation', 'claim_head_version', 'claim_correction_epoch', 'claim_raw_source_version', 'claim_observation_version']) {
      const ids = { packetId: randomUUID(), itemId: randomUUID(), candidateId: randomUUID() };
      await insertTarget([binding(101, 'svg')], ids);
      const numericClaimFields = [
        'claim_session_generation', 'claim_head_version', 'claim_correction_epoch',
        'claim_raw_source_version', 'claim_observation_version',
      ];
      const claimAssignments = numericClaimFields.map((field) => `${field}=${field === nullField ? 'NULL' : '1'}`).join(',');
      await expect(fixture.client.query(`UPDATE mdf_cnc_observation_targets SET claim_id=$2,claim_token_hash=$3,
        claim_generation=1,claim_worker_instance_id=$4,claim_expires_at=now()+interval '1 minute',
        ${claimAssignments} WHERE packet_id=$1`,
      [ids.packetId, randomUUID(), 'a'.repeat(64), randomUUID()])).rejects.toMatchObject({ code: '23514' });
      await fixture.client.query('ROLLBACK');
    }
  });

  it('allows multiple immutable no-op reports at one observation version and pins the original claim token', async () => {
    await insertTarget([binding(101, 'svg')], { packetId, itemId, candidateId });
    const reportValues = [
      claimId, packetId, 1, 'a'.repeat(64), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1,
      1, 0, 1, 9, 'pending', 'c'.repeat(64), JSON.stringify([{ messageId: 101, thumbsUp: false }]),
      JSON.stringify({ status: 'recorded', observationVersion: '9', fenceState: 'waiting_pending', jobId: null }),
    ];
    await fixture.client.query(`INSERT INTO mdf_cnc_observation_receipts
      (claim_id,packet_id,claim_generation,claim_token_hash,worker_instance_id,session_generation,
       head_version,correction_epoch,raw_source_version,observation_version,report_state,report_digest,report,result)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb)`, reportValues);
    await fixture.client.query(`INSERT INTO mdf_cnc_observation_receipts
      (claim_id,packet_id,claim_generation,claim_token_hash,worker_instance_id,session_generation,
       head_version,correction_epoch,raw_source_version,observation_version,report_state,report_digest,report,result)
      VALUES($1,$2,2,$3,'cccccccc-cccc-4ccc-8ccc-cccccccccccc',1,1,0,1,9,'pending',$4,'[]','{}')`,
    [randomUUID(), packetId, 'd'.repeat(64), 'e'.repeat(64)]);
    await expect(fixture.client.query(`UPDATE mdf_cnc_observation_receipts SET result='{}' WHERE claim_id=$1`, [claimId]))
      .rejects.toMatchObject({ code: '55000' });
    await fixture.client.query('ROLLBACK');
    await expect(fixture.client.query('DELETE FROM mdf_cnc_observation_receipts WHERE claim_id=$1', [claimId]))
      .rejects.toMatchObject({ code: '55000' });
    await fixture.client.query('ROLLBACK');
    expect((await fixture.client.query(`SELECT count(*)::text AS count FROM mdf_cnc_observation_receipts
      WHERE packet_id=$1 AND observation_version=9`, [packetId])).rows[0].count).toBe('2');
  });

  it('rejects observation sequence and claim generation regressions and immutable marker edits', async () => {
    await insertTarget([binding(101, 'svg')], { packetId, itemId, candidateId });
    await fixture.client.query(`UPDATE mdf_cnc_observation_targets SET claim_id=$2,claim_token_hash=$3,
      claim_generation=1,claim_worker_instance_id=$4,claim_session_generation=1,claim_expires_at=now()+interval '1 minute',
      claim_head_version=1,claim_correction_epoch=0,claim_raw_source_version=1,claim_observation_version=1
      WHERE packet_id=$1`, [packetId, claimId, 'a'.repeat(64), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
    await fixture.client.query(`UPDATE mdf_cnc_observation_targets SET claim_id=NULL,claim_token_hash=NULL,
      claim_worker_instance_id=NULL,claim_session_generation=NULL,claim_expires_at=NULL,claim_head_version=NULL,
      claim_correction_epoch=NULL,claim_raw_source_version=NULL,claim_observation_version=NULL,claim_generation=2 WHERE packet_id=$1`, [packetId]);
    await expect(fixture.client.query('UPDATE mdf_cnc_observation_targets SET claim_generation=1 WHERE packet_id=$1', [packetId]))
      .rejects.toMatchObject({ code: '23514' });
    await fixture.client.query('ROLLBACK');
    await expect(fixture.client.query('UPDATE mdf_cnc_observation_targets SET last_observation_version=0 WHERE packet_id=$1', [packetId]))
      .rejects.toMatchObject({ code: '23514' });
    await fixture.client.query('ROLLBACK');
    await fixture.client.query(`INSERT INTO mdf_cnc_observation_receipts
      (claim_id,packet_id,claim_generation,claim_token_hash,worker_instance_id,session_generation,
       head_version,correction_epoch,raw_source_version,observation_version,report_state,report_digest,report,result)
      VALUES($1,$2,1,$3,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,1,0,1,1,'pending',$4,'[]','{}')`,
    [claimId, packetId, 'a'.repeat(64), 'e'.repeat(64)]);
    await fixture.client.query(`INSERT INTO mdf_cnc_observation_job_authorities(job_id,packet_id,claim_id,authority)
      VALUES($1,$2,$3,'cnc_autocut')`, [randomUUID(), packetId, claimId]);
    await expect(fixture.client.query("UPDATE mdf_cnc_observation_job_authorities SET authority='ordinary' WHERE claim_id=$1", [claimId]))
      .rejects.toMatchObject({ code: '55000' });
    await fixture.client.query('ROLLBACK');
  });

  async function insertTarget(bindings: unknown[], ids = { packetId: randomUUID(), itemId: randomUUID(), candidateId: randomUUID() }) {
    await fixture.client.query('INSERT INTO cnc_telegram_packets(packet_id) VALUES($1)', [ids.packetId]);
    await fixture.client.query('INSERT INTO cnc_telegram_import_candidates(candidate_id) VALUES($1)', [ids.candidateId]);
    await fixture.client.query('INSERT INTO cnc_telegram_import_items(import_item_id) VALUES($1)', [ids.itemId]);
    return fixture.client.query(`INSERT INTO mdf_cnc_observation_targets
      (packet_id,import_item_id,candidate_id,source_chat_id,source_group_message_id,message_bindings,
       registered_revision_key,accepted_revision_key,last_observation_version,registered_membership_digest)
      VALUES($1,$2,$3,'-100123',101,$4::jsonb,'registered-revision','accepted-revision',1,$5)`,
    [ids.packetId, ids.itemId, ids.candidateId, JSON.stringify(bindings), 'd'.repeat(64)]);
  }
});

function binding(messageId: number, role: string) {
  return { messageId: String(messageId), role, sha256: 'a'.repeat(64) };
}
