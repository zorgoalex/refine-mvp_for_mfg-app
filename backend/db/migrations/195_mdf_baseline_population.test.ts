import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMdfCorrectionPgFixture } from '../../src/modules/mdf-board/adapters/mdf-correction-test-fixture.integration';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';

// This suite exercises the DB-level objects of migration 195 directly:
// (1) mdf_baseline_runs / mdf_baseline_run_items / mdf_baseline_run_preexisting — the
//     baseline population run manifest (append-only rows, guarded status transitions).
// (2) mdf_freeze_guard — the durable cutover freeze singleton: only the baseline
//     runner (mdf.command_writer='mdf.baseline') may change it; DELETE/TRUNCATE are
//     rejected outright, in every session.
// (3) mdf_cutover_fence — a statement-level BEFORE fence installed on every
//     inventory/engine table; checked here on a representative sample
//     (orders, order_details, cnc_telegram_packets, mdf_evidence_revisions) rather
//     than the whole ARRAY, same sampling approach as the ops probe.
// (4) baseline markers (baseline_run_id, closure) + mdf_context_baseline_check on
//     mdf_revision_context (from migration 174), and the legacy-acceptance guard
//     on mdf_source_heads.
// (5) mdf_reset_delete_baseline_rows: the only function that carries a
//     function-level SET session_replication_role = replica (never a runtime
//     SET LOCAL, which would leak the bypass past this single call); its sibling
//     mdf_reset_unactivated_baseline carries no such clause of its own.
describe.skipIf(!enabled)('MDF baseline population migration 195, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e195baseline');
  const BASE_CHAIN = ['165_mdf_engine_foundation.sql', '174_mdf_execution_context.sql'] as const;

  beforeAll(async () => {
    await fixture.connect();
    // Minimal local stand-ins for a representative sample of the fence's table
    // list — just enough for the conditional `to_regclass(...) IS NOT NULL`
    // loop in 195 to find them and attach the trigger.
    await fixture.client.query(`
      CREATE TABLE orders(order_id BIGINT PRIMARY KEY);
      CREATE TABLE order_details(detail_id BIGINT PRIMARY KEY);
      CREATE TABLE cnc_telegram_packets(packet_id UUID PRIMARY KEY DEFAULT gen_random_uuid());`);
    await fixture.applyMigrations([
      ...BASE_CHAIN, '192_mdf_board_presentation_history.sql', '195_mdf_baseline_population.sql',
    ]);
  }, 30000);

  afterAll(async () => fixture.drop());

  it('requires migration 192 (mdf_revision_presentation) to be present before it can apply', async () => {
    const bare = createMdfCorrectionPgFixture('e2e195nom192');
    await bare.connect();
    try {
      await bare.applyMigrations([...BASE_CHAIN]);
      await expect(bare.applyMigrations(['195_mdf_baseline_population.sql']))
        .rejects.toMatchObject({ message: expect.stringContaining('requires migration 192') });
    } finally {
      await bare.drop();
    }
  });

  it('applies idempotently and installs the baseline run manifest tables plus the freeze guard singleton', async () => {
    await fixture.applyMigrations(['195_mdf_baseline_population.sql']);
    await fixture.assertLocalRelations([
      'mdf_baseline_runs', 'mdf_baseline_run_items', 'mdf_baseline_run_preexisting', 'mdf_freeze_guard',
    ]);
    const guardRow = await fixture.client.query<{ n: number }>('SELECT count(*)::int AS n FROM mdf_freeze_guard');
    expect(guardRow.rows[0]?.n).toBe(1);
    const frozen = await fixture.client.query<{ freeze_run_id: string | null }>(
      'SELECT freeze_run_id FROM mdf_freeze_guard');
    expect(frozen.rows).toEqual([{ freeze_run_id: null }]);
  });

  it('rejects a direct DELETE/UPDATE of the freeze guard singleton outside the baseline writer', async () => {
    await expect(fixture.client.query('DELETE FROM mdf_freeze_guard'))
      .rejects.toMatchObject({ code: '55000', message: expect.stringContaining('owned by the baseline run') });
    await expect(fixture.client.query('UPDATE mdf_freeze_guard SET freeze_run_id = NULL'))
      .rejects.toMatchObject({ code: '55000', message: expect.stringContaining('owned by the baseline run') });
    await expect(fixture.client.query('TRUNCATE mdf_freeze_guard'))
      .rejects.toMatchObject({ code: '55000', message: expect.stringContaining('cannot be deleted') });
  });

  it('installs the append-only baseline run manifest guard triggers', async () => {
    const triggers = await fixture.client.query<{
      relname: string; tgname: string; tgenabled: string; function_name: string; tgtype: number;
    }>(`
      SELECT r.relname,t.tgname,t.tgenabled,p.proname AS function_name,t.tgtype::int
      FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE n.nspname=$1 AND r.relname=ANY($2::text[]) AND NOT t.tgisinternal ORDER BY r.relname, t.tgname`,
    [fixture.schema, ['mdf_baseline_runs', 'mdf_baseline_run_items', 'mdf_baseline_run_preexisting', 'mdf_freeze_guard']]);
    expect(triggers.rows).toEqual([
      { relname: 'mdf_baseline_run_items', tgname: 'mdf_baseline_item_guard', tgenabled: 'O',
        function_name: 'mdf_guard_baseline_append_only', tgtype: 31 },
      { relname: 'mdf_baseline_run_preexisting', tgname: 'mdf_baseline_preexisting_guard', tgenabled: 'O',
        function_name: 'mdf_guard_baseline_append_only', tgtype: 31 },
      { relname: 'mdf_baseline_runs', tgname: 'mdf_baseline_run_guard', tgenabled: 'O',
        function_name: 'mdf_guard_baseline_run', tgtype: 31 },
      { relname: 'mdf_freeze_guard', tgname: 'mdf_freeze_guard_row', tgenabled: 'O',
        function_name: 'mdf_guard_freeze_guard', tgtype: 27 },
      { relname: 'mdf_freeze_guard', tgname: 'mdf_freeze_guard_truncate', tgenabled: 'O',
        function_name: 'mdf_guard_freeze_guard', tgtype: 34 },
    ]);
  });

  it('installs a statement-level cutover fence on the representative inventory/engine tables and permits ordinary writes while unfrozen', async () => {
    const triggers = await fixture.client.query<{ relname: string; tgenabled: string; tgtype: number }>(`
      SELECT r.relname,t.tgenabled,t.tgtype::int
      FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace
      WHERE n.nspname=$1 AND t.tgname='mdf_cutover_fence' AND NOT t.tgisinternal ORDER BY r.relname`,
    [fixture.schema]);
    expect(triggers.rows).toEqual([
      { relname: 'cnc_telegram_packets', tgenabled: 'O', tgtype: 62 },
      { relname: 'mdf_evidence_revisions', tgenabled: 'O', tgtype: 62 },
      { relname: 'order_details', tgenabled: 'O', tgtype: 62 },
      { relname: 'orders', tgenabled: 'O', tgtype: 62 },
    ]);
    // Unfrozen (freeze_run_id IS NULL): the fence's advisory lock always succeeds and the
    // freeze check is bypassed, so an ordinary write is not blocked by 195 itself.
    await expect(fixture.client.query('INSERT INTO orders(order_id) VALUES(1)'))
      .resolves.toMatchObject({ rowCount: 1 });
    await fixture.client.query('DELETE FROM orders');
  });

  it('adds the baseline markers and check constraint on mdf_revision_context, and the legacy-acceptance guard on mdf_source_heads', async () => {
    const columns = await fixture.client.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='mdf_revision_context' AND column_name=ANY($2::text[])
      ORDER BY column_name`, [fixture.schema, ['baseline_run_id', 'closure']]);
    expect(columns.rows.map((row) => row.column_name)).toEqual(['baseline_run_id', 'closure']);

    const constraint = await fixture.client.query<{ conname: string }>(`
      SELECT conname FROM pg_constraint
      WHERE conrelid=to_regclass($1) AND conname='mdf_context_baseline_check'`,
    [`${fixture.schema}.mdf_revision_context`]);
    expect(constraint.rows).toHaveLength(1);

    const trigger = await fixture.client.query<{ tgname: string; function_name: string; tgtype: number }>(`
      SELECT t.tgname,p.proname AS function_name,t.tgtype::int
      FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE n.nspname=$1 AND r.relname='mdf_source_heads' AND t.tgname='mdf_legacy_acceptance_guard' AND NOT t.tgisinternal`,
    [fixture.schema]);
    expect(trigger.rows).toEqual([
      { tgname: 'mdf_legacy_acceptance_guard', function_name: 'mdf_guard_legacy_acceptance', tgtype: 23 },
    ]);
  });

  it('runs mdf_reset_delete_baseline_rows with a function-level SET session_replication_role = replica only, never SET LOCAL', async () => {
    const deleteDef = await fixture.client.query<{ def: string }>(
      `SELECT pg_get_functiondef(oid) AS def FROM pg_proc WHERE oid=to_regprocedure($1)`,
      [`${fixture.schema}.mdf_reset_delete_baseline_rows(uuid)`]);
    expect(deleteDef.rows).toHaveLength(1);
    expect(deleteDef.rows[0]?.def).toMatch(/SET session_replication_role TO 'replica'/);
    expect(deleteDef.rows[0]?.def).not.toContain('SET LOCAL session_replication_role');

    const resetDef = await fixture.client.query<{ def: string }>(
      `SELECT pg_get_functiondef(oid) AS def FROM pg_proc WHERE oid=to_regprocedure($1)`,
      [`${fixture.schema}.mdf_reset_unactivated_baseline(uuid)`]);
    expect(resetDef.rows).toHaveLength(1);
    expect(resetDef.rows[0]?.def).not.toContain('session_replication_role');

    const grants = await fixture.client.query<{ has_delete: boolean; has_reset: boolean }>(
      `SELECT has_function_privilege('public', $1, 'EXECUTE') AS has_delete,
              has_function_privilege('public', $2, 'EXECUTE') AS has_reset`,
      [`${fixture.schema}.mdf_reset_delete_baseline_rows(uuid)`, `${fixture.schema}.mdf_reset_unactivated_baseline(uuid)`]);
    expect(grants.rows[0]).toEqual({ has_delete: false, has_reset: false });
  });
});
