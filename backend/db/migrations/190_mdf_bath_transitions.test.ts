import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMdfCorrectionPgFixture } from '../../src/modules/mdf-board/adapters/mdf-correction-test-fixture.integration';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';

// This suite exercises the DB-level guards of migration 190 directly (raw SQL
// against the frozen mdf_evidence_revisions/mdf_source_heads/mdf_revision_seals
// prerequisites). It does not attempt a full valid commit-time acceptance: that
// path also requires a bound mdf_recalculation_jobs row (source_kind='bath',
// status='pending', effect_policy='forward') plus a sealed EMPTY retirement
// revision (no lines, no demand) and, when a successor is captured, its own
// sealed unaccepted membership-only revision -- all of which the application
// layer builds through the bath-lifecycle command path and is already covered
// by that path's own integration tests. Here we only prove the BEFORE INSERT
// guard accepts a well-formed row (never committed, so the DEFERRED commit-time
// trigger mdf_validate_bath_transition_commit is never invoked) and reject the
// immediate failure modes.
describe.skipIf(!enabled)('MDF bath transitions migration 190, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e190bath');
  const digest = (ch: string) => ch.repeat(64);

  beforeAll(async () => {
    await fixture.connect();
    await fixture.applyMigrations([
      '165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql', '178_mdf_correction_receipts.sql',
      '190_mdf_bath_transitions.sql',
    ]);
  }, 30000);

  afterAll(async () => fixture.drop());

  let idSeq = 1;
  const nextSourceId = () => `cut-result:${idSeq++}`;
  let cutJobSeq = 1;
  const nextCutJobId = () => cutJobSeq++;

  async function seedSealedRevision(sourceId: string, revisionKey: string, digestChar: string) {
    await fixture.client.query(`INSERT INTO mdf_evidence_revisions
      (source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key)
      VALUES('bath',$1,$2,$3,'manual',1,$4,$4)`,
    [sourceId, revisionKey, digest(digestChar), `req-${sourceId}-${revisionKey}`]);
    await fixture.client.query(`INSERT INTO mdf_revision_seals(source_kind,source_id,revision_key) VALUES('bath',$1,$2)`,
    [sourceId, revisionKey]);
  }

  async function seedUnsealedRevision(sourceId: string, revisionKey: string, digestChar: string) {
    await fixture.client.query(`INSERT INTO mdf_evidence_revisions
      (source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key)
      VALUES('bath',$1,$2,$3,'derived',1,$4,$4)`,
    [sourceId, revisionKey, digest(digestChar), `req-retire-${sourceId}-${revisionKey}`]);
  }

  async function seedSourceHead(sourceId: string, receivedRevisionKey: string, acceptedRevisionKey: string | null) {
    await fixture.client.query(`INSERT INTO mdf_source_heads(source_kind,source_id,received_revision_key,accepted_revision_key)
      VALUES('bath',$1,$2,$3)`, [sourceId, receivedRevisionKey, acceptedRevisionKey]);
  }

  async function insertTransition(opts: {
    retiredSourceId: string; retiredRevisionKey: string; predecessorRevisionKey: string;
    successorSourceId?: string | null; successorRevisionKey?: string | null;
    cutJobId: number; commandKey: string;
  }) {
    return fixture.client.query(`INSERT INTO mdf_bath_transitions
      (transition_id,job_id,cut_job_id,retired_source_kind,retired_source_id,retired_revision_key,
        retired_predecessor_revision_key,successor_source_id,successor_revision_key,owner_ids,
        actor_user_id,request_id,command_key)
      VALUES($1,$2,$3,'bath',$4,$5,$6,$7,$8,ARRAY[1]::bigint[],1,$9,$9)`,
    [randomUUID(), randomUUID(), opts.cutJobId, opts.retiredSourceId, opts.retiredRevisionKey,
      opts.predecessorRevisionKey, opts.successorSourceId ?? null, opts.successorRevisionKey ?? null,
      opts.commandKey]);
  }

  it('applies idempotently and installs the three guard functions and triggers, enabled', async () => {
    await fixture.applyMigrations(['190_mdf_bath_transitions.sql']);
    await fixture.assertLocalRelations(['mdf_bath_transitions']);
    const functions = await fixture.client.query<{ proname: string }>(`SELECT p.proname FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname=ANY($2::text[]) ORDER BY p.proname`,
    [fixture.schema, ['mdf_guard_bath_transition_insert', 'mdf_validate_bath_transition_commit',
      'mdf_reject_bath_transition_change']]);
    expect(functions.rows.map(row => row.proname)).toEqual([
      'mdf_guard_bath_transition_insert', 'mdf_reject_bath_transition_change', 'mdf_validate_bath_transition_commit',
    ]);
    const triggers = await fixture.client.query<{ tgname: string; tgenabled: string; function_name: string;
      tgtype: number; tgdeferrable: boolean; tginitdeferred: boolean }>(`
      SELECT t.tgname,t.tgenabled,p.proname AS function_name,t.tgtype::int,t.tgdeferrable,t.tginitdeferred
      FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE n.nspname=$1 AND r.relname='mdf_bath_transitions' AND NOT t.tgisinternal ORDER BY t.tgname`,
    [fixture.schema]);
    expect(triggers.rows).toEqual([
      { tgname: 'mdf_bath_transition_commit_guard', tgenabled: 'O', function_name: 'mdf_validate_bath_transition_commit',
        tgtype: 5, tgdeferrable: true, tginitdeferred: true },
      { tgname: 'mdf_bath_transition_immutable', tgenabled: 'O', function_name: 'mdf_reject_bath_transition_change',
        tgtype: 27, tgdeferrable: false, tginitdeferred: false },
      { tgname: 'mdf_bath_transition_insert_guard', tgenabled: 'O', function_name: 'mdf_guard_bath_transition_insert',
        tgtype: 7, tgdeferrable: false, tginitdeferred: false },
    ]);
  });

  it('rejects a transition insert once the retired revision is already sealed', async () => {
    const retiredSourceId = nextSourceId();
    const predRev = 'predecessor';
    const retiredRev = 'retire:1';
    await fixture.client.query('BEGIN');
    try {
      await seedSealedRevision(retiredSourceId, predRev, 'a');
      await seedSourceHead(retiredSourceId, predRev, predRev);
      // Another path already sealed the retirement revision before this transition could attach.
      await seedSealedRevision(retiredSourceId, retiredRev, 'b');
      await expect(insertTransition({
        retiredSourceId, retiredRevisionKey: retiredRev, predecessorRevisionKey: predRev,
        cutJobId: nextCutJobId(), commandKey: `cmd-${retiredSourceId}`,
      })).rejects.toMatchObject({ code: '55000', message: expect.stringContaining('before the retirement seal') });
    } finally {
      await fixture.client.query('ROLLBACK');
    }
  });

  it('rejects a transition whose retired predecessor is not the stable accepted head', async () => {
    const retiredSourceId = nextSourceId();
    const predRev = 'predecessor';
    const retiredRev = 'retire:1';
    await fixture.client.query('BEGIN');
    try {
      await seedSealedRevision(retiredSourceId, predRev, 'a');
      await seedUnsealedRevision(retiredSourceId, retiredRev, 'b');
      // No mdf_source_heads row at all: predecessor is not a stable accepted head.
      await expect(insertTransition({
        retiredSourceId, retiredRevisionKey: retiredRev, predecessorRevisionKey: predRev,
        cutJobId: nextCutJobId(), commandKey: `cmd-${retiredSourceId}`,
      })).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('stable accepted head') });
    } finally {
      await fixture.client.query('ROLLBACK');
    }
  });

  it('rejects a transition whose successor source is not a brand-new source', async () => {
    const retiredSourceId = nextSourceId();
    const predRev = 'predecessor';
    const retiredRev = 'retire:1';
    const successorSourceId = nextSourceId();
    const succRev = 'accepted:1';
    await fixture.client.query('BEGIN');
    try {
      await seedSealedRevision(retiredSourceId, predRev, 'a');
      await seedSourceHead(retiredSourceId, predRev, predRev);
      await seedUnsealedRevision(retiredSourceId, retiredRev, 'b');
      // Successor already exists as an ordinary bath with an accepted revision, so it is not "new".
      await seedSealedRevision(successorSourceId, succRev, 'c');
      await seedSourceHead(successorSourceId, succRev, succRev);
      await expect(insertTransition({
        retiredSourceId, retiredRevisionKey: retiredRev, predecessorRevisionKey: predRev,
        successorSourceId, successorRevisionKey: succRev,
        cutJobId: nextCutJobId(), commandKey: `cmd-${retiredSourceId}`,
      })).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('must be a new source') });
    } finally {
      await fixture.client.query('ROLLBACK');
    }
  });

  it('accepts a well-formed unsealed transition through the BEFORE INSERT guard; UPDATE/DELETE remain immutable', async () => {
    const retiredSourceId = nextSourceId();
    const predRev = 'predecessor';
    const retiredRev = 'retire:1';
    const successorSourceId = nextSourceId();
    const succRev = 'fresh:1';
    await fixture.client.query('BEGIN');
    try {
      await seedSealedRevision(retiredSourceId, predRev, 'a');
      await seedSourceHead(retiredSourceId, predRev, predRev);
      await seedUnsealedRevision(retiredSourceId, retiredRev, 'b');
      // Successor is a brand-new, unaccepted source: sealed once, never accepted.
      await seedSealedRevision(successorSourceId, succRev, 'c');
      await seedSourceHead(successorSourceId, succRev, null);
      await expect(insertTransition({
        retiredSourceId, retiredRevisionKey: retiredRev, predecessorRevisionKey: predRev,
        successorSourceId, successorRevisionKey: succRev,
        cutJobId: nextCutJobId(), commandKey: `cmd-${retiredSourceId}`,
      })).resolves.toMatchObject({ rowCount: 1 });
      // Each mutation attempt aborts the current transaction on failure; isolate them with SAVEPOINTs.
      await fixture.client.query('SAVEPOINT before_update');
      await expect(fixture.client.query(`UPDATE mdf_bath_transitions SET request_id='changed' WHERE retired_source_id=$1`,
        [retiredSourceId])).rejects.toMatchObject({ code: '55000', message: expect.stringContaining('immutable') });
      await fixture.client.query('ROLLBACK TO SAVEPOINT before_update');
      await fixture.client.query('SAVEPOINT before_delete');
      await expect(fixture.client.query('DELETE FROM mdf_bath_transitions WHERE retired_source_id=$1', [retiredSourceId]))
        .rejects.toMatchObject({ code: '55000', message: expect.stringContaining('immutable') });
      await fixture.client.query('ROLLBACK TO SAVEPOINT before_delete');
    } finally {
      // Never committed: the DEFERRED commit-time trigger (job binding + sealed-empty
      // retirement + successor membership-only checks) is intentionally out of scope
      // for this migration test; it is exercised by the bath-lifecycle command's own
      // integration tests.
      await fixture.client.query('ROLLBACK');
    }
  });
});
