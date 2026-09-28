import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMdfCorrectionPgFixture } from '../../src/modules/mdf-board/adapters/mdf-correction-test-fixture.integration';
import {
  CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE,
  CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE,
} from '../../src/shared/cnc-material';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';

// This suite exercises the DB-level objects of migration 199 directly, at the level of migration 195's own
// test file (backend/db/migrations/195_mdf_baseline_population.test.ts):
// (1) the RECOVERY freeze columns on mdf_freeze_guard + mdf_recovery_owned() + the baseline/recovery
//     ownership split enforced by 199's redefined mdf_guard_freeze_guard().
// (2) mdf_cutover_fence, redefined by 199 to also reject every write while recovery_frozen_at IS NOT NULL
//     (except the recovery writer itself), checked on the same representative sample as 195's own test.
// (3) mdf_demand_drift_conflicts: table shape, the (source,predecessor,live digest) upsert-not-duplicate
//     unique constraint, and its own mdf_cutover_fence trigger.
// (4) the catalog classification guard on sheet_material_types/materials (active/read_only only), built here
//     against a minimal local mdf_evidence_lines/mdf_source_heads membership row (no application layer).
// (5) a static parity check: mdf_material_is_mdf()'s two regexes are byte-identical to the shared TS source
//     constants used everywhere else in the codebase for the same classification.
describe.skipIf(!enabled)('MDF cutover controls migration 199, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e198controls');
  // NOTE (production bug found while writing this test): 195_mdf_baseline_population.sql's own CHECK constraint
  // (mdf_context_baseline_check, line ~122-126) references mdf_revision_context.effect_policy, a column added by
  // 178_mdf_correction_receipts.sql — NOT by 174. 195 declares no dependency guard on 178 (only on 192), so applying
  // it after just 165+174+192 fails with "column effect_policy does not exist". The pre-existing sibling test
  // backend/db/migrations/195_mdf_baseline_population.test.ts uses exactly that (165,174,192,195) chain and
  // currently fails the same way when actually run with MDF_ENGINE_INTEGRATION=1 (reproduced; not fixed here — it
  // is out of this task's edit scope). 178 is included here so migration 199 (which requires 195) can be tested.
  const BASE_CHAIN = ['165_mdf_engine_foundation.sql', '174_mdf_execution_context.sql', '178_mdf_correction_receipts.sql'] as const;

  beforeAll(async () => {
    await fixture.connect();
    // Minimal local stand-ins for the fence's representative sample, plus materials/sheet_material_types/
    // order_details/users for the catalog guard.
    await fixture.client.query(`
      CREATE TABLE orders(order_id BIGINT PRIMARY KEY);
      CREATE TABLE order_details(detail_id BIGINT PRIMARY KEY,order_id BIGINT NOT NULL,
        material_id BIGINT,sheet_material_type_id BIGINT,delete_flag BOOLEAN NOT NULL DEFAULT false);
      CREATE TABLE cnc_telegram_packets(packet_id UUID PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE materials(material_id BIGINT PRIMARY KEY,material_name TEXT);
      CREATE TABLE sheet_material_types(sheet_material_type_id BIGINT PRIMARY KEY,name TEXT);
      CREATE TABLE users(user_id BIGINT PRIMARY KEY);`);
    await fixture.applyMigrations([
      ...BASE_CHAIN, '192_mdf_board_presentation_history.sql', '195_mdf_baseline_population.sql',
      '199_mdf_cutover_controls.sql',
    ]);
  }, 30000);

  afterAll(async () => fixture.drop());

  it('requires migration 195 (mdf_freeze_guard) to be present before it can apply', async () => {
    const bare = createMdfCorrectionPgFixture('e2e198nom195');
    await bare.connect();
    try {
      await bare.applyMigrations([...BASE_CHAIN]);
      await expect(bare.applyMigrations(['199_mdf_cutover_controls.sql']))
        .rejects.toMatchObject({ message: expect.stringContaining('requires migration 195') });
    } finally {
      await bare.drop();
    }
  });

  it('applies idempotently and adds the recovery freeze columns, unset by default', async () => {
    await fixture.applyMigrations(['199_mdf_cutover_controls.sql']);
    const columns = await fixture.client.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='mdf_freeze_guard' AND column_name=ANY($2::text[])
      ORDER BY column_name`, [fixture.schema, ['recovery_frozen_at', 'recovery_reason']]);
    expect(columns.rows.map(r => r.column_name)).toEqual(['recovery_frozen_at', 'recovery_reason']);
    const row = await fixture.client.query<{ recovery_frozen_at: string | null; recovery_reason: string | null }>(
      'SELECT recovery_frozen_at,recovery_reason FROM mdf_freeze_guard');
    expect(row.rows).toEqual([{ recovery_frozen_at: null, recovery_reason: null }]);
    const fn = await fixture.client.query<{ ok: boolean }>(
      `SELECT to_regprocedure($1) IS NOT NULL ok`, [`${fixture.schema}.mdf_recovery_owned()`]);
    expect(fn.rows[0].ok).toBe(true);
  });

  it('installs mdf_engine_state.mode_changed_at + a BEFORE UPDATE ROW trigger that stamps ONLY real mode changes, monotonically, untouchable by any other writer', async () => {
    // The trigger installs as BEFORE UPDATE FOR EACH ROW (tgtype bitmask: BEFORE(2)+ROW(1)+UPDATE(16)=19), enabled.
    const trig = await fixture.client.query<{ tgtype: number; tgenabled: string }>(`
      SELECT t.tgtype::int,t.tgenabled FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace
      WHERE n.nspname=$1 AND r.relname='mdf_engine_state' AND t.tgname='mdf_mode_changed_at_stamp' AND NOT t.tgisinternal`,
    [fixture.schema]);
    expect(trig.rows).toEqual([{ tgtype: 19, tgenabled: 'O' }]);

    const before = (await fixture.client.query<{ t: string }>(
      'SELECT mode_changed_at::text t FROM mdf_engine_state')).rows[0].t;

    // A real mode change moves mode_changed_at forward. `pg_sleep` guards against two statements landing on the
    // same clock_timestamp() microsecond.
    await fixture.client.query('SELECT pg_sleep(0.02)');
    await fixture.client.query("UPDATE mdf_engine_state SET mode='shadow' WHERE singleton");
    const afterModeChange = (await fixture.client.query<{ t: string }>(
      'SELECT mode_changed_at::text t FROM mdf_engine_state')).rows[0].t;
    expect(new Date(afterModeChange).getTime()).toBeGreaterThan(new Date(before).getTime());

    // A publication-shaped write (published_revision/updated_at, no mode change) leaves mode_changed_at unchanged —
    // the exact R4 regression this column exists to close (a publication can no longer move the fence backward).
    await fixture.client.query('UPDATE mdf_engine_state SET published_revision=published_revision+1,updated_at=now() WHERE singleton');
    const afterPublish = (await fixture.client.query<{ t: string }>(
      'SELECT mode_changed_at::text t FROM mdf_engine_state')).rows[0].t;
    expect(afterPublish).toBe(afterModeChange);

    // An explicit direct write to mode_changed_at itself, with no mode change, is overridden back to OLD: no writer
    // (not even one addressing the column by name) can move it except via a real mode change.
    await fixture.client.query("UPDATE mdf_engine_state SET mode_changed_at='2000-01-01' WHERE singleton");
    const afterDirectSet = (await fixture.client.query<{ t: string }>(
      'SELECT mode_changed_at::text t FROM mdf_engine_state')).rows[0].t;
    expect(afterDirectSet).toBe(afterModeChange);

    // Never moves backward: NEW.mode_changed_at := GREATEST(OLD.mode_changed_at, clock_timestamp()). Real clock
    // skew cannot be produced in a test, so this disables the trigger to force OLD.mode_changed_at into the future,
    // re-enables it, then performs a REAL mode change: GREATEST must keep the future OLD value, not regress to
    // clock_timestamp().
    await fixture.client.query('ALTER TABLE mdf_engine_state DISABLE TRIGGER mdf_mode_changed_at_stamp');
    const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    await fixture.client.query('UPDATE mdf_engine_state SET mode_changed_at=$1 WHERE singleton', [future]);
    await fixture.client.query('ALTER TABLE mdf_engine_state ENABLE TRIGGER mdf_mode_changed_at_stamp');
    await fixture.client.query("UPDATE mdf_engine_state SET mode='legacy' WHERE singleton");
    const afterFutureModeChange = (await fixture.client.query<{ t: string }>(
      'SELECT mode_changed_at::text t FROM mdf_engine_state')).rows[0].t;
    expect(new Date(afterFutureModeChange).getTime()).toBe(new Date(future).getTime());

    // Restore a sane state (mode back to its pre-test default; mode_changed_at back to now) so it never leaks into
    // a later test in this file.
    await fixture.client.query('ALTER TABLE mdf_engine_state DISABLE TRIGGER mdf_mode_changed_at_stamp');
    await fixture.client.query("UPDATE mdf_engine_state SET mode='legacy',mode_changed_at=now() WHERE singleton");
    await fixture.client.query('ALTER TABLE mdf_engine_state ENABLE TRIGGER mdf_mode_changed_at_stamp');
  });

  /** `set_config(...,false)` (session-level, not transaction-local) is required here: each bare `fixture.client.query()`
   * call below is its own implicit (autocommit) transaction, so a transaction-local tag would not survive to the
   * next statement (same gotcha as `mdf-baseline-runner.integration.test.ts`'s `seedHandCraftedClosedOrder`). Every
   * test that sets it resets it to '' when done, so it never leaks into the next test. */
  const setWriter = (writer: string) => fixture.client.query("SELECT set_config('mdf.command_writer',$1,false)", [writer]);
  const clearWriter = () => setWriter('');

  it('rejects a non-empty recovery_reason shorter than 1 or longer than 500 characters', async () => {
    await setWriter('mdf.recovery');
    try {
      await expect(fixture.client.query("UPDATE mdf_freeze_guard SET recovery_frozen_at=now(),recovery_reason=''"))
        .rejects.toMatchObject({ code: '23514' });
      await expect(fixture.client.query('UPDATE mdf_freeze_guard SET recovery_frozen_at=now(),recovery_reason=$1',
        ['x'.repeat(501)])).rejects.toMatchObject({ code: '23514' });
      // A valid reason from the recovery writer succeeds; clean up afterwards.
      await fixture.client.query("UPDATE mdf_freeze_guard SET recovery_frozen_at=now(),recovery_reason='E2E migration test'");
      await fixture.client.query('UPDATE mdf_freeze_guard SET recovery_frozen_at=NULL,recovery_reason=NULL');
    } finally { await clearWriter(); }
  });

  it('the baseline writer cannot touch the recovery columns; the recovery writer cannot touch the baseline freeze; neither can write with no writer tag at all', async () => {
    await expect(fixture.client.query('UPDATE mdf_freeze_guard SET recovery_frozen_at=now(),recovery_reason=$1', ['E2E no writer']))
      .rejects.toMatchObject({ code: '55000', message: expect.stringContaining('owned by the baseline run') });
    try {
      await setWriter('mdf.baseline');
      await expect(fixture.client.query('UPDATE mdf_freeze_guard SET recovery_frozen_at=now(),recovery_reason=$1', ['E2E baseline writer']))
        .rejects.toMatchObject({ code: '55000', message: expect.stringContaining('owned by the recovery command') });
      await setWriter('mdf.recovery');
      await expect(fixture.client.query('UPDATE mdf_freeze_guard SET freeze_run_id=gen_random_uuid()'))
        .rejects.toMatchObject({ code: '55000', message: expect.stringContaining('owned by the baseline run') });
    } finally { await clearWriter(); }
  });

  it('the redefined mdf_cutover_fence still installs on the representative fenced tables and now also rejects writes during a recovery freeze', async () => {
    const triggers = await fixture.client.query<{ relname: string; tgenabled: string; tgtype: number }>(`
      SELECT r.relname,t.tgenabled,t.tgtype::int
      FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace
      WHERE n.nspname=$1 AND t.tgname='mdf_cutover_fence' AND NOT t.tgisinternal ORDER BY r.relname`,
    [fixture.schema]);
    expect(triggers.rows.map(r => r.relname)).toEqual(expect.arrayContaining(['orders', 'order_details', 'cnc_telegram_packets',
      'materials', 'sheet_material_types', 'mdf_evidence_revisions']));
    for (const row of triggers.rows) expect(row).toMatchObject({ tgenabled: 'O', tgtype: 62 });

    // Unfrozen: an ordinary write succeeds.
    await expect(fixture.client.query('INSERT INTO orders(order_id) VALUES(1)')).resolves.toMatchObject({ rowCount: 1 });

    // Recovery-frozen: even a table untouched by the baseline freeze (materials) is rejected for a non-recovery writer.
    await setWriter('mdf.recovery');
    await fixture.client.query("UPDATE mdf_freeze_guard SET recovery_frozen_at=now(),recovery_reason='E2E fence test'");
    try {
      await clearWriter();
      await expect(fixture.client.query('INSERT INTO materials(material_id) VALUES(1)'))
        .rejects.toMatchObject({ code: '55P03', message: expect.stringContaining('MDF_RECOVERY_FREEZE') });
      await expect(fixture.client.query('UPDATE orders SET order_id=order_id WHERE order_id=1'))
        .rejects.toMatchObject({ code: '55P03', message: expect.stringContaining('MDF_RECOVERY_FREEZE') });
      // Even the baseline writer is rejected during a RECOVERY freeze (only the recovery writer is admitted).
      await setWriter('mdf.baseline');
      await expect(fixture.client.query('INSERT INTO materials(material_id) VALUES(2)'))
        .rejects.toMatchObject({ code: '55P03', message: expect.stringContaining('MDF_RECOVERY_FREEZE') });
      // The recovery writer itself is admitted.
      await setWriter('mdf.recovery');
      await expect(fixture.client.query('INSERT INTO materials(material_id) VALUES(3)')).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await setWriter('mdf.recovery');
      await fixture.client.query('UPDATE mdf_freeze_guard SET recovery_frozen_at=NULL,recovery_reason=NULL');
      await clearWriter();
    }
    await fixture.client.query('DELETE FROM orders; DELETE FROM materials');
  });

  it('installs mdf_demand_drift_conflicts with its upsert-not-duplicate unique constraint and its own cutover fence', async () => {
    await fixture.assertLocalRelations(['mdf_demand_drift_conflicts']);
    const columns = await fixture.client.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='mdf_demand_drift_conflicts' ORDER BY column_name`, [fixture.schema]);
    expect(columns.rows.map(r => r.column_name).sort()).toEqual([
      'code', 'conflict_id', 'detected_at', 'detected_request_id', 'frozen_demand_digest', 'live_demand_digest',
      'owner_ids', 'predecessor_revision_key', 'resolved_at', 'resolved_by_user_id', 'resolved_request_id',
      'source_id', 'source_kind', 'status',
    ].sort());
    await setWriter('mdf.recovery');
    const digest = 'a'.repeat(64);
    const row = await fixture.client.query<{ conflict_id: string }>(`INSERT INTO mdf_demand_drift_conflicts
      (source_kind,source_id,predecessor_revision_key,frozen_demand_digest,live_demand_digest,owner_ids,code,detected_request_id)
      VALUES('packet','e2e-conflict-1','rev-1',$1,$1,ARRAY[1]::bigint[],'CONFIRMATION_REQUIRED','E2E migration test')
      RETURNING conflict_id::text`, [digest]);
    expect(row.rows).toHaveLength(1);
    // Re-inserting the SAME (source,predecessor,live digest) upserts (does nothing / no duplicate row).
    const again = await fixture.client.query<{ n: string }>(`INSERT INTO mdf_demand_drift_conflicts
      (source_kind,source_id,predecessor_revision_key,frozen_demand_digest,live_demand_digest,owner_ids,code,detected_request_id)
      VALUES('packet','e2e-conflict-1','rev-1',$1,$1,ARRAY[1]::bigint[],'CONFIRMATION_REQUIRED','E2E migration test 2')
      ON CONFLICT (source_kind,source_id,predecessor_revision_key,live_demand_digest) DO NOTHING
      RETURNING 1`, [digest]);
    expect(again.rows).toHaveLength(0);
    const count = await fixture.client.query<{ n: string }>(`SELECT count(*)::text n FROM mdf_demand_drift_conflicts`);
    expect(count.rows[0].n).toBe('1');
    // An invalid code is rejected.
    await expect(fixture.client.query(`INSERT INTO mdf_demand_drift_conflicts
      (source_kind,source_id,predecessor_revision_key,frozen_demand_digest,live_demand_digest,owner_ids,code,detected_request_id)
      VALUES('packet','e2e-conflict-2','rev-1',$1,$1,ARRAY[1]::bigint[],'NOT_A_REAL_CODE','E2E migration test')`, [digest]))
      .rejects.toMatchObject({ code: '23514' });

    // The table carries its own mdf_cutover_fence: during a recovery freeze, even this table's own writer tag alone
    // does not admit it (only 'mdf.recovery' does).
    await fixture.client.query("UPDATE mdf_freeze_guard SET recovery_frozen_at=now(),recovery_reason='E2E conflicts fence'");
    try {
      await setWriter('mdf.demand_reconcile');
      await expect(fixture.client.query(`UPDATE mdf_demand_drift_conflicts SET status='resolved',resolved_at=now() WHERE conflict_id=$1`,
        [row.rows[0].conflict_id])).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await setWriter('mdf.recovery');
      await fixture.client.query('UPDATE mdf_freeze_guard SET recovery_frozen_at=NULL,recovery_reason=NULL');
      await clearWriter();
    }
    await fixture.client.query('DELETE FROM mdf_demand_drift_conflicts');
  });

  it('the catalog classification guard refuses a rename that removes MDF classification from a member of an accepted source, in active/read_only only', async () => {
    await setWriter('mdf.recovery');
    // Detail 1001 is a member classified via sheet_material_type_id (type 1); detail 1002 is a SEPARATE member
    // classified via material_id ONLY (no sheet_material_type_id) — the materials-path guard explicitly excludes
    // any detail that has a sheet_material_type_id link, so the two paths need their own, disjoint details.
    await fixture.client.query(`INSERT INTO orders(order_id) VALUES(101);
      INSERT INTO order_details(detail_id,order_id,sheet_material_type_id) VALUES(1001,101,1);
      INSERT INTO order_details(detail_id,order_id,material_id) VALUES(1002,101,1);
      INSERT INTO sheet_material_types(sheet_material_type_id,name) VALUES(1,'МДФ тест миграции');
      INSERT INTO materials(material_id,material_name) VALUES(1,'МДФ материал миграции');`);
    // A minimal accepted-revision membership line (raw rows, no application layer): the guard only needs a row
    // in mdf_evidence_lines(stage_code='membership') whose revision_key equals the source head's accepted key.
    // Inlined literal (no $-params): this is a multi-statement simple-query call, which node-pg only allows
    // without a params array.
    await fixture.client.query(`
      INSERT INTO mdf_evidence_revisions(source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key)
        VALUES('packet','e2e-198-member','r1','${'b'.repeat(64)}','manual',1,'E2E migration','E2E migration');
      INSERT INTO mdf_evidence_lines(source_kind,source_id,revision_key,line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework)
        VALUES('packet','e2e-198-member','r1','member',101,1001,5,'membership','derived',false);
      INSERT INTO mdf_revision_seals(source_kind,source_id,revision_key) VALUES('packet','e2e-198-member','r1');
      INSERT INTO mdf_source_heads(source_kind,source_id,received_revision_key,accepted_revision_key)
        VALUES('packet','e2e-198-member','r1','r1');
      INSERT INTO mdf_evidence_revisions(source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key)
        VALUES('packet','e2e-198-member-2','r1','${'c'.repeat(64)}','manual',1,'E2E migration','E2E migration');
      INSERT INTO mdf_evidence_lines(source_kind,source_id,revision_key,line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework)
        VALUES('packet','e2e-198-member-2','r1','member',101,1002,5,'membership','derived',false);
      INSERT INTO mdf_revision_seals(source_kind,source_id,revision_key) VALUES('packet','e2e-198-member-2','r1');
      INSERT INTO mdf_source_heads(source_kind,source_id,received_revision_key,accepted_revision_key)
        VALUES('packet','e2e-198-member-2','r1','r1');`);
    await clearWriter();

    await fixture.client.query("UPDATE mdf_engine_state SET mode='active'");
    await expect(fixture.client.query(`UPDATE sheet_material_types SET name='ЛДСП тест миграции' WHERE sheet_material_type_id=1`))
      .rejects.toMatchObject({ code: '23514', message: expect.stringContaining('MDF_CATALOG_CHANGE_AFFECTS_PRODUCTION') });
    await expect(fixture.client.query(`UPDATE materials SET material_name='ЛДСП материал миграции' WHERE material_id=1`))
      .rejects.toMatchObject({ code: '23514', message: expect.stringContaining('MDF_CATALOG_CHANGE_AFFECTS_PRODUCTION') });

    // A rename that keeps MDF classification, or a rename of a non-member row, is allowed.
    await expect(fixture.client.query(`UPDATE sheet_material_types SET name='МДФ тест миграции премиум' WHERE sheet_material_type_id=1`))
      .resolves.toMatchObject({ rowCount: 1 });

    // In legacy mode the same removal is allowed (the guard only applies in active/read_only).
    await fixture.client.query("UPDATE mdf_engine_state SET mode='legacy'");
    await expect(fixture.client.query(`UPDATE sheet_material_types SET name='ЛДСП тест миграции' WHERE sheet_material_type_id=1`))
      .resolves.toMatchObject({ rowCount: 1 });

    // In read_only mode the removal is refused again (only active is NOT the sole gate).
    await fixture.client.query("UPDATE mdf_engine_state SET mode='read_only'");
    await expect(fixture.client.query(`UPDATE sheet_material_types SET name='МДФ тест миграции' WHERE sheet_material_type_id=1`))
      .resolves.toMatchObject({ rowCount: 1 }); // currently non-MDF -> MDF: adds classification, always allowed
    await expect(fixture.client.query(`UPDATE sheet_material_types SET name='ЛДСП снова' WHERE sheet_material_type_id=1`))
      .rejects.toMatchObject({ code: '23514' });

    await fixture.client.query("UPDATE mdf_engine_state SET mode='active'");
  });

  it('mdf_material_is_mdf() carries the SAME two regexes as backend/src/shared/cnc-material (static parity, pinned)', async () => {
    const sql = readFileSync(resolve(__dirname, '199_mdf_cutover_controls.sql'), 'utf8');
    const match = sql.match(
      /SELECT COALESCE\(name,''\) ~\* '((?:[^'\\]|\\.)*)'\s*\n\s*AND COALESCE\(name,''\) !~\* '((?:[^'\\]|\\.)*)'/);
    expect(match, 'mdf_material_is_mdf() body pattern not found in 199_mdf_cutover_controls.sql').not.toBeNull();
    const [, mdfPattern, otherPattern] = match!;
    expect(mdfPattern).toBe(CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE);
    expect(otherPattern).toBe(CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE);

    // Cross-checked against the LIVE function body too (not just the source file text).
    const def = await fixture.client.query<{ def: string }>(
      `SELECT pg_get_functiondef(oid) def FROM pg_proc WHERE oid=to_regprocedure($1)`,
      [`${fixture.schema}.mdf_material_is_mdf(text)`]);
    expect(def.rows).toHaveLength(1);
    expect(def.rows[0].def).toContain(CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE);
    expect(def.rows[0].def).toContain(CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE);
  });
});
