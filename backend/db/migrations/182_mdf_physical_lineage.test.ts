import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMdfCorrectionPgFixture } from '../../src/modules/mdf-board/adapters/mdf-correction-test-fixture.integration';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';

describe.skipIf(!enabled)('MDF physical lineage migration 182, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e182lineage');
  const migration = readFileSync(new URL('./182_mdf_physical_lineage.sql', import.meta.url), 'utf8');

  beforeAll(async () => {
    await fixture.connect();
    await fixture.applyMigrations([
      '165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql', '175_mdf_command_placement.sql',
      '178_mdf_correction_receipts.sql', '182_mdf_physical_lineage.sql',
    ]);
    await fixture.assertLocalRelations([
      'mdf_evidence_revisions', 'mdf_revision_context', 'mdf_revision_seals', 'mdf_source_heads',
      'mdf_evidence_lines', 'mdf_physical_lineage_contracts', 'mdf_physical_lineage_transitions',
    ]);
  }, 30000);

  afterAll(async () => fixture.drop());

  it('fails closed when receipt dependencies are visible only through public', async () => {
    const missingSchema = `e2e182m_${randomUUID().replaceAll('-', '')}`;
    const publicBefore = await fixture.client.query(`SELECT
      to_regclass('public.mdf_physical_lineage_contracts')::text AS contracts,
      to_regclass('public.mdf_physical_lineage_transitions')::text AS transitions,
      to_regclass('public.mdf_source_heads')::text AS heads`);
    await fixture.client.query(`CREATE SCHEMA "${missingSchema}"; SET search_path="${missingSchema}",public`);
    try {
      await expect(fixture.client.query(migration)).rejects.toMatchObject({ code: 'P0001' });
    } finally {
      await fixture.client.query('ROLLBACK');
      await fixture.client.query(`SET search_path="${fixture.schema}",public; DROP SCHEMA "${missingSchema}" CASCADE`);
    }
    const publicAfter = await fixture.client.query(`SELECT
      to_regclass('public.mdf_physical_lineage_contracts')::text AS contracts,
      to_regclass('public.mdf_physical_lineage_transitions')::text AS transitions,
      to_regclass('public.mdf_source_heads')::text AS heads`);
    expect(publicAfter.rows).toEqual(publicBefore.rows);
    expect((await fixture.client.query('SELECT current_schema() AS schema')).rows[0].schema).toBe(fixture.schema);
    expect((await fixture.client.query(`SELECT to_regclass($1) AS relation`,
      [`${missingSchema}.mdf_physical_lineage_contracts`])).rows[0].relation).toBeNull();
  });

  it('fails closed when individual local execution-context or frozen-demand prerequisites are incomplete', async () => {
    const missingLocalPrerequisites: Array<{ sql: string; absent: string }> = [
      { sql: 'DROP TABLE mdf_revision_context CASCADE', absent: 'mdf_revision_context' },
      { sql: 'DROP TABLE mdf_revision_demand CASCADE', absent: 'mdf_revision_demand' },
      { sql: 'ALTER TABLE mdf_revision_context DROP COLUMN effect_policy CASCADE', absent: 'effect_policy' },
      { sql: 'DROP TRIGGER mdf_accepted_revision_guard ON mdf_source_heads', absent: 'mdf_accepted_revision_guard' },
    ];
    for (const item of missingLocalPrerequisites) {
      await fixture.client.query('BEGIN');
      try {
        await fixture.client.query(item.sql);
        await expect(fixture.client.query(migration)).rejects.toMatchObject({ code: 'P0001' });
      } finally {
        await fixture.client.query('ROLLBACK');
      }
      expect(await fixture.client.query('SELECT current_schema() AS schema'))
        .toMatchObject({ rows: [{ schema: fixture.schema }] });
    }
  });

  it('binds lineage rows to local sealed receipts and enables immutable insert/append guards', async () => {
    const relations = ['mdf_physical_lineage_contracts', 'mdf_physical_lineage_transitions'];
    await fixture.assertLocalRelations(relations);
    const constraints = await fixture.client.query<{ table_name: string; conname: string; contype: string; convalidated: boolean }>(`
      SELECT r.relname AS table_name,c.conname,c.contype,c.convalidated
      FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=r.relnamespace
      WHERE n.nspname=$1 AND r.relname=ANY($2::text[])
      ORDER BY r.relname,c.conname`, [fixture.schema, relations]);
    expect(constraints.rows.length).toBeGreaterThanOrEqual(12);
    expect(constraints.rows.every(row => row.convalidated)).toBe(true);
    const foreignKeys = await fixture.client.query<{ table_name: string; referenced_schema: string; referenced_table: string; confdeltype: string }>(`
      SELECT local.relname AS table_name,remote_ns.nspname AS referenced_schema,remote.relname AS referenced_table,c.confdeltype
      FROM pg_constraint c JOIN pg_class local ON local.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=local.relnamespace JOIN pg_class remote ON remote.oid=c.confrelid
      JOIN pg_namespace remote_ns ON remote_ns.oid=remote.relnamespace
      WHERE n.nspname=$1 AND local.relname=ANY($2::text[]) AND c.contype='f'
      ORDER BY local.relname,remote.relname,c.conname`, [fixture.schema, relations]);
    expect(foreignKeys.rows).toEqual([
      { table_name: 'mdf_physical_lineage_contracts', referenced_schema: fixture.schema, referenced_table: 'mdf_revision_context', confdeltype: 'r' },
      { table_name: 'mdf_physical_lineage_contracts', referenced_schema: fixture.schema, referenced_table: 'mdf_revision_seals', confdeltype: 'r' },
      { table_name: 'mdf_physical_lineage_transitions', referenced_schema: fixture.schema, referenced_table: 'mdf_evidence_lines', confdeltype: 'r' },
      { table_name: 'mdf_physical_lineage_transitions', referenced_schema: fixture.schema, referenced_table: 'mdf_evidence_lines', confdeltype: 'r' },
      { table_name: 'mdf_physical_lineage_transitions', referenced_schema: fixture.schema, referenced_table: 'mdf_evidence_lines', confdeltype: 'r' },
      { table_name: 'mdf_physical_lineage_transitions', referenced_schema: fixture.schema, referenced_table: 'mdf_physical_lineage_contracts', confdeltype: 'r' },
    ]);
    const requiredFunctions = [
      'mdf_guard_physical_lineage_insert()', 'mdf_guard_physical_lineage_immutable()',
      'mdf_validate_physical_lineage_seal()', 'mdf_guard_physical_lineage_source_head()',
    ];
    const functions = await fixture.client.query<{ proname: string }>(`SELECT p.proname FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname=ANY($2::text[]) ORDER BY p.proname`,
    [fixture.schema, requiredFunctions.map(name => name.slice(0, -2))]);
    expect(functions.rows.map(row => `${row.proname}()`)).toEqual(requiredFunctions.sort());
    const triggers = await fixture.client.query<{ tgname: string; tgenabled: string }>(`SELECT t.tgname,t.tgenabled
      FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname LIKE 'mdf_physical_lineage_%' AND t.tgrelid=ANY(ARRAY[
        to_regclass($1),to_regclass($2),to_regclass($3),to_regclass($4)]) ORDER BY t.tgname`,
    [`${fixture.schema}.mdf_physical_lineage_contracts`, `${fixture.schema}.mdf_physical_lineage_transitions`,
      `${fixture.schema}.mdf_revision_seals`, `${fixture.schema}.mdf_source_heads`]);
    expect(triggers.rows.map(row => row.tgname)).toEqual([
      'mdf_physical_lineage_contract_immutable', 'mdf_physical_lineage_contract_insert_guard',
      'mdf_physical_lineage_seal_guard', 'mdf_physical_lineage_source_head_guard',
      'mdf_physical_lineage_transition_immutable', 'mdf_physical_lineage_transition_insert_guard',
    ]);
    expect(triggers.rows.every(row => row.tgenabled === 'O')).toBe(true);
  });

  it('keeps the legacy evidence, accepted-revision, and lineage head guards enabled', async () => {
    const v1Objects = await fixture.client.query<{ trigger_count: string; function_count: string }>(`SELECT
      (SELECT count(*)::text FROM pg_trigger t WHERE NOT t.tgisinternal
        AND t.tgrelid=to_regclass($1) AND t.tgname='mdf_line_immutable' AND t.tgenabled='O') AS trigger_count,
      (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=$2 AND p.proname='mdf_reject_evidence_change') AS function_count`,
    [`${fixture.schema}.mdf_evidence_lines`, fixture.schema]);
    expect(v1Objects.rows[0]).toEqual({ trigger_count: '1', function_count: '1' });
    const headGuard = await fixture.client.query<{ tgname: string; tgenabled: string }>(`SELECT tgname,tgenabled FROM pg_trigger
      WHERE NOT tgisinternal AND tgrelid=to_regclass($1) AND tgname='mdf_physical_lineage_source_head_guard'`,
    [`${fixture.schema}.mdf_source_heads`]);
    expect(headGuard.rows).toEqual([{ tgname: 'mdf_physical_lineage_source_head_guard', tgenabled: 'O' }]);
    const acceptedGuard = await fixture.client.query<{ tgname: string; tgenabled: string }>(`SELECT tgname,tgenabled FROM pg_trigger
      WHERE NOT tgisinternal AND tgrelid=to_regclass($1) AND tgname='mdf_accepted_revision_guard'`,
    [`${fixture.schema}.mdf_source_heads`]);
    expect(acceptedGuard.rows).toEqual([{ tgname: 'mdf_accepted_revision_guard', tgenabled: 'O' }]);
  });

  it('rejects a direct SQL production contract without an authority', async () => {
    const sourceId = `missing-authority-${randomUUID()}`;
    await fixture.client.query('BEGIN');
    try {
      await fixture.client.query(`INSERT INTO mdf_evidence_revisions
        (source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key)
        VALUES('bazisCutSet',$1,'1',$2,'manual',158,$3,$4)`,
      [sourceId, 'a'.repeat(64), `request-${sourceId}`, `cause-${sourceId}`]);
      await fixture.client.query(`INSERT INTO mdf_revision_context
        (source_kind,source_id,revision_key,source_created_at,display_name,prior_column,composition_complete,
          demand_digest,acceptance_requested,predecessor_accepted_revision_key,predecessor_received_revision_key,effect_policy)
        VALUES('bazisCutSet',$1,'1','2026-09-01','missing authority','parsed',true,$2,true,NULL,NULL,'forward')`,
      [sourceId, 'b'.repeat(64)]);
      await expect(fixture.client.query(`INSERT INTO mdf_physical_lineage_contracts
        (source_kind,source_id,revision_key,operation,production_authority,predecessor_accepted_revision_key,
          manifest_digest,dropped_predecessor_evidence_line_ids)
        VALUES('bazisCutSet',$1,'1','production',NULL,NULL,$2,ARRAY[]::uuid[])`,
      [sourceId, 'c'.repeat(64)])).rejects.toMatchObject({ code: '23514' });
    } finally {
      await fixture.client.query('ROLLBACK');
    }
  });

});
