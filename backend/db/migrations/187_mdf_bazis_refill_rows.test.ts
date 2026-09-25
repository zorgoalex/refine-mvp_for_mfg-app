import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMdfCorrectionPgFixture } from '../../src/modules/mdf-board/adapters/mdf-correction-test-fixture.integration';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';

describe.skipIf(!enabled)('BASIS refill provenance migration 187, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e187refill');

  beforeAll(async () => {
    await fixture.connect();
    await fixture.clonePublicTables([
      'orders', 'order_details', 'order_statuses', 'production_statuses', 'materials', 'sheet_material_types',
      'users', 'status_automation_rules', 'outbox_events', 'audit_log', 'audit_log_related_entity', 'app_settings',
      'order_workshops', 'bazis_order_links', 'order_import_entity_map', 'bazis_cut_sets', 'bazis_cut_set_details',
      'cnc_telegram_packets', 'cnc_telegram_packet_items', 'cnc_telegram_packet_whole_order_keys',
      'cut_result', 'cut_result_board_projection', 'cut_result_placement', 'cut_result_sheet_map',
    ]);
    await fixture.client.query('ALTER TABLE cnc_telegram_packets ADD PRIMARY KEY(packet_id)');
    await fixture.applyMigrations([
      '165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql', '175_mdf_command_placement.sql',
      '178_mdf_correction_receipts.sql', '179_mdf_active_return.sql',
      '182_mdf_physical_lineage.sql', '185_mdf_bazis_composition.sql', '187_mdf_bazis_refill_rows.sql',
    ]);
  }, 30000);

  afterAll(async () => fixture.drop());

  it('creates both relations locally and logs every raw row INSERT (never UPDATE) by transaction', async () => {
    await fixture.assertLocalRelations(['mdf_bazis_raw_row_creations', 'mdf_bazis_composition_new_rows']);
    await fixture.client.query(`INSERT INTO bazis_cut_sets(bazis_cut_set_id,name,created_at) VALUES(8701,'E2E-Тест 187',now())`);
    await fixture.client.query(`INSERT INTO bazis_cut_set_details(bazis_cut_set_detail_id,bazis_cut_set_id,quantity)
      VALUES(870101,8701,2)`);
    const logged = (await fixture.client.query(`SELECT row_id::text,set_id::text FROM mdf_bazis_raw_row_creations`)).rows;
    expect(logged).toEqual([{ row_id: '870101', set_id: '8701' }]);
    await fixture.client.query('UPDATE bazis_cut_set_details SET quantity=3 WHERE bazis_cut_set_detail_id=870101');
    expect((await fixture.client.query('SELECT count(*)::int n FROM mdf_bazis_raw_row_creations')).rows[0].n).toBe(1);
    // A re-INSERT of the same id (after DELETE) is a new creation event, not a conflict.
    await fixture.client.query('DELETE FROM bazis_cut_set_details WHERE bazis_cut_set_detail_id=870101');
    await fixture.client.query(`INSERT INTO bazis_cut_set_details(bazis_cut_set_detail_id,bazis_cut_set_id,quantity)
      VALUES(870101,8701,1)`);
    expect((await fixture.client.query('SELECT count(*)::int n FROM mdf_bazis_raw_row_creations')).rows[0].n).toBe(2);
    await expect(fixture.client.query('UPDATE mdf_bazis_raw_row_creations SET set_id=1')).rejects.toThrow(/immutable/);
    await expect(fixture.client.query('DELETE FROM mdf_bazis_raw_row_creations')).rejects.toThrow(/immutable/);
  });

  it('provenance insert requires an existing intent (FK) and a same-transaction creation in its set', async () => {
    // No intent: FK/guard rejects before any provenance exists.
    await expect(fixture.client.query(`INSERT INTO mdf_bazis_composition_new_rows(intent_id,row_id,order_id,detail_id,quantity,snapshot_digest)
      VALUES(gen_random_uuid(),870101,1,1,1,repeat('a',64))`)).rejects.toThrow();
    // A valid UNSEALED intent for set 8702 / owner 870: only its own insert guard is bypassed for setup.
    const intentId = '00000000-0000-4000-8000-000000008702';
    await fixture.client.query(`INSERT INTO bazis_cut_sets(bazis_cut_set_id,name,created_at) VALUES(8702,'E2E-Тест 187b',now())`);
    await fixture.client.query(`INSERT INTO bazis_cut_set_details(bazis_cut_set_detail_id,bazis_cut_set_id,source_type,
      source_order_id,source_order_detail_id,quantity) VALUES(870201,8702,'order_detail',870,87001,2)`); // earlier transaction
    await fixture.client.query('SET session_replication_role=replica');
    try {
      await fixture.client.query(`INSERT INTO mdf_bazis_composition_intents(intent_id,job_id,source_kind,source_id,revision_key,
        predecessor_revision_key,assignment_state_id,set_id,set_version,raw_snapshot_digest,membership_digest,intentional_empty,
        owner_ids,allocation_snapshot_digest,preview_digest,actor_user_id,request_id,command_key,created_at)
        VALUES($1,gen_random_uuid(),'bazisCutSet','8702','e2e-187-rev','e2e-187-prev',gen_random_uuid(),8702,2,
          repeat('a',64),repeat('b',64),false,ARRAY[870]::bigint[],repeat('c',64),repeat('d',64),1,'e2e-187',repeat('e',64),now())`,
      [intentId]);
    } finally { await fixture.client.query('SET session_replication_role=origin'); }
    const provenance = (rowId: number, detailId: number, quantity: number) => fixture.client.query(
      `INSERT INTO mdf_bazis_composition_new_rows(intent_id,row_id,order_id,detail_id,quantity,snapshot_digest)
       VALUES($1,$2,870,$3,$4,repeat('f',64))`, [intentId, rowId, detailId, quantity]);
    const notCreated = /not created by this composition transaction/;
    const inTx = async (run: () => Promise<unknown>) => {
      await fixture.client.query('BEGIN');
      try { return await run(); } finally { await fixture.client.query('ROLLBACK'); }
    };
    // (a) pre-existing row (created in an earlier transaction) is never claimable.
    await inTx(async () => { await expect(provenance(870201, 87001, 2)).rejects.toThrow(notCreated); });
    // (b) merely UPDATED inside this transaction: still not a creation.
    await inTx(async () => {
      await fixture.client.query('UPDATE bazis_cut_set_details SET quantity=5 WHERE bazis_cut_set_detail_id=870201');
      await expect(provenance(870201, 87001, 5)).rejects.toThrow(notCreated);
    });
    // (c) INSERTed in this very transaction into the intent's set: accepted.
    await inTx(async () => {
      await fixture.client.query(`INSERT INTO bazis_cut_set_details(bazis_cut_set_detail_id,bazis_cut_set_id,source_type,
        source_order_id,source_order_detail_id,quantity) VALUES(870202,8702,'order_detail',870,87002,3)`);
      await expect(provenance(870202, 87002, 3)).resolves.toMatchObject({ rowCount: 1 });
    });
    // (d) created in a PREVIOUS (committed) transaction: rejected.
    await fixture.client.query(`INSERT INTO bazis_cut_set_details(bazis_cut_set_detail_id,bazis_cut_set_id,source_type,
      source_order_id,source_order_detail_id,quantity) VALUES(870203,8702,'order_detail',870,87003,1)`);
    await inTx(async () => { await expect(provenance(870203, 87003, 1)).rejects.toThrow(notCreated); });
    expect((await fixture.client.query('SELECT count(*)::int n FROM mdf_bazis_composition_new_rows')).rows[0].n).toBe(0);
  });
});
