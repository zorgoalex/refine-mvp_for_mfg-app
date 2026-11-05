import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMdfCorrectionPgFixture } from '../../src/modules/mdf-board/adapters/mdf-correction-test-fixture.integration';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';

// This suite exercises the DB-level guards of migration 188 directly (raw SQL
// against the frozen mdf_evidence_revisions/mdf_revision_context/mdf_source_heads
// prerequisites). It does not attempt a full valid commit-time acceptance: that
// path also requires a bound mdf_recalculation_jobs row plus a sealed revision
// whose mdf_evidence_lines are byte-identical to the predecessor's, which the
// application layer builds through recordMdfReceipt/openMdfOrderCommand and is
// already covered end-to-end by mdf-order-cascade.integration.test.ts. Here we
// only prove the BEFORE INSERT guard accepts a well-formed row (never committed,
// so the DEFERRED commit-time trigger is never invoked) and reject the immediate
// failure modes.
describe.skipIf(!enabled)('MDF order cascade intents migration 188, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e188cascade');
  const digest = (ch: string) => ch.repeat(64);
  const PREV_DIGEST = digest('1');
  const NEXT_DIGEST = digest('2');

  beforeAll(async () => {
    await fixture.connect();
    // 185's DO-block guard requires bazis_cut_sets/bazis_cut_set_details to be LOCAL
    // (current_schema()) relations, and 179 references cnc_telegram_packets by FK.
    await fixture.clonePublicTables(['bazis_cut_sets', 'bazis_cut_set_details', 'cnc_telegram_packets']);
    await fixture.client.query('ALTER TABLE cnc_telegram_packets ADD PRIMARY KEY(packet_id)');
    await fixture.applyMigrations([
      '165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql', '175_mdf_command_placement.sql',
      '178_mdf_correction_receipts.sql', '179_mdf_active_return.sql',
      '182_mdf_physical_lineage.sql', '185_mdf_bazis_composition.sql', '187_mdf_bazis_refill_rows.sql',
      '188_mdf_order_cascade_intents.sql',
    ]);
  }, 30000);

  afterAll(async () => fixture.drop());

  async function seedPredecessor(sourceId: string, revisionKey: string) {
    await fixture.client.query(`INSERT INTO mdf_evidence_revisions
      (source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key)
      VALUES('bazisCutSet',$1,$2,$3,'manual',1,$4,$4)`,
    [sourceId, revisionKey, digest('a'), `req-pred-${sourceId}`]);
    await fixture.client.query(`INSERT INTO mdf_revision_context
      (source_kind,source_id,revision_key,source_created_at,display_name,prior_column,composition_complete,demand_digest)
      VALUES('bazisCutSet',$1,$2,'2026-09-24','predecessor context','parsed',true,$3)`,
    [sourceId, revisionKey, PREV_DIGEST]);
    await fixture.client.query(`INSERT INTO mdf_revision_seals(source_kind,source_id,revision_key) VALUES('bazisCutSet',$1,$2)`,
    [sourceId, revisionKey]);
  }

  async function seedSourceHead(sourceId: string, revisionKey: string) {
    await fixture.client.query(`INSERT INTO mdf_source_heads(source_kind,source_id,received_revision_key,accepted_revision_key)
      VALUES('bazisCutSet',$1,$2,$2)`, [sourceId, revisionKey]);
  }

  async function seedNewRevisionContext(sourceId: string, revisionKey: string, predecessorRevisionKey: string) {
    await fixture.client.query(`INSERT INTO mdf_evidence_revisions
      (source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key)
      VALUES('bazisCutSet',$1,$2,$3,'order_cascade',1,$4,$4)`,
    [sourceId, revisionKey, digest('c'), `req-cascade-${sourceId}`]);
    await fixture.client.query(`INSERT INTO mdf_revision_context
      (source_kind,source_id,revision_key,source_created_at,display_name,prior_column,composition_complete,
        demand_digest,acceptance_requested,predecessor_accepted_revision_key,predecessor_received_revision_key)
      VALUES('bazisCutSet',$1,$2,'2026-09-24','cascade context','parsed',true,$3,true,$4,$4)`,
    [sourceId, revisionKey, NEXT_DIGEST, predecessorRevisionKey]);
  }

  async function insertIntent(sourceId: string, revisionKey: string, predecessorRevisionKey: string) {
    return fixture.client.query(`INSERT INTO mdf_order_cascade_intents
      (intent_id,job_id,source_kind,source_id,revision_key,predecessor_revision_key,previous_demand_digest,
        next_demand_digest,order_ids,actor_user_id,request_id,command_key)
      VALUES($1,$2,'bazisCutSet',$3,$4,$5,$6,$7,ARRAY[1]::bigint[],1,$8,$8)`,
    [randomUUID(), randomUUID(), sourceId, revisionKey, predecessorRevisionKey, PREV_DIGEST, NEXT_DIGEST,
      `cmd-${sourceId}-${revisionKey}`]);
  }

  it('applies idempotently and installs the three guard functions and triggers, enabled', async () => {
    await fixture.applyMigrations(['188_mdf_order_cascade_intents.sql']);
    await fixture.assertLocalRelations(['mdf_order_cascade_intents']);
    const functions = await fixture.client.query<{ proname: string }>(`SELECT p.proname FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname=ANY($2::text[]) ORDER BY p.proname`,
    [fixture.schema, ['mdf_guard_order_cascade_intent_insert', 'mdf_validate_order_cascade_intent_commit',
      'mdf_reject_order_cascade_intent_change']]);
    expect(functions.rows.map(row => row.proname)).toEqual([
      'mdf_guard_order_cascade_intent_insert', 'mdf_reject_order_cascade_intent_change',
      'mdf_validate_order_cascade_intent_commit',
    ]);
    const triggers = await fixture.client.query<{ tgname: string; tgenabled: string; function_name: string;
      tgtype: number; tgdeferrable: boolean; tginitdeferred: boolean }>(`
      SELECT t.tgname,t.tgenabled,p.proname AS function_name,t.tgtype::int,t.tgdeferrable,t.tginitdeferred
      FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE n.nspname=$1 AND r.relname='mdf_order_cascade_intents' AND NOT t.tgisinternal ORDER BY t.tgname`,
    [fixture.schema]);
    expect(triggers.rows).toEqual([
      { tgname: 'mdf_order_cascade_intent_commit_guard', tgenabled: 'O', function_name: 'mdf_validate_order_cascade_intent_commit',
        tgtype: 5, tgdeferrable: true, tginitdeferred: true },
      { tgname: 'mdf_order_cascade_intent_immutable', tgenabled: 'O', function_name: 'mdf_reject_order_cascade_intent_change',
        tgtype: 27, tgdeferrable: false, tginitdeferred: false },
      { tgname: 'mdf_order_cascade_intent_insert_guard', tgenabled: 'O', function_name: 'mdf_guard_order_cascade_intent_insert',
        tgtype: 7, tgdeferrable: false, tginitdeferred: false },
    ]);
  });

  it('rejects an intent insert once its own revision is already sealed', async () => {
    const sourceId = `sealed-${randomUUID()}`;
    const predRev = 'predecessor';
    const newRev = 'order-cascade:1';
    await fixture.client.query('BEGIN');
    try {
      await seedPredecessor(sourceId, predRev);
      await seedSourceHead(sourceId, predRev);
      await seedNewRevisionContext(sourceId, newRev, predRev);
      // The revision was accepted/sealed by another path before this intent could attach.
      await fixture.client.query(`INSERT INTO mdf_revision_seals(source_kind,source_id,revision_key) VALUES('bazisCutSet',$1,$2)`,
      [sourceId, newRev]);
      await expect(insertIntent(sourceId, newRev, predRev)).rejects.toMatchObject({
        code: '55000', message: expect.stringContaining('must be attached before its seal'),
      });
    } finally {
      await fixture.client.query('ROLLBACK');
    }
  });

  it('rejects an intent whose predecessor is not the stable accepted head', async () => {
    const sourceId = `no-head-${randomUUID()}`;
    const predRev = 'predecessor';
    const newRev = 'order-cascade:1';
    await fixture.client.query('BEGIN');
    try {
      await seedPredecessor(sourceId, predRev);
      await seedNewRevisionContext(sourceId, newRev, predRev);
      // No mdf_source_heads row at all: predecessor is not a stable accepted head.
      await expect(insertIntent(sourceId, newRev, predRev)).rejects.toMatchObject({
        code: '23514', message: expect.stringContaining('stable accepted head'),
      });
    } finally {
      await fixture.client.query('ROLLBACK');
    }
  });

  it('rejects an intent whose predecessor head has since moved past the recorded predecessor', async () => {
    const sourceId = `stale-head-${randomUUID()}`;
    const predRev = 'predecessor';
    const otherRev = 'other-accepted';
    const newRev = 'order-cascade:1';
    await fixture.client.query('BEGIN');
    try {
      await seedPredecessor(sourceId, predRev);
      await seedPredecessor(sourceId, otherRev);
      await seedSourceHead(sourceId, otherRev); // head has already advanced past predRev
      await seedNewRevisionContext(sourceId, newRev, predRev);
      await expect(insertIntent(sourceId, newRev, predRev)).rejects.toMatchObject({
        code: '23514', message: expect.stringContaining('stable accepted head'),
      });
    } finally {
      await fixture.client.query('ROLLBACK');
    }
  });

  it('accepts a well-formed unsealed intent through the BEFORE INSERT guard; UPDATE/DELETE remain immutable', async () => {
    const sourceId = `valid-${randomUUID()}`;
    const predRev = 'predecessor';
    const newRev = 'order-cascade:1';
    await fixture.client.query('BEGIN');
    try {
      await seedPredecessor(sourceId, predRev);
      await seedSourceHead(sourceId, predRev);
      await seedNewRevisionContext(sourceId, newRev, predRev);
      await expect(insertIntent(sourceId, newRev, predRev)).resolves.toMatchObject({ rowCount: 1 });
      // Each mutation attempt aborts the current transaction on failure; isolate them with SAVEPOINTs.
      await fixture.client.query('SAVEPOINT before_update');
      await expect(fixture.client.query(`UPDATE mdf_order_cascade_intents SET request_id='changed' WHERE source_id=$1`,
        [sourceId])).rejects.toMatchObject({ code: '55000', message: expect.stringContaining('immutable') });
      await fixture.client.query('ROLLBACK TO SAVEPOINT before_update');
      await fixture.client.query('SAVEPOINT before_delete');
      await expect(fixture.client.query('DELETE FROM mdf_order_cascade_intents WHERE source_id=$1', [sourceId]))
        .rejects.toMatchObject({ code: '55000', message: expect.stringContaining('immutable') });
      await fixture.client.query('ROLLBACK TO SAVEPOINT before_delete');
    } finally {
      // Never committed: the DEFERRED commit-time trigger (job binding + sealed
      // verbatim-lines check) is intentionally out of scope for this migration test.
      await fixture.client.query('ROLLBACK');
    }
  });
});
