import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMdfCorrectionPgFixture } from '../../src/modules/mdf-board/adapters/mdf-correction-test-fixture.integration';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';

// This suite exercises the DB-level guards of migration 191 directly. Unlike the
// preceding MDF-source migrations, mdf_position_detachments has no BEFORE INSERT
// guard and no FK to any evidence/receipt table: a confirmed order correction is
// authenticated at the application layer (which also writes the cascade receipt
// that re-freezes demand without the position), not by this table's own insert
// trigger. Here we only prove the table/constraint/immutability shape this
// migration installs, plus its 188 precondition and its conditional redefinition
// of the migration-182 lineage seal guard.
describe.skipIf(!enabled)('MDF order corrections migration 191, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e191ordercorr');

  const BASE_CHAIN = [
    '165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql',
    '174_mdf_execution_context.sql', '178_mdf_correction_receipts.sql',
  ] as const;

  beforeAll(async () => {
    await fixture.connect();
    // 182 is included so the conditional lineage-seal redefinition branch of 191
    // actually executes in this schema (it is a no-op unless
    // mdf_physical_lineage_contracts already exists).
    await fixture.applyMigrations([
      ...BASE_CHAIN,
      '182_mdf_physical_lineage.sql', '188_mdf_order_cascade_intents.sql',
      '191_mdf_order_corrections.sql', '192_mdf_board_presentation_history.sql', '195_mdf_baseline_population.sql',
    ]);
  }, 30000);

  afterAll(async () => fixture.drop());

  let idSeq = 1;
  const nextSourceId = () => `packet:${idSeq++}`;

  async function insertDetachment(opts: {
    sourceKind?: string; sourceId: string; orderId: number; detailId: number;
    correctionId?: string; requestId?: string; actorUserId?: number;
  }) {
    return fixture.client.query(`INSERT INTO mdf_position_detachments
      (source_kind,source_id,order_id,detail_id,correction_id,request_id,actor_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [opts.sourceKind ?? 'packet', opts.sourceId, opts.orderId, opts.detailId,
      opts.correctionId ?? randomUUID(),
      opts.requestId ?? `req-${opts.sourceId}-${opts.orderId}-${opts.detailId}`,
      opts.actorUserId ?? 1]);
  }

  it('applies idempotently and installs the table, cascade-intent columns and immutability trigger', async () => {
    await fixture.applyMigrations(['191_mdf_order_corrections.sql', '192_mdf_board_presentation_history.sql', '195_mdf_baseline_population.sql']);
    await fixture.assertLocalRelations(['mdf_position_detachments']);

    const columns = await fixture.client.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='mdf_order_cascade_intents' AND column_name=ANY($2::text[])
      ORDER BY column_name`, [fixture.schema, ['confirmed', 'preview_digest']]);
    expect(columns.rows.map((row) => row.column_name)).toEqual(['confirmed', 'preview_digest']);

    const functions = await fixture.client.query<{ proname: string }>(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=$1 AND p.proname='mdf_reject_position_detachment_change'`, [fixture.schema]);
    expect(functions.rows.map((row) => row.proname)).toEqual(['mdf_reject_position_detachment_change']);

    const triggers = await fixture.client.query<{ tgname: string; tgenabled: string; function_name: string;
      tgtype: number; tgdeferrable: boolean; tginitdeferred: boolean }>(`
      SELECT t.tgname,t.tgenabled,p.proname AS function_name,t.tgtype::int,t.tgdeferrable,t.tginitdeferred
      FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE n.nspname=$1 AND r.relname='mdf_position_detachments' AND NOT t.tgisinternal ORDER BY t.tgname`,
    [fixture.schema]);
    // Migration 195 adds the statement-level cutover fence to this table (§5.7b).
    expect(triggers.rows.filter(t => t.tgname !== 'mdf_cutover_fence')).toEqual([
      { tgname: 'mdf_position_detachment_immutable', tgenabled: 'O', function_name: 'mdf_reject_position_detachment_change',
        tgtype: 27, tgdeferrable: false, tginitdeferred: false },
    ]);
  });

  it('rejects UPDATE and DELETE on a detachment row as immutable', async () => {
    const sourceId = nextSourceId();
    await fixture.client.query('BEGIN');
    try {
      await expect(insertDetachment({ sourceId, orderId: 9001, detailId: 1 }))
        .resolves.toMatchObject({ rowCount: 1 });
      await fixture.client.query('SAVEPOINT before_update');
      await expect(fixture.client.query(
        `UPDATE mdf_position_detachments SET request_id='changed' WHERE source_id=$1`, [sourceId],
      )).rejects.toMatchObject({ code: '55000', message: expect.stringContaining('immutable') });
      await fixture.client.query('ROLLBACK TO SAVEPOINT before_update');
      await fixture.client.query('SAVEPOINT before_delete');
      await expect(fixture.client.query(
        `DELETE FROM mdf_position_detachments WHERE source_id=$1`, [sourceId],
      )).rejects.toMatchObject({ code: '55000', message: expect.stringContaining('immutable') });
      await fixture.client.query('ROLLBACK TO SAVEPOINT before_delete');
    } finally {
      await fixture.client.query('ROLLBACK');
    }
  });

  it('rejects a second detachment of the same (source_kind, source_id, order_id, detail_id) position', async () => {
    const sourceId = nextSourceId();
    await fixture.client.query('BEGIN');
    try {
      await expect(insertDetachment({ sourceId, orderId: 9002, detailId: 5 }))
        .resolves.toMatchObject({ rowCount: 1 });
      await expect(insertDetachment({
        sourceId, orderId: 9002, detailId: 5,
        correctionId: randomUUID(), requestId: 'a-different-correction', actorUserId: 2,
      })).rejects.toMatchObject({ code: '23505' });
    } finally {
      await fixture.client.query('ROLLBACK');
    }
  });

  it('constrains confirmed/preview_digest with the migration-defined check constraints', async () => {
    const confirmedDigest = await fixture.client.query<{ def: string }>(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid=to_regclass($1) AND conname='mdf_order_cascade_intents_confirmed_digest'`,
    [`${fixture.schema}.mdf_order_cascade_intents`]);
    expect(confirmedDigest.rows).toHaveLength(1);
    expect(confirmedDigest.rows[0]?.def).toContain('confirmed');
    expect(confirmedDigest.rows[0]?.def).toContain('preview_digest IS NOT NULL');

    const previewDigestCheck = await fixture.client.query<{ def: string }>(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid=to_regclass($1) AND contype='c' AND pg_get_constraintdef(oid) LIKE '%preview_digest%~%'`,
    [`${fixture.schema}.mdf_order_cascade_intents`]);
    expect(previewDigestCheck.rows).toHaveLength(1);
    expect(previewDigestCheck.rows[0]?.def).toContain('a-f0-9');
    expect(previewDigestCheck.rows[0]?.def).toContain('{64}');
  });

  it('redefines the migration-182 lineage seal guard to treat a detached position as history only', async () => {
    const def = await fixture.client.query<{ def: string }>(`
      SELECT pg_get_functiondef(oid) AS def FROM pg_proc
      WHERE oid=to_regprocedure($1)`, [`${fixture.schema}.mdf_validate_physical_lineage_seal()`]);
    expect(def.rows).toHaveLength(1);
    expect(def.rows[0]?.def).toContain('mdf_position_detachments');
  });

  it('requires migration 188 (mdf_order_cascade_intents) to be present before it can apply', async () => {
    const bare = createMdfCorrectionPgFixture('e2e191nom188');
    await bare.connect();
    try {
      await bare.applyMigrations([...BASE_CHAIN]);
      await expect(bare.applyMigrations(['191_mdf_order_corrections.sql', '192_mdf_board_presentation_history.sql', '195_mdf_baseline_population.sql']))
        .rejects.toMatchObject({ message: expect.stringContaining('requires migration 188') });
    } finally {
      await bare.drop();
    }
  });
});
