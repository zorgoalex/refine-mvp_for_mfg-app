import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMdfCorrectionPgFixture } from '../../src/modules/mdf-board/adapters/mdf-correction-test-fixture.integration';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';

describe.skipIf(!enabled)('manual SVG observation migration 181, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e181mig');
  const manualTables = [
    'cnc_manual_svg_telegram_send_requests',
    'cnc_manual_svg_telegram_send_request_files',
    'cnc_manual_svg_upload_files',
  ];

  beforeAll(async () => {
    await fixture.connect();
    await fixture.clonePublicTables(['cnc_telegram_packets']);
    await fixture.client.query(`ALTER TABLE ${fixture.schema}.cnc_telegram_packets ADD PRIMARY KEY(packet_id);
      CREATE TABLE ${fixture.schema}.cnc_telegram_import_candidates(candidate_id uuid PRIMARY KEY);
      CREATE TABLE ${fixture.schema}.cnc_telegram_import_items(import_item_id uuid PRIMARY KEY);
      CREATE TABLE ${fixture.schema}.cnc_manual_svg_telegram_send_requests(request_id uuid PRIMARY KEY);
      CREATE TABLE ${fixture.schema}.cnc_manual_svg_telegram_send_request_files(
        request_id uuid NOT NULL, file_id uuid NOT NULL, send_order integer NOT NULL, PRIMARY KEY(request_id,file_id));
      CREATE TABLE ${fixture.schema}.cnc_manual_svg_upload_files(file_id uuid PRIMARY KEY);`);
    await fixture.applyMigrations([
      '165_mdf_engine_foundation.sql',
      '166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql',
      '175_mdf_command_placement.sql',
      '178_mdf_correction_receipts.sql',
      '179_mdf_active_return.sql',
      '180_mdf_cnc_observations.sql',
      '181_cnc_manual_send_observation.sql',
    ]);
  }, 30000);

  afterAll(async () => fixture.drop());

  it('keeps every new relation and reference local, with snapshots not locking packet/head rows by FK', async () => {
    await fixture.assertLocalRelations([
      ...manualTables,
      'cnc_telegram_packets',
      'mdf_cnc_observation_targets',
      'cnc_manual_svg_observation_claim_snapshots',
      'cnc_manual_svg_observation_send_bindings',
      'cnc_manual_svg_observation_registration_work',
    ]);
    const snapshotRefs = await fixture.client.query(`SELECT n.nspname schema_name,r.relname table_name
      FROM pg_constraint c JOIN pg_class r ON r.oid=c.confrelid JOIN pg_namespace n ON n.oid=r.relnamespace
      WHERE c.conrelid=to_regclass($1) AND c.contype='f' ORDER BY n.nspname,r.relname`,
    [`${fixture.schema}.cnc_manual_svg_observation_claim_snapshots`]);
    expect(snapshotRefs.rows).toEqual([{ schema_name: fixture.schema, table_name: manualTables[0] }]);

    const bindingsRefs = await fixture.client.query(`SELECT n.nspname schema_name,r.relname table_name
      FROM pg_constraint c JOIN pg_class r ON r.oid=c.confrelid JOIN pg_namespace n ON n.oid=r.relnamespace
      WHERE c.conrelid=to_regclass($1) AND c.contype='f' ORDER BY n.nspname,r.relname`,
    [`${fixture.schema}.cnc_manual_svg_observation_send_bindings`]);
    expect(bindingsRefs.rows).toEqual([{ schema_name: fixture.schema, table_name: 'cnc_manual_svg_observation_claim_snapshots' }]);
    const workRefs = await fixture.client.query(`SELECT n.nspname schema_name,r.relname table_name
      FROM pg_constraint c JOIN pg_class r ON r.oid=c.confrelid JOIN pg_namespace n ON n.oid=r.relnamespace
      WHERE c.conrelid=to_regclass($1) AND c.contype='f' ORDER BY n.nspname,r.relname`,
    [`${fixture.schema}.cnc_manual_svg_observation_registration_work`]);
    expect(workRefs.rows).toEqual([{ schema_name: fixture.schema, table_name: 'cnc_manual_svg_observation_send_bindings' }]);
    const targetRefs = await fixture.client.query(`SELECT n.nspname schema_name,r.relname table_name
      FROM pg_constraint c JOIN pg_class r ON r.oid=c.confrelid JOIN pg_namespace n ON n.oid=r.relnamespace
      WHERE c.conrelid=to_regclass($1) AND c.contype='f' ORDER BY r.relname`,
    [`${fixture.schema}.mdf_cnc_observation_targets`]);
    expect(targetRefs.rows).toEqual([
      { schema_name: fixture.schema, table_name: 'cnc_manual_svg_telegram_send_requests' },
      { schema_name: fixture.schema, table_name: 'cnc_telegram_import_candidates' },
      { schema_name: fixture.schema, table_name: 'cnc_telegram_import_items' },
      { schema_name: fixture.schema, table_name: 'cnc_telegram_packets' },
    ]);
    const registrationColumn = (await fixture.client.query(`SELECT column_default,is_nullable FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='mdf_cnc_observation_targets' AND column_name='registration_kind'`,
    [fixture.schema])).rows[0];
    expect(registrationColumn).toMatchObject({ column_default: "'import'::text", is_nullable: 'NO' });
  });

  it('rejects public-only prerequisites before any public object changes', async () => {
    const missingSchema = `e2e181m_${randomUUID().replaceAll('-', '')}`;
    await fixture.client.query(`CREATE SCHEMA "${missingSchema}"; SET search_path="${missingSchema}",public`);
    const before = await fixture.client.query(`SELECT c.relname, c.relkind::text relkind,
        COALESCE((SELECT string_agg(a.attname,',' ORDER BY a.attnum) FROM pg_attribute a
          WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'') columns
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname`, [[
      'cnc_manual_svg_observation_claim_snapshots', 'cnc_manual_svg_observation_send_bindings',
      'cnc_manual_svg_observation_registration_work', 'cnc_manual_svg_telegram_send_requests',
    ]]);
    try {
      await expect(fixture.client.query(readFileSync(new URL('./181_cnc_manual_send_observation.sql', import.meta.url), 'utf8')))
        .rejects.toMatchObject({ code: 'P0001' });
    } finally {
      await fixture.client.query('ROLLBACK');
      await fixture.client.query(`SET search_path="${fixture.schema}",public; DROP SCHEMA "${missingSchema}" CASCADE`);
    }
    const after = await fixture.client.query(`SELECT c.relname, c.relkind::text relkind,
        COALESCE((SELECT string_agg(a.attname,',' ORDER BY a.attnum) FROM pg_attribute a
          WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'') columns
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname`, [[
      'cnc_manual_svg_observation_claim_snapshots', 'cnc_manual_svg_observation_send_bindings',
      'cnc_manual_svg_observation_registration_work', 'cnc_manual_svg_telegram_send_requests',
    ]]);
    expect(after.rows).toEqual(before.rows);
  });

  it('freezes claim and send bindings, permits only monotone terminal work transitions, and preserves import targets', async () => {
    const requestId = randomUUID(), generation = 1;
    await fixture.client.query('INSERT INTO cnc_manual_svg_telegram_send_requests(request_id) VALUES($1)', [requestId]);
    await fixture.client.query(`INSERT INTO cnc_manual_svg_observation_claim_snapshots(
      send_request_id,lease_generation,worker_instance_id,session_generation,lease_token_hash,packet_id,
      destination_chat_id,requested_file_count,files_qualified,files_snapshot,source_eligible,source_fence)
      VALUES($1,$2,$3,1,$4,$5,'-100123',1,true,$6::jsonb,true,$7::jsonb)`, [
      requestId, generation, randomUUID(), 'a'.repeat(64), randomUUID(),
      JSON.stringify([{ fileId: randomUUID(), kind: 'svg', sha256: 'b'.repeat(64), sendOrder: 1 }]),
      JSON.stringify({ sourceVersion: '1', acceptedRevisionKey: 'revision-1' }),
    ]);
    await expect(fixture.client.query(`UPDATE cnc_manual_svg_observation_claim_snapshots
      SET destination_chat_id='-999' WHERE send_request_id=$1`, [requestId])).rejects.toMatchObject({ code: '55000' });
    await expect(fixture.client.query(`DELETE FROM cnc_manual_svg_observation_claim_snapshots WHERE send_request_id=$1`, [requestId]))
      .rejects.toMatchObject({ code: '55000' });

    await fixture.client.query(`INSERT INTO cnc_manual_svg_observation_send_bindings(
      send_request_id,lease_generation,sent_chat_id,transport_message_ids,sent_files,completion_digest)
      VALUES($1,$2,'-100123','["101"]','[{"fileId":"${randomUUID()}","messageId":"101","sourceSha256":"${'b'.repeat(64)}","mediaSha256":"${'b'.repeat(64)}"}]',$3)`,
    [requestId, generation, 'c'.repeat(64)]);
    await expect(fixture.client.query(`UPDATE cnc_manual_svg_observation_send_bindings
      SET sent_chat_id='-999' WHERE send_request_id=$1`, [requestId])).rejects.toMatchObject({ code: '55000' });

    await fixture.client.query(`INSERT INTO cnc_manual_svg_observation_registration_work(send_request_id,lease_generation)
      VALUES($1,$2)`, [requestId, generation]);
    await fixture.client.query(`UPDATE cnc_manual_svg_observation_registration_work SET work_state='registered',updated_at=now()
      WHERE send_request_id=$1 AND lease_generation=$2`, [requestId, generation]);
    await expect(fixture.client.query(`UPDATE cnc_manual_svg_observation_registration_work
      SET work_state='ineligible',reason='TARGET_ALREADY_BOUND' WHERE send_request_id=$1`, [requestId]))
      .rejects.toMatchObject({ code: '55000' });

    const retryRequestId = randomUUID();
    await fixture.client.query('INSERT INTO cnc_manual_svg_telegram_send_requests(request_id) VALUES($1)', [retryRequestId]);
    await fixture.client.query(`INSERT INTO cnc_manual_svg_observation_claim_snapshots(
      send_request_id,lease_generation,worker_instance_id,session_generation,lease_token_hash,packet_id,
      destination_chat_id,requested_file_count,files_qualified,files_snapshot,source_eligible,source_fence)
      VALUES($1,1,$2,1,$3,$4,'-100124',1,true,$5::jsonb,true,'{}'::jsonb)`, [
      retryRequestId, randomUUID(), '1'.repeat(64), randomUUID(),
      JSON.stringify([{ fileId: randomUUID(), kind: 'svg', sha256: '2'.repeat(64), sendOrder: 1 }]),
    ]);
    await fixture.client.query(`INSERT INTO cnc_manual_svg_observation_send_bindings(
      send_request_id,lease_generation,sent_chat_id,transport_message_ids,sent_files,completion_digest)
      VALUES($1,1,'-100124','["401"]','[{"fileId":"${randomUUID()}","messageId":"401","sourceSha256":"${'2'.repeat(64)}","mediaSha256":"${'2'.repeat(64)}"}]',$2)`,
    [retryRequestId, '3'.repeat(64)]);
    await fixture.client.query(`INSERT INTO cnc_manual_svg_observation_registration_work(send_request_id,lease_generation)
      VALUES($1,1)`, [retryRequestId]);
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      await fixture.client.query(`UPDATE cnc_manual_svg_observation_registration_work
        SET attempt_count=$2,next_attempt_at=now()+interval '30 seconds',updated_at=now()
        WHERE send_request_id=$1 AND lease_generation=1`, [retryRequestId, attempt]);
      expect((await fixture.client.query(`SELECT work_state,reason,attempt_count FROM cnc_manual_svg_observation_registration_work
        WHERE send_request_id=$1`, [retryRequestId])).rows[0]).toEqual({
        work_state: 'pending', reason: null, attempt_count: attempt,
      });
    }
    await fixture.client.query(`UPDATE cnc_manual_svg_observation_registration_work
      SET work_state='needs_reconciliation',reason='REGISTRATION_RETRY_EXHAUSTED',attempt_count=10,
          next_attempt_at=now()+interval '30 seconds',updated_at=now()
      WHERE send_request_id=$1 AND lease_generation=1`, [retryRequestId]);
    expect((await fixture.client.query(`SELECT work_state,reason,attempt_count FROM cnc_manual_svg_observation_registration_work
      WHERE send_request_id=$1`, [retryRequestId])).rows[0]).toEqual({
      work_state: 'needs_reconciliation', reason: 'REGISTRATION_RETRY_EXHAUSTED', attempt_count: 10,
    });
    await expect(fixture.client.query(`UPDATE cnc_manual_svg_observation_registration_work
      SET attempt_count=10,updated_at=now()+interval '1 second' WHERE send_request_id=$1 AND lease_generation=1`, [retryRequestId]))
      .rejects.toMatchObject({ code: '55000' });

    const importRequestId = randomUUID(), packetId = randomUUID(), itemId = randomUUID(), candidateId = randomUUID();
    await fixture.client.query('INSERT INTO cnc_telegram_packets(packet_id) VALUES($1)', [packetId]);
    await fixture.client.query('INSERT INTO cnc_manual_svg_telegram_send_requests(request_id) VALUES($1)', [importRequestId]);
    await fixture.client.query('INSERT INTO cnc_telegram_import_candidates(candidate_id) VALUES($1)', [candidateId]);
    await fixture.client.query('INSERT INTO cnc_telegram_import_items(import_item_id) VALUES($1)', [itemId]);
    await fixture.client.query(`INSERT INTO mdf_cnc_observation_targets(packet_id,import_item_id,candidate_id,
      source_chat_id,source_group_message_id,message_bindings,registered_revision_key,registered_membership_digest,
      accepted_revision_key,last_observation_version)
      VALUES($1,$2,$3,'-100123',200,'[{"messageId":"200","role":"svg","sha256":"${'d'.repeat(64)}"}]',
        'r1','${'e'.repeat(64)}','r1',1)`, [packetId, itemId, candidateId]);
    const targetCols = (await fixture.client.query(`SELECT registration_kind,manual_send_request_id::text,
      import_item_id::text,candidate_id::text FROM mdf_cnc_observation_targets WHERE packet_id=$1`, [packetId])).rows[0];
    expect(targetCols).toEqual({ registration_kind: 'import', manual_send_request_id: null,
      import_item_id: itemId, candidate_id: candidateId });

    const manualPacketId = randomUUID(), manualRequestId = randomUUID();
    await fixture.client.query('INSERT INTO cnc_telegram_packets(packet_id) VALUES($1)', [manualPacketId]);
    await fixture.client.query('INSERT INTO cnc_manual_svg_telegram_send_requests(request_id) VALUES($1)', [manualRequestId]);
    await fixture.client.query(`INSERT INTO mdf_cnc_observation_targets(packet_id,registration_kind,manual_send_request_id,
      source_chat_id,source_group_message_id,message_bindings,registered_revision_key,registered_membership_digest,
      accepted_revision_key,last_observation_version)
      VALUES($1,'manual_send',$2,'-100123',301,'[{"messageId":"301","role":"svg","sha256":"${'f'.repeat(64)}"}]',
        'r2','${'a'.repeat(64)}','r2',1)`, [manualPacketId, manualRequestId]);
    expect((await fixture.client.query(`SELECT registration_kind,manual_send_request_id::text,
      source_group_message_id::text FROM mdf_cnc_observation_targets WHERE packet_id=$1`, [manualPacketId])).rows[0])
      .toEqual({ registration_kind: 'manual_send', manual_send_request_id: manualRequestId, source_group_message_id: '301' });
    await expect(fixture.client.query(`UPDATE mdf_cnc_observation_targets SET manual_send_request_id=$2 WHERE packet_id=$1`,
      [manualPacketId, randomUUID()])).rejects.toMatchObject({ code: '55000' });
    await expect(fixture.client.query(`UPDATE mdf_cnc_observation_targets SET registration_kind='import' WHERE packet_id=$1`,
      [manualPacketId])).rejects.toMatchObject({ code: '55000' });
    await expect(fixture.client.query(`INSERT INTO mdf_cnc_observation_targets(packet_id,registration_kind,manual_send_request_id,
      import_item_id,candidate_id,source_chat_id,source_group_message_id,message_bindings,registered_revision_key,
      registered_membership_digest,accepted_revision_key,last_observation_version)
      VALUES($1,'manual_send',$2,$3,$4,'-100123',302,'[{"messageId":"302","role":"svg","sha256":"${'b'.repeat(64)}"}]',
        'r3','${'c'.repeat(64)}','r3',1)`, [randomUUID(), manualRequestId, itemId, candidateId]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(fixture.client.query(`INSERT INTO mdf_cnc_observation_targets(packet_id,registration_kind,manual_send_request_id,
      source_chat_id,source_group_message_id,message_bindings,registered_revision_key,registered_membership_digest,
      accepted_revision_key,last_observation_version)
      VALUES($1,'manual_send',NULL,'-100123',303,'[{"messageId":"303","role":"svg","sha256":"${'b'.repeat(64)}"}]',
        'r4','${'c'.repeat(64)}','r4',1)`, [randomUUID()])).rejects.toMatchObject({ code: '23514' });
    await expect(fixture.client.query('UPDATE mdf_cnc_observation_targets SET last_observation_version=0 WHERE packet_id=$1',
      [manualPacketId])).rejects.toMatchObject({ code: '23514' });
    await fixture.client.query(`UPDATE mdf_cnc_observation_targets SET claim_id=$2,claim_token_hash=$3,
      claim_generation=1,claim_worker_instance_id=$4,claim_session_generation=1,claim_expires_at=now()+interval '1 minute',
      claim_head_version=1,claim_correction_epoch=0,claim_raw_source_version=1,claim_observation_version=1 WHERE packet_id=$1`,
    [manualPacketId, randomUUID(), 'd'.repeat(64), randomUUID()]);
    await expect(fixture.client.query('UPDATE mdf_cnc_observation_targets SET claim_generation=0 WHERE packet_id=$1',
      [manualPacketId])).rejects.toMatchObject({ code: '23514' });
  });
});
