import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMdfCorrectionPgFixture } from '../../src/modules/mdf-board/adapters/mdf-correction-test-fixture.integration';
import { parseMdfPlacementInputs } from '../../src/modules/mdf-board/domain/mdf-placement';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';

// This suite exercises the DB-level effect of migration 189 directly: the new
// placement_inputs column + its object-shape CHECK on mdf_published_sources, and
// the mdf_placement_inputs_valid(jsonb,bigint) function that mirrors
// parseMdfPlacementInputs (domain/mdf-placement.ts). Only the minimal 165/166/174
// chain is applied: 189's own DO-block guard only requires mdf_published_sources
// (migration 174), not the bazis/cascade stack that 185/187/188 need.
describe.skipIf(!enabled)('MDF placement inputs migration 189, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e189placement');
  const digest = (ch: string) => ch.repeat(64);

  beforeAll(async () => {
    await fixture.connect();
    await fixture.applyMigrations([
      '165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql', '189_mdf_placement_inputs.sql',
    ]);
  }, 30000);

  afterAll(async () => fixture.drop());

  async function seedPublishedSource(sourceId: string, revisionKey: string) {
    await fixture.client.query(`INSERT INTO mdf_evidence_revisions
      (source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key)
      VALUES('bath',$1,$2,$3,'manual',1,$4,$4)`,
    [sourceId, revisionKey, digest('a'), `req-${sourceId}`]);
    await fixture.client.query(`INSERT INTO mdf_revision_seals(source_kind,source_id,revision_key) VALUES('bath',$1,$2)`,
    [sourceId, revisionKey]);
    await fixture.client.query(`INSERT INTO mdf_source_heads(source_kind,source_id,received_revision_key,accepted_revision_key)
      VALUES('bath',$1,$2,$2)`, [sourceId, revisionKey]);
    await fixture.client.query(`INSERT INTO mdf_published_sources
      (source_kind,source_id,received_revision_key,accepted_revision_key,source_created_at,display_name,
        column_key,reason,issues,published_revision)
      VALUES('bath',$1,$2,$2,now(),'card',NULL,'requires_verification','{}',7)`, [sourceId, revisionKey]);
  }

  it('applies idempotently; column, constraint and function are present', async () => {
    await fixture.applyMigrations(['189_mdf_placement_inputs.sql']);
    await fixture.assertLocalRelations(['mdf_published_sources']);
    const column = await fixture.client.query<{ present: boolean }>(`SELECT COALESCE(
      (SELECT data_type='jsonb' FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='mdf_published_sources' AND column_name='placement_inputs'), false) AS present`,
    [fixture.schema]);
    expect(column.rows).toEqual([{ present: true }]);

    const constraint = await fixture.client.query<{ present: boolean }>(`SELECT EXISTS(
      SELECT 1 FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
      WHERE n.nspname=$1 AND r.relname='mdf_published_sources'
        AND c.conname='mdf_published_sources_placement_inputs_object' AND c.contype='c' AND c.convalidated) AS present`,
    [fixture.schema]);
    expect(constraint.rows).toEqual([{ present: true }]);

    const fn = await fixture.client.query<{ present: boolean }>(`SELECT EXISTS(
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=$1 AND p.proname='mdf_placement_inputs_valid'
        AND pg_get_function_identity_arguments(p.oid)='inputs jsonb, published_revision bigint') AS present`,
    [fixture.schema]);
    expect(fn.rows).toEqual([{ present: true }]);
  });

  it('CHECK rejects a non-object placement_inputs and accepts NULL/object', async () => {
    const sourceId = `chk-${randomUUID()}`;
    await fixture.client.query('BEGIN');
    try {
      await seedPublishedSource(sourceId, 'r1');

      await fixture.client.query('SAVEPOINT before_array');
      await expect(fixture.client.query(`UPDATE mdf_published_sources SET placement_inputs='[]'::jsonb WHERE source_id=$1`,
        [sourceId])).rejects.toMatchObject({ code: '23514' });
      await fixture.client.query('ROLLBACK TO SAVEPOINT before_array');

      await fixture.client.query('SAVEPOINT before_string');
      await expect(fixture.client.query(`UPDATE mdf_published_sources SET placement_inputs='"x"'::jsonb WHERE source_id=$1`,
        [sourceId])).rejects.toMatchObject({ code: '23514' });
      await fixture.client.query('ROLLBACK TO SAVEPOINT before_string');

      await expect(fixture.client.query(`UPDATE mdf_published_sources SET placement_inputs=NULL WHERE source_id=$1`,
        [sourceId])).resolves.toMatchObject({ rowCount: 1 });
      await expect(fixture.client.query(`UPDATE mdf_published_sources SET placement_inputs='{"a":1}'::jsonb WHERE source_id=$1`,
        [sourceId])).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await fixture.client.query('ROLLBACK');
    }
  });

  // SQL/TS parity: mdf_placement_inputs_valid must agree with parseMdfPlacementInputs
  // (domain/mdf-placement.ts) on every case, never just coincidentally matching.
  const BASE: Record<string, unknown> = {
    schemaVersion: 1, publishedRevision: '7', kind: 'bath', verified: true, intentionalEmpty: false,
    manual: null, fullCut: true, fullRolled: false, balanceBlocked: false, bathReadiness: 'ready', priorColumn: 'baths',
  };
  const withOverride = (overrides: Record<string, unknown>) => ({ ...BASE, ...overrides });
  const withoutKey = (key: string) => {
    const clone = { ...BASE };
    delete clone[key];
    return clone;
  };
  const booleanFields = ['verified', 'intentionalEmpty', 'fullCut', 'fullRolled', 'balanceBlocked'] as const;

  interface Case { name: string; value: unknown; revision: string; expected: boolean }
  const cases: Case[] = [
    { name: 'base', value: BASE, revision: '7', expected: true },
    { name: 'base with revision arg 8 (mismatch)', value: BASE, revision: '8', expected: false },
    { name: 'NULL', value: null, revision: '7', expected: false },
    { name: 'empty object', value: {}, revision: '7', expected: false },
    { name: 'schemaVersion 2', value: withOverride({ schemaVersion: 2 }), revision: '7', expected: false },
    { name: "schemaVersion '1' (string)", value: withOverride({ schemaVersion: '1' }), revision: '7', expected: false },
    { name: 'missing schemaVersion', value: withoutKey('schemaVersion'), revision: '7', expected: false },
    { name: 'publishedRevision 7 (number)', value: withOverride({ publishedRevision: 7 }), revision: '7', expected: false },
    { name: "publishedRevision '0'", value: withOverride({ publishedRevision: '0' }), revision: '7', expected: false },
    { name: "publishedRevision 'x'", value: withOverride({ publishedRevision: 'x' }), revision: '7', expected: false },
    { name: 'missing publishedRevision', value: withoutKey('publishedRevision'), revision: '7', expected: false },
    { name: "kind 'order'", value: withOverride({ kind: 'order' }), revision: '7', expected: false },
    ...booleanFields.map((field) => ({
      name: `${field} as string 'true'`, value: withOverride({ [field]: 'true' }), revision: '7', expected: false,
    })),
    ...booleanFields.map((field) => ({
      name: `missing ${field}`, value: withoutKey(field), revision: '7', expected: false,
    })),
    { name: "bathReadiness 'soon'", value: withOverride({ bathReadiness: 'soon' }), revision: '7', expected: false },
    { name: "manual 'completed'", value: withOverride({ manual: 'completed' }), revision: '7', expected: true },
    { name: "manual 'nope'", value: withOverride({ manual: 'nope' }), revision: '7', expected: false },
    { name: 'manual missing', value: withoutKey('manual'), revision: '7', expected: false },
    { name: 'priorColumn null', value: withOverride({ priorColumn: null }), revision: '7', expected: true },
    { name: "priorColumn 'weird'", value: withOverride({ priorColumn: 'weird' }), revision: '7', expected: false },
    { name: "extra key 'x':1", value: withOverride({ x: 1 }), revision: '7', expected: false },
  ];

  async function sqlValid(value: unknown, revision: string): Promise<boolean> {
    const param = value === null ? null : JSON.stringify(value);
    const result = await fixture.client.query<{ valid: boolean }>(
      `SELECT mdf_placement_inputs_valid($1::jsonb,$2::bigint) AS valid`, [param, revision]);
    return result.rows[0]?.valid === true;
  }

  it.each(cases)('SQL/TS parity: $name', async ({ value, revision, expected }) => {
    const sqlResult = await sqlValid(value, revision);
    const tsResult = parseMdfPlacementInputs(value, revision) !== null;
    expect({ sqlResult, tsResult }).toEqual({ sqlResult: expected, tsResult: expected });
  });
});
