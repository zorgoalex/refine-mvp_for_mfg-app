import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMdfCorrectionPgFixture } from '../../src/modules/mdf-board/adapters/mdf-correction-test-fixture.integration';
import { recordMdfLineageReceipt } from '../../src/modules/mdf-board/application/mdf-receipt';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';

describe.skipIf(!enabled)('BASIS composition migration 185, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e185composition');

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
      '182_mdf_physical_lineage.sql', '185_mdf_bazis_composition.sql',
    ]);
  }, 30000);

  afterAll(async () => fixture.drop());

  it('creates both composition relations locally and binds every FK within the isolated schema', async () => {
    const tables = ['mdf_bazis_assignment_states', 'mdf_bazis_composition_intents'];
    await fixture.assertLocalRelations(tables);
    const resolved = await fixture.client.query<{ relation: string; schema: string }>(`
      SELECT wanted.name AS relation, n.nspname AS schema
      FROM unnest($1::text[]) AS wanted(name)
      JOIN pg_class c ON c.oid=to_regclass(wanted.name)
      JOIN pg_namespace n ON n.oid=c.relnamespace
      ORDER BY wanted.name`, [tables]);
    expect(resolved.rows).toEqual(tables.map(relation => ({ relation, schema: fixture.schema })));

    const foreignKeys = await fixture.client.query<{ table_name: string; referenced_schema: string; referenced_table: string }>(`
      SELECT local.relname AS table_name, remote_ns.nspname AS referenced_schema, remote.relname AS referenced_table
      FROM pg_constraint c JOIN pg_class local ON local.oid=c.conrelid
      JOIN pg_namespace local_ns ON local_ns.oid=local.relnamespace
      JOIN pg_class remote ON remote.oid=c.confrelid JOIN pg_namespace remote_ns ON remote_ns.oid=remote.relnamespace
      WHERE local_ns.nspname=$1 AND local.relname=ANY($2::text[]) AND c.contype='f'
      ORDER BY local.relname,remote.relname,c.conname`, [fixture.schema, tables]);
    expect(foreignKeys.rows).toHaveLength(6);
    expect(foreignKeys.rows.every(row => row.referenced_schema === fixture.schema)).toBe(true);
    expect(foreignKeys.rows.map(row => `${row.table_name}->${row.referenced_table}`)).toEqual([
      'mdf_bazis_assignment_states->mdf_bazis_composition_intents',
      'mdf_bazis_assignment_states->mdf_revision_seals',
      'mdf_bazis_assignment_states->mdf_revision_seals',
      'mdf_bazis_composition_intents->mdf_bazis_assignment_states',
      'mdf_bazis_composition_intents->mdf_recalculation_jobs',
      'mdf_bazis_composition_intents->mdf_revision_seals',
    ]);
  });

  it('keeps command-time allocation snapshots off inherited assignment state', async () => {
    const columns = await fixture.client.query<{ table_name: string; column_name: string }>(`
      SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema=$1 AND table_name=ANY($2::text[]) ORDER BY table_name,ordinal_position`,
    [fixture.schema, ['mdf_bazis_assignment_states', 'mdf_bazis_composition_intents']]);
    const byTable = new Map<string, string[]>();
    for (const row of columns.rows) byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row.column_name]);
    expect(byTable.get('mdf_bazis_assignment_states')).toEqual(expect.arrayContaining([
      'source_kind', 'source_id', 'revision_key', 'assignment_state_id', 'predecessor_revision_key',
      'predecessor_state_id', 'root_intent_id', 'membership_digest', 'intentional_empty',
    ]));
    expect(byTable.get('mdf_bazis_assignment_states')).not.toContain('allocation_snapshot_digest');
    expect(byTable.get('mdf_bazis_composition_intents')).toEqual(expect.arrayContaining([
      'intent_id', 'job_id', 'revision_key', 'assignment_state_id', 'set_id', 'set_version', 'raw_snapshot_digest',
      'membership_digest', 'intentional_empty', 'owner_ids', 'allocation_snapshot_digest', 'preview_digest', 'actor_user_id', 'command_key',
    ]));
  });

  it('requires every receipt, lineage, BASIS, and job prerequisite locally before creating markers', async () => {
    const missingSchema = `e2e185m_${randomUUID().replaceAll('-', '')}`;
    await fixture.client.query(`CREATE SCHEMA "${missingSchema}"; SET search_path="${missingSchema}","${fixture.schema}",public`);
    try {
      const migration = readFileSync(new URL('./185_mdf_bazis_composition.sql', import.meta.url), 'utf8');
      await expect(fixture.client.query(migration)).rejects.toMatchObject({ code: 'P0001' });
    } finally {
      await fixture.client.query('ROLLBACK').catch(() => undefined);
      await fixture.client.query(`SET search_path="${fixture.schema}",public; DROP SCHEMA "${missingSchema}" CASCADE`);
    }
    expect((await fixture.client.query(`SELECT to_regclass($1) AS relation`,
      [`${missingSchema}.mdf_bazis_assignment_states`])).rows[0].relation).toBeNull();
    expect((await fixture.client.query('SELECT current_schema() AS schema')).rows[0].schema).toBe(fixture.schema);
  });

  it('installs enabled insert and append-only guards on both marker relations', async () => {
    const functions = await fixture.client.query<{ proname: string }>(`SELECT p.proname FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname=ANY($2::text[]) ORDER BY p.proname`,
    [fixture.schema, ['mdf_guard_bazis_assignment_state_insert','mdf_guard_bazis_composition_intent_insert',
      'mdf_guard_bazis_assignment_state_seal','mdf_validate_bazis_composition_intent_job',
      'mdf_reject_bazis_composition_marker_change']]);
    expect(functions.rows.map(row => row.proname)).toEqual([
      'mdf_guard_bazis_assignment_state_insert', 'mdf_guard_bazis_assignment_state_seal',
      'mdf_guard_bazis_composition_intent_insert', 'mdf_reject_bazis_composition_marker_change',
      'mdf_validate_bazis_composition_intent_job',
    ]);
    const triggers = await fixture.client.query<{ tgname: string; tgenabled: string; table_name: string;
      function_name: string; tgtype: number; tgdeferrable: boolean; tginitdeferred: boolean }>(`
      SELECT t.tgname,t.tgenabled,r.relname AS table_name,p.proname AS function_name,t.tgtype::int,
        t.tgdeferrable,t.tginitdeferred FROM pg_trigger t
      JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE n.nspname=$1 AND NOT t.tgisinternal AND t.tgname=ANY($2::text[]) ORDER BY t.tgname`,
    [fixture.schema, ['mdf_bazis_assignment_state_immutable', 'mdf_bazis_assignment_state_insert_guard',
      'mdf_bazis_assignment_state_seal_guard', 'mdf_bazis_composition_intent_immutable',
      'mdf_bazis_composition_intent_insert_guard', 'mdf_bazis_composition_intent_job_guard']]);
    expect(triggers.rows.map(row => [row.table_name, row.tgname, row.function_name, row.tgtype,
      row.tgdeferrable, row.tginitdeferred])).toEqual([
      ['mdf_bazis_assignment_states','mdf_bazis_assignment_state_immutable','mdf_reject_bazis_composition_marker_change',27,false,false],
      ['mdf_bazis_assignment_states','mdf_bazis_assignment_state_insert_guard','mdf_guard_bazis_assignment_state_insert',7,false,false],
      ['mdf_revision_seals','mdf_bazis_assignment_state_seal_guard','mdf_guard_bazis_assignment_state_seal',7,false,false],
      ['mdf_bazis_composition_intents','mdf_bazis_composition_intent_immutable','mdf_reject_bazis_composition_marker_change',27,false,false],
      ['mdf_bazis_composition_intents','mdf_bazis_composition_intent_insert_guard','mdf_guard_bazis_composition_intent_insert',7,false,false],
      ['mdf_bazis_composition_intents','mdf_bazis_composition_intent_job_guard','mdf_validate_bazis_composition_intent_job',5,true,true],
    ]);
    expect(triggers.rows.every(row => row.tgenabled === 'O')).toBe(true);
  });

  it('rejects an empty assignment marker without its authentic root intent', async () => {
    const sourceId = `missing-root-intent-${randomUUID()}`;
    const revisionKey = 'candidate-empty';
    await fixture.client.query('BEGIN');
    try {
      await fixture.client.query(`INSERT INTO mdf_evidence_revisions
        (source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key)
        VALUES('bazisCutSet',$1,$2,$3,'manual',1,$4,$4)`,
      [sourceId, revisionKey, 'a'.repeat(64), `request-${sourceId}`]);
      await fixture.client.query(`INSERT INTO mdf_revision_context
        (source_kind,source_id,revision_key,source_created_at,display_name,prior_column,composition_complete,
          demand_digest,acceptance_requested,predecessor_accepted_revision_key,predecessor_received_revision_key,effect_policy)
        VALUES('bazisCutSet',$1,$2,'2026-09-24','empty without intent','parsed',true,$3,true,NULL,NULL,'forward')`,
      [sourceId, revisionKey, 'b'.repeat(64)]);
      await expect(fixture.client.query(`INSERT INTO mdf_bazis_assignment_states
        (source_kind,source_id,revision_key,assignment_state_id,root_intent_id,membership_digest,intentional_empty)
        VALUES('bazisCutSet',$1,$2,$3,$4,$5,true)`,
      [sourceId, revisionKey, randomUUID(), randomUUID(), 'c'.repeat(64)])).rejects.toMatchObject({
        code: '23514', message: expect.stringContaining('root assignment state requires its exact composition intent'),
      });
    } finally {
      await fixture.client.query('ROLLBACK').catch(() => undefined);
    }
    expect((await fixture.client.query('SELECT 1 FROM mdf_bazis_assignment_states WHERE source_id=$1', [sourceId])).rows)
      .toHaveLength(0);
    expect((await fixture.client.query('SELECT 1 FROM mdf_revision_seals WHERE source_id=$1', [sourceId])).rows)
      .toHaveLength(0);
  });

  it('rejects attaching assignment state after a real v2 receipt is sealed', async () => {
    const sourceId = `late-state-${randomUUID()}`;
    const database = fixture.createDatabaseService();
    try {
      const receipt = await database.transaction(tx => recordMdfLineageReceipt(tx, {
        sourceKind: 'bazisCutSet', sourceId, revisionKey: 'sealed-v2', origin: 'manual', actorUserId: 1,
        requestId: `late-state-${sourceId}`, causeKey: `late-state-${sourceId}`, expectedFence: null,
        accept: true, rules: [],
        lines: [
          { lineKey: 'member', orderId: 1, detailId: 11, quantity: 1, stageCode: 'membership', evidenceKind: 'derived', rework: false },
          { lineKey: 'physical', orderId: 1, detailId: 11, quantity: 1, stageCode: 'cut', evidenceKind: 'physical', rework: false },
        ],
        lineage: { operation: 'production', authority: 'manual_production', actions: [{ lineKey: 'physical', action: 'root' }],
          droppedPredecessorEvidenceLineIds: [] },
        executionContext: { sourceCreatedAt: '2026-09-24T00:00:00Z', displayName: 'sealed source', priorColumn: 'parsed',
          compositionComplete: true, demand: [{ orderId: 1, detailId: 11, quantity: 1 }] },
      }));
      expect(receipt.accepted).toBe(true);
      await expect(fixture.client.query(`INSERT INTO mdf_bazis_assignment_states
        (source_kind,source_id,revision_key,assignment_state_id,root_intent_id,membership_digest,intentional_empty)
        VALUES('bazisCutSet',$1,'sealed-v2',$2,$3,$4,false)`,
      [sourceId, randomUUID(), randomUUID(), 'd'.repeat(64)])).rejects.toMatchObject({ code: '55000' });
      expect((await fixture.client.query('SELECT 1 FROM mdf_bazis_assignment_states WHERE source_id=$1', [sourceId])).rows)
        .toHaveLength(0);
    } finally {
      await database.onModuleDestroy();
    }
  });

});
