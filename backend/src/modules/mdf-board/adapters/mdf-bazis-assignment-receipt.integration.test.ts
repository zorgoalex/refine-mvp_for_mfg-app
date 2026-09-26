/**
 * Regression tests for the inherited assignment-state payload digest described
 * in spec_erp/reviews/mdf-composition-next-runtime-20260924.md.
 *
 * Contract under test: a marked BASIS lineage receipt must append the versioned
 * inherited-state metadata, in exactly the agreed key order
 * { assignmentStateVersion:1, assignmentStateId, rootIntentId,
 *   predecessorRevisionKey, predecessorStateId, membershipDigest, intentionalEmpty },
 * after the canonical base parts and the physical-lineage manifest part of the
 * sealed payload digest. The root composition receipt owns its own assignment
 * state through the composition intent/marker insert, but its payload digest
 * keeps only the distinct assignmentCompositionVersion commitment and never
 * appends the inherited-state object; descendants never inherit command
 * raw/set/allocation pin digests. Unmarked historical v1/v2
 * digest bytes must stay byte-identical, including replay after a later first
 * composition. Expected digests are assembled explicitly here (sha256 over an
 * independent array literal); only the normalization helpers
 * (snapshotMdfPhysicalLineage, snapshotMdfExecutionContext) are shared with the
 * runtime. The runtime digest path in application/mdf-receipt.ts is owned by the
 * worker slice.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMdfCorrectionPgFixture } from './mdf-correction-test-fixture.integration';
import type { MdfExecutionContext } from '../domain/mdf-execution-context';
import { snapshotMdfExecutionContext } from '../domain/mdf-execution-context';
import type { MdfBazisCompositionReceiptInput, MdfLineageReceiptInput, MdfReceiptFence,
  MdfReceiptInput, MdfReceiptLine } from '../application/mdf-receipt';
import { recordMdfBazisCompositionReceipt, recordMdfLineageReceipt,
  recordMdfReceipt } from '../application/mdf-receipt';
import type { MdfPhysicalLineageManifest } from '../application/mdf-physical-lineage';
import { snapshotMdfPhysicalLineage } from '../application/mdf-physical-lineage';
import { mdfBazisMembershipDigest } from '../application/mdf-bazis-assignment-state';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';
type Manifest = MdfPhysicalLineageManifest;
type Action = Manifest['actions'][number];
type Demand = readonly { orderId: number; detailId: number; quantity: number }[];

describe.skipIf(!enabled)('MDF BASIS inherited assignment-state digest, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e_mdf_state_digest');
  let databaseService: ReturnType<typeof fixture.createDatabaseService> | undefined;
  const database = () => {
    if (!databaseService) throw new Error('MDF_TEST_DATABASE_NOT_READY');
    return databaseService;
  };
  let setSequence = 0;
  const regressionRelations = [
    'mdf_evidence_revisions', 'mdf_evidence_lines', 'mdf_revision_context', 'mdf_revision_demand',
    'mdf_revision_seals', 'mdf_source_heads', 'mdf_recalculation_jobs', 'mdf_recalculation_job_rules',
    'mdf_physical_lineage_contracts', 'mdf_physical_lineage_transitions',
    'mdf_bazis_assignment_states', 'mdf_bazis_composition_intents',
  ];

  beforeAll(async () => {
    await fixture.connect();
    await fixture.applyMigrations([
      '165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql', '175_mdf_command_placement.sql',
      '178_mdf_correction_receipts.sql', '182_mdf_physical_lineage.sql', '188_mdf_order_cascade_intents.sql', '189_mdf_placement_inputs.sql',
    ]);
    await fixture.client.query(`CREATE TABLE bazis_cut_sets(
        bazis_cut_set_id BIGINT PRIMARY KEY, name TEXT, version BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await fixture.client.query(`CREATE TABLE bazis_cut_set_details(
        bazis_cut_set_detail_id BIGINT PRIMARY KEY, bazis_cut_set_id BIGINT NOT NULL,
        source_order_id BIGINT, source_order_detail_id BIGINT, source_order_hdf_detail_id BIGINT,
        quantity BIGINT NOT NULL DEFAULT 1, cut_enabled BOOLEAN NOT NULL DEFAULT true,
        material_name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await fixture.applyMigrations(['185_mdf_bazis_composition.sql']);
    await fixture.assertLocalRelations([...regressionRelations, 'bazis_cut_sets', 'bazis_cut_set_details']);
    databaseService = fixture.createDatabaseService();
  }, 30000);

  afterAll(async () => {
    await databaseService?.onModuleDestroy();
    // fixture.drop() removes exactly the owned random schema and fails if the
    // schema namespace survives, proving the local relations left no residue.
    await fixture.drop();
  });

  const membershipLine = (lineKey: string, detailId: number, quantity: number): MdfReceiptLine => ({
    lineKey, orderId: 1, detailId, quantity, stageCode: 'membership', evidenceKind: 'derived', rework: false });
  const physicalLine = (lineKey: string, detailId: number, quantity: number): MdfReceiptLine => ({
    lineKey, orderId: 1, detailId, quantity, stageCode: 'cut', evidenceKind: 'physical', rework: false });
  const execContext = (demand: Demand): MdfExecutionContext => ({
    sourceCreatedAt: '2026-09-01T00:00:00.000Z', displayName: 'E2E assignment state digest',
    priorColumn: 'parsed', compositionComplete: true, demand });
  const productionManifest = (lineKey: string): Manifest => ({
    operation: 'production', authority: 'manual_production', actions: [{ lineKey, action: 'root' }],
    droppedPredecessorEvidenceLineIds: [] });
  const carryManifest = (actions: readonly Action[]): Manifest => ({
    operation: 'carry', actions, droppedPredecessorEvidenceLineIds: [] });
  const correctionManifest = (actions: readonly Action[]): Manifest => ({
    operation: 'correction', actions, droppedPredecessorEvidenceLineIds: [] });
  const carryAction = (lineKey: string, predecessorEvidenceLineId: string): Action => ({
    lineKey, action: 'carry', predecessorEvidenceLineId });

  type ReceiptWithContext = MdfLineageReceiptInput & { executionContext: MdfExecutionContext };
  type CompositionReceiptInput = MdfBazisCompositionReceiptInput & { executionContext: MdfExecutionContext };
  interface SealedState { assignmentStateId: string; rootIntentId: string; predecessorRevisionKey: string;
    predecessorStateId: string; membershipDigest: string; intentionalEmpty: boolean }

  const lineageInput = (sourceId: string, revisionKey: string, lines: readonly MdfReceiptLine[],
    lineage: Manifest, executionContext: MdfExecutionContext,
    expectedFence: MdfReceiptFence | null): ReceiptWithContext => ({
      sourceKind: 'bazisCutSet', sourceId, revisionKey, origin: 'manual', actorUserId: 158,
      requestId: `state-${sourceId}-${revisionKey}`, causeKey: `state-cause-${sourceId}-${revisionKey}`,
      expectedFence, accept: true, executionContext, lines, rules: [], lineage });
  const save = (value: MdfLineageReceiptInput) => database().transaction(tx => recordMdfLineageReceipt(tx, value));
  const saveLegacy = (value: MdfReceiptInput) => database().transaction(tx => recordMdfReceipt(tx, value));
  const saveComposition = (value: CompositionReceiptInput) =>
    database().transaction(tx => recordMdfBazisCompositionReceipt(tx, value));

  /** Explicit expected-digest assembly: independent of the production digest
   * helper. baseParts mirrors the frozen v1/v2 canonical parts, and the
   * inherited state object is appended last, after the lineage manifest part. */
  const hash64 = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const canonicalLines = (lines: readonly MdfReceiptLine[]): (string | number | boolean)[][] => lines
    .map(line => [line.lineKey, line.orderId, line.detailId, line.quantity, line.stageCode,
      line.evidenceKind, line.rework])
    .sort((a, b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0);
  const baseParts = (input: MdfReceiptInput, normalizedContext: unknown): unknown[] => {
    const parts: unknown[] = [input.origin, canonicalLines(input.lines), input.sourceDigest ?? null];
    if (normalizedContext !== undefined) parts.push(normalizedContext, input.accept);
    return parts;
  };
  const lineagePart = (input: MdfLineageReceiptInput): unknown => ({
    physicalLineageVersion: 2, manifest: snapshotMdfPhysicalLineage(input.lineage, input.lines) });
  const inheritedStatePart = (state: SealedState): unknown => ({
    assignmentStateVersion: 1, assignmentStateId: state.assignmentStateId, rootIntentId: state.rootIntentId,
    predecessorRevisionKey: state.predecessorRevisionKey, predecessorStateId: state.predecessorStateId,
    membershipDigest: state.membershipDigest, intentionalEmpty: state.intentionalEmpty });
  const compositionPart = (input: CompositionReceiptInput): unknown => {
    const c = input.composition;
    return { assignmentCompositionVersion: 1, intentId: c.intentId, assignmentStateId: c.assignmentStateId,
      jobId: c.jobId, setId: c.setId, setVersion: c.setVersion, rawSnapshotDigest: c.rawSnapshotDigest,
      membershipDigest: c.membershipDigest, intentionalEmpty: c.intentionalEmpty, ownerIds: c.ownerIds,
      allocationSnapshotDigest: c.allocationSnapshotDigest, previewDigest: c.previewDigest,
      commandKey: c.commandKey };
  };
  const legacyGolden = (input: MdfReceiptInput): string => hash64(baseParts(input, undefined));
  const unmarkedGolden = (input: MdfLineageReceiptInput, normalizedContext: unknown): string =>
    hash64([...baseParts(input, normalizedContext), lineagePart(input)]);
  const markedGolden = (input: MdfLineageReceiptInput, normalizedContext: unknown, state: SealedState): string =>
    hash64([...baseParts(input, normalizedContext), lineagePart(input), inheritedStatePart(state)]);
  const compositionGolden = (input: CompositionReceiptInput, normalizedContext: unknown): string =>
    hash64([...baseParts(input, normalizedContext), lineagePart(input), compositionPart(input)]);

  const revisionKeys = async (sourceId: string): Promise<string[]> =>
    (await fixture.client.query<{ revision_key: string }>(`SELECT revision_key FROM mdf_evidence_revisions
      WHERE source_kind='bazisCutSet' AND source_id=$1 ORDER BY revision_key`, [sourceId])).rows
      .map(row => row.revision_key);
  const payloadDigest = async (sourceId: string, revisionKey: string): Promise<string> => {
    const rows = (await fixture.client.query<{ payload_digest: string }>(`SELECT payload_digest
      FROM mdf_evidence_revisions WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2`,
    [sourceId, revisionKey])).rows;
    if (rows.length !== 1) throw new Error(`E2E_TEST_REVISION_MISSING:${sourceId}/${revisionKey}`);
    return rows[0].payload_digest;
  };
  interface StateRowShape { revision_key: string; assignment_state_id: string; root_intent_id: string;
    predecessor_revision_key: string | null; predecessor_state_id: string | null; membership_digest: string;
    intentional_empty: boolean }
  /** One source may carry one marker per revision; read all rows ordered by
   * revision key so absence of a marker is explicit and inherited descendants
   * are visible together. */
  const assignmentStates = async (sourceId: string): Promise<StateRowShape[]> =>
    (await fixture.client.query<StateRowShape>(`SELECT revision_key, assignment_state_id::text assignment_state_id,
        root_intent_id::text root_intent_id, predecessor_revision_key, predecessor_state_id::text predecessor_state_id,
        membership_digest, intentional_empty
      FROM mdf_bazis_assignment_states WHERE source_kind='bazisCutSet' AND source_id=$1 ORDER BY revision_key`,
    [sourceId])).rows;
  interface HeadShape { version: string; correction_epoch: string; received_revision_key: string;
    accepted_revision_key: string | null }
  const headRow = async (sourceId: string): Promise<HeadShape> => {
    const rows = (await fixture.client.query<HeadShape>(`SELECT version::text version,
        correction_epoch::text correction_epoch, received_revision_key, accepted_revision_key
      FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`, [sourceId])).rows;
    if (rows.length !== 1) throw new Error(`E2E_TEST_HEAD_MISSING:${sourceId}`);
    return rows[0];
  };
  const headFence = async (sourceId: string): Promise<MdfReceiptFence> => {
    const head = await headRow(sourceId);
    return { version: head.version, correctionEpoch: head.correction_epoch };
  };
  const physicalLineId = async (sourceId: string, revisionKey: string, lineKey: string): Promise<string> => {
    const rows = (await fixture.client.query<{ evidence_line_id: string }>(`SELECT evidence_line_id::text evidence_line_id
      FROM mdf_evidence_lines WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key=$2 AND line_key=$3`,
    [sourceId, revisionKey, lineKey])).rows;
    if (rows.length !== 1) throw new Error(`E2E_TEST_PHYSICAL_LINE_MISSING:${sourceId}/${revisionKey}/${lineKey}`);
    return rows[0].evidence_line_id;
  };
  const effectPolicies = async (sourceId: string, revisionKey: string) =>
    (await fixture.client.query<{ context_policy: string; job_policy: string; job_status: string }>(`
      SELECT c.effect_policy context_policy, j.effect_policy job_policy, j.status job_status
      FROM mdf_revision_context c JOIN mdf_recalculation_jobs j USING(source_kind,source_id,revision_key)
      WHERE c.source_kind='bazisCutSet' AND c.source_id=$1 AND c.revision_key=$2`,
    [sourceId, revisionKey])).rows;

  interface SeededSource { sourceId: string; detailId: number; quantity: number; demand: Demand;
    intentId: string; assignmentStateId: string; jobId: string; membershipDigest: string;
    composition: CompositionReceiptInput; sealedState: SealedState }

  /** Creates the accepted v2 root and the real root composition receipt. The
   * composition stays received-but-unaccepted with its job 'pending', exactly
   * as migration 185's deferred guard requires at its own COMMIT. */
  async function seedPendingComposition(label: string, quantity: number,
    emptyComposition: boolean): Promise<SeededSource> {
    const setId = ++setSequence;
    const sourceId = String(setId);
    const detailId = 9_000 + setId;
    const demand: Demand = [{ orderId: 1, detailId, quantity }];
    const member = membershipLine('member-1', detailId, quantity);
    const root = await save(lineageInput(sourceId, 'root-v2', [member, physicalLine('root-cut', detailId, quantity)],
      productionManifest('root-cut'), execContext(demand), null));
    expect(root).toMatchObject({ accepted: true, replay: false });
    const rootCutId = await physicalLineId(sourceId, 'root-v2', 'root-cut');
    const compLines = emptyComposition
      ? [physicalLine('composition-cut', detailId, quantity)]
      : [member, physicalLine('composition-cut', detailId, quantity)];
    const intentId = randomUUID(); const assignmentStateId = randomUUID(); const jobId = randomUUID();
    const composition: CompositionReceiptInput = {
      ...lineageInput(sourceId, 'composition', compLines, carryManifest([carryAction('composition-cut', rootCutId)]),
        execContext(demand), { version: root.version, correctionEpoch: root.correctionEpoch }),
      composition: { intentId, assignmentStateId, jobId, setId, setVersion: 1,
        rawSnapshotDigest: hash64(`raw-${label}-${setId}`), membershipDigest: mdfBazisMembershipDigest(compLines),
        intentionalEmpty: emptyComposition, ownerIds: [1],
        allocationSnapshotDigest: hash64(`allocation-${label}-${setId}`),
        previewDigest: hash64(`preview-${label}-${setId}`),
        commandKey: `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}` },
    };
    const queued = await saveComposition(composition);
    expect(queued).toMatchObject({ accepted: false, replay: false, jobId });
    expect(await headRow(sourceId)).toMatchObject({
      received_revision_key: 'composition', accepted_revision_key: 'root-v2' });
    return { sourceId, detailId, quantity, demand, intentId, assignmentStateId, jobId,
      membershipDigest: composition.composition.membershipDigest, composition,
      sealedState: { assignmentStateId, rootIntentId: intentId, predecessorRevisionKey: 'composition',
        predecessorStateId: assignmentStateId, membershipDigest: composition.composition.membershipDigest,
        intentionalEmpty: emptyComposition } };
  }

  async function setupTransaction(statements: () => Promise<void>): Promise<void> {
    await fixture.client.query('BEGIN');
    try { await statements(); await fixture.client.query('COMMIT'); }
    catch (error) { await fixture.client.query('ROLLBACK').catch(() => undefined); throw error; }
  }

  /** TEST SETUP ONLY — not the behavior under test. The worker composition
   * acceptance slice (pin transfer, status suppression, audit/outbox) is an
   * unfinished, separate runtime design and is NOT claimed as tested here. The
   * production requirement is preserved: the composition receipt insert commits
   * first with its job 'pending', so the deferred 185 guard sees exactly that
   * state at COMMIT. These statements then mark the exact job done and move the
   * accepted head onto the composition revision via plain SQL to provide the
   * accepted root composition precondition for the receipt digest tests. */
  async function setupMarkCompositionJobDone(jobId: string): Promise<void> {
    await setupTransaction(async () => {
      const updated = await fixture.client.query(
        `UPDATE mdf_recalculation_jobs SET status='done', finished_at=now()
         WHERE job_id=$1 AND status='pending'`, [jobId]);
      expect(updated.rowCount).toBe(1);
    });
  }
  async function setupAdvanceAcceptedHead(sourceId: string, revisionKey: string,
    expectedAccepted: string): Promise<void> {
    await setupTransaction(async () => {
      const updated = await fixture.client.query(`UPDATE mdf_source_heads
        SET accepted_revision_key=$2, version=version+1, updated_at=now()
        WHERE source_kind='bazisCutSet' AND source_id=$1
          AND received_revision_key=$2 AND accepted_revision_key=$3`, [sourceId, revisionKey, expectedAccepted]);
      expect(updated.rowCount).toBe(1);
    });
  }
  async function setupAcceptComposition(target: { sourceId: string; jobId: string },
    revisionKey = 'composition', predecessorRevisionKey = 'root-v2'): Promise<void> {
    await setupMarkCompositionJobDone(target.jobId);
    await setupAdvanceAcceptedHead(target.sourceId, revisionKey, predecessorRevisionKey);
  }

  it('persists the appended inherited-state part in the marked carry digest and replays the same body', async () => {
    const source = await seedPendingComposition('marked-carry', 10, false);
    const compositionContext = snapshotMdfExecutionContext(source.composition.executionContext);
    const storedComposition = await payloadDigest(source.sourceId, 'composition');
    expect(storedComposition).toBe(compositionGolden(source.composition, compositionContext));
    // The root composition keeps its distinct assignmentCompositionVersion
    // commitment: no inherited-state part is appended to it.
    expect(storedComposition).not.toBe(markedGolden(source.composition, compositionContext, source.sealedState));

    await setupAcceptComposition(source);
    const compositionCutId = await physicalLineId(source.sourceId, 'composition', 'composition-cut');
    const successor = lineageInput(source.sourceId, 'successor-1',
      [membershipLine('member-1', source.detailId, 10), physicalLine('successor-cut', source.detailId, 10)],
      carryManifest([carryAction('successor-cut', compositionCutId)]), execContext(source.demand),
      await headFence(source.sourceId));
    const saved = await save(successor);
    expect(saved).toMatchObject({ accepted: true, replay: false });
    const successorContext = snapshotMdfExecutionContext(successor.executionContext);
    const stored = await payloadDigest(source.sourceId, 'successor-1');
    expect(stored).toBe(markedGolden(successor, successorContext, source.sealedState));
    // The saved digest must differ from the old (state-blind) base digest, and
    // equality with the explicit golden proves no command raw/preview/
    // allocation pin digests leaked into the inherited part.
    expect(stored).not.toBe(unmarkedGolden(successor, successorContext));
    expect(await assignmentStates(source.sourceId)).toEqual([
      { revision_key: 'composition', assignment_state_id: source.assignmentStateId, root_intent_id: source.intentId,
        predecessor_revision_key: null, predecessor_state_id: null, membership_digest: source.membershipDigest,
        intentional_empty: false },
      { revision_key: 'successor-1', assignment_state_id: source.assignmentStateId, root_intent_id: source.intentId,
        predecessor_revision_key: 'composition', predecessor_state_id: source.assignmentStateId,
        membership_digest: source.membershipDigest, intentional_empty: false }]);
    expect(await effectPolicies(source.sourceId, 'successor-1'))
      .toEqual([{ context_policy: 'forward', job_policy: 'forward', job_status: 'pending' }]);
    expect(await save(successor)).toEqual({ ...saved, replay: true });
    expect(await revisionKeys(source.sourceId)).toEqual(['composition', 'root-v2', 'successor-1']);
  }, 20000);

  it('replays the marked revision from its own frozen state after a later accepted head', async () => {
    const source = await seedPendingComposition('later-head', 10, false);
    await setupAcceptComposition(source);
    const compositionCutId = await physicalLineId(source.sourceId, 'composition', 'composition-cut');
    const first = lineageInput(source.sourceId, 'successor-1',
      [membershipLine('member-1', source.detailId, 10), physicalLine('successor-cut', source.detailId, 10)],
      carryManifest([carryAction('successor-cut', compositionCutId)]), execContext(source.demand),
      await headFence(source.sourceId));
    const savedFirst = await save(first);
    expect(savedFirst).toMatchObject({ accepted: true, replay: false });
    const firstCutId = await physicalLineId(source.sourceId, 'successor-1', 'successor-cut');
    const second = lineageInput(source.sourceId, 'successor-2',
      [membershipLine('member-1', source.detailId, 10), physicalLine('successor-cut-2', source.detailId, 10)],
      carryManifest([carryAction('successor-cut-2', firstCutId)]), execContext(source.demand),
      await headFence(source.sourceId));
    const savedSecond = await save(second);
    expect(savedSecond).toMatchObject({ accepted: true, replay: false });
    // The chain keeps the exact marker identity while physical lineage points
    // to the actual previous evidence IDs.
    expect(await payloadDigest(source.sourceId, 'successor-2')).toBe(markedGolden(second,
      snapshotMdfExecutionContext(second.executionContext),
      { ...source.sealedState, predecessorRevisionKey: 'successor-1' }));

    const headNow = await headRow(source.sourceId);
    expect(headNow).toMatchObject({ received_revision_key: 'successor-2', accepted_revision_key: 'successor-2' });
    const before = await fixture.snapshot(regressionRelations);
    const firstDigest = await payloadDigest(source.sourceId, 'successor-1');
    // Replay must use the replayed revision's immutable frozen predecessor and
    // state, not today's accepted head, and must add no records.
    expect(await save(first)).toEqual({ replay: true, accepted: false, version: headNow.version,
      correctionEpoch: headNow.correction_epoch, jobId: savedFirst.jobId });
    expect(await payloadDigest(source.sourceId, 'successor-1')).toBe(firstDigest);
    expect(await fixture.snapshot(regressionRelations)).toEqual(before);
  }, 20000);

  it('fails closed on marked replay when the root composition job authority is revoked', async () => {
    const source = await seedPendingComposition('replay-authority', 10, false);
    await setupAcceptComposition(source);
    const compositionCutId = await physicalLineId(source.sourceId, 'composition', 'composition-cut');
    const successor = lineageInput(source.sourceId, 'successor-1',
      [membershipLine('member-1', source.detailId, 10), physicalLine('successor-cut', source.detailId, 10)],
      carryManifest([carryAction('successor-cut', compositionCutId)]), execContext(source.demand),
      await headFence(source.sourceId));
    const saved = await save(successor);
    expect(saved).toMatchObject({ accepted: true, replay: false });
    // TEST SETUP ONLY — a deliberately inconsistent fixture, distinct from the
    // pending-root first-write case: the marked successor was sealed with a
    // done root job, and the exact root job is now moved back to 'pending'
    // through the ordinary job-status guards (no trigger is disabled, and no
    // production-worker state is claimed). The new frozen replay authority
    // query must revalidate that persisted chain and fail closed instead of
    // trusting the stored digest.
    try {
      await setupTransaction(async () => {
        const reverted = await fixture.client.query(
          `UPDATE mdf_recalculation_jobs SET status='pending', finished_at=NULL
           WHERE job_id=$1 AND status='done'`, [source.jobId]);
        expect(reverted.rowCount).toBe(1);
      });
      const revoked = await fixture.snapshot(regressionRelations);
      const headRevoked = await headRow(source.sourceId);
      await expect(save(successor)).rejects.toMatchObject({ code: 'MDF_LINEAGE_INVALID' });
      expect(await headRow(source.sourceId)).toEqual(headRevoked);
      expect(await fixture.snapshot(regressionRelations)).toEqual(revoked);
    } finally {
      // TEST SETUP restore of the done authority in every outcome, after
      // which the byte-identical replay must succeed again.
      await setupTransaction(async () => {
        await fixture.client.query(`UPDATE mdf_recalculation_jobs SET status='done', finished_at=now()
          WHERE job_id=$1 AND status='pending'`, [source.jobId]);
      });
    }
    expect(await save(successor)).toEqual({ ...saved, replay: true });
  }, 20000);

  it('marked correction inherits the state while keeping publish_only and epoch semantics', async () => {
    const source = await seedPendingComposition('marked-correction', 10, false);
    await setupAcceptComposition(source);
    const compositionCutId = await physicalLineId(source.sourceId, 'composition', 'composition-cut');
    const first = lineageInput(source.sourceId, 'successor-1',
      [membershipLine('member-1', source.detailId, 10), physicalLine('successor-cut', source.detailId, 10)],
      carryManifest([carryAction('successor-cut', compositionCutId)]), execContext(source.demand),
      await headFence(source.sourceId));
    expect(await save(first)).toMatchObject({ accepted: true, replay: false });
    const firstCutId = await physicalLineId(source.sourceId, 'successor-1', 'successor-cut');
    const correction = lineageInput(source.sourceId, 'correction-1',
      [membershipLine('member-1', source.detailId, 10), physicalLine('correction-cut', source.detailId, 8)],
      correctionManifest([{ lineKey: 'correction-cut', action: 'reduce', predecessorEvidenceLineId: firstCutId }]),
      execContext(source.demand), await headFence(source.sourceId));
    const saved = await save(correction);
    expect(saved).toMatchObject({ accepted: true, replay: false, correctionEpoch: '1' });
    const publishedContext = snapshotMdfExecutionContext({ ...snapshotMdfExecutionContext(correction.executionContext),
      effectPolicy: 'publish_only' });
    const stored = await payloadDigest(source.sourceId, 'correction-1');
    expect(stored).toBe(markedGolden(correction, publishedContext,
      { ...source.sealedState, predecessorRevisionKey: 'successor-1' }));
    expect(stored).not.toBe(unmarkedGolden(correction, publishedContext));
    expect(await effectPolicies(source.sourceId, 'correction-1')).toEqual([{ context_policy: 'publish_only',
      job_policy: 'publish_only', job_status: 'pending' }]);
    expect(await assignmentStates(source.sourceId)).toContainEqual({ revision_key: 'correction-1',
      assignment_state_id: source.assignmentStateId, root_intent_id: source.intentId,
      predecessor_revision_key: 'successor-1', predecessor_state_id: source.assignmentStateId,
      membership_digest: source.membershipDigest, intentional_empty: false });
    expect((await headRow(source.sourceId)).correction_epoch).toBe('1');
    expect(await save(correction)).toEqual({ ...saved, replay: true });
  }, 20000);

  it('inherits the exact intentional-empty marker without fabricating membership facts', async () => {
    const source = await seedPendingComposition('empty-marker', 7, true);
    const emptyDigest = mdfBazisMembershipDigest([]);
    expect(source.membershipDigest).toBe(emptyDigest);
    await setupAcceptComposition(source);
    const compositionCutId = await physicalLineId(source.sourceId, 'composition', 'composition-cut');
    const successor = lineageInput(source.sourceId, 'successor-1',
      [physicalLine('successor-cut', source.detailId, 7)],
      carryManifest([carryAction('successor-cut', compositionCutId)]), execContext(source.demand),
      await headFence(source.sourceId));
    const saved = await save(successor);
    expect(saved).toMatchObject({ accepted: true, replay: false });
    const successorContext = snapshotMdfExecutionContext(successor.executionContext);
    const stored = await payloadDigest(source.sourceId, 'successor-1');
    expect(stored).toBe(markedGolden(successor, successorContext, source.sealedState));
    expect(stored).not.toBe(unmarkedGolden(successor, successorContext));
    expect(await assignmentStates(source.sourceId)).toEqual([
      { revision_key: 'composition', assignment_state_id: source.assignmentStateId, root_intent_id: source.intentId,
        predecessor_revision_key: null, predecessor_state_id: null, membership_digest: emptyDigest,
        intentional_empty: true },
      { revision_key: 'successor-1', assignment_state_id: source.assignmentStateId, root_intent_id: source.intentId,
        predecessor_revision_key: 'composition', predecessor_state_id: source.assignmentStateId,
        membership_digest: emptyDigest, intentional_empty: true }]);
    // Nothing may be manufactured into the empty-marked descendant.
    expect((await fixture.client.query<{ membership_lines: string }>(`SELECT count(*)::text membership_lines
      FROM mdf_evidence_lines WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key='successor-1'
        AND stage_code='membership' AND evidence_kind='derived'`, [source.sourceId])).rows)
      .toEqual([{ membership_lines: '0' }]);
    expect((await fixture.client.query<{ physical_lines: string }>(`SELECT count(*)::text physical_lines
      FROM mdf_evidence_lines WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key='successor-1'
        AND evidence_kind='physical'`, [source.sourceId])).rows).toEqual([{ physical_lines: '1' }]);
    expect(await save(successor)).toEqual({ ...saved, replay: true });
  }, 20000);

  it('keeps unmarked v1 and v2 digest bytes unchanged across a later first composition', async () => {
    const setId = ++setSequence;
    const sourceId = String(setId);
    const detailId = 9_000 + setId;
    const demand: Demand = [{ orderId: 1, detailId, quantity: 5 }];
    const member = membershipLine('member-1', detailId, 5);
    const legacyInput: MdfReceiptInput = { sourceKind: 'bazisCutSet', sourceId, revisionKey: 'legacy-1',
      origin: 'manual', actorUserId: 158, requestId: `legacy-${sourceId}`, causeKey: `legacy-cause-${sourceId}`,
      expectedFence: null, accept: true, lines: [member], rules: [] };
    const legacy = await saveLegacy(legacyInput);
    expect(legacy).toMatchObject({ accepted: true, replay: false });
    // v1 golden assembled independently of production code: no context, no
    // lineage, and no inherited part may ever appear.
    expect(await payloadDigest(sourceId, 'legacy-1')).toBe(legacyGolden(legacyInput));
    const unmarkedV2 = lineageInput(sourceId, 'v2-membership', [member], carryManifest([]),
      execContext(demand), { version: legacy.version, correctionEpoch: legacy.correctionEpoch });
    const v2 = await save(unmarkedV2);
    expect(v2).toMatchObject({ accepted: true, replay: false });
    const v2Context = snapshotMdfExecutionContext(unmarkedV2.executionContext);
    expect(await payloadDigest(sourceId, 'v2-membership'))
      .toBe(unmarkedGolden(unmarkedV2, v2Context));
    const composition: CompositionReceiptInput = {
      ...lineageInput(sourceId, 'composition', [member], carryManifest([]), execContext(demand),
        { version: v2.version, correctionEpoch: v2.correctionEpoch }),
      composition: { intentId: randomUUID(), assignmentStateId: randomUUID(), jobId: randomUUID(),
        setId, setVersion: 1, rawSnapshotDigest: hash64(`raw-unmarked-${setId}`),
        membershipDigest: mdfBazisMembershipDigest([member]), intentionalEmpty: false, ownerIds: [1],
        allocationSnapshotDigest: hash64(`allocation-unmarked-${setId}`),
        previewDigest: hash64(`preview-unmarked-${setId}`),
        commandKey: `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}` },
    };
    const queued = await saveComposition(composition);
    expect(queued).toMatchObject({ accepted: false, replay: false, jobId: composition.composition.jobId });
    expect(await payloadDigest(sourceId, 'composition'))
      .toBe(compositionGolden(composition, snapshotMdfExecutionContext(composition.executionContext)));
    await setupAcceptComposition({ sourceId, jobId: composition.composition.jobId }, 'composition', 'v2-membership');
    const headNow = await headRow(sourceId);
    expect(headNow).toMatchObject({ received_revision_key: 'composition', accepted_revision_key: 'composition' });
    const before = await fixture.snapshot(regressionRelations);
    // Old unmarked replays after a later first composition must keep the old
    // digest path: no source-wide marker and no current head state may be
    // inferred onto historical unmarked revisions.
    expect(await saveLegacy(legacyInput)).toEqual({ replay: true, accepted: false, version: headNow.version,
      correctionEpoch: headNow.correction_epoch, jobId: legacy.jobId });
    expect(await save(unmarkedV2)).toEqual({ replay: true, accepted: false, version: headNow.version,
      correctionEpoch: headNow.correction_epoch, jobId: v2.jobId });
    expect(await payloadDigest(sourceId, 'legacy-1')).toBe(legacyGolden(legacyInput));
    expect(await payloadDigest(sourceId, 'v2-membership')).toBe(unmarkedGolden(unmarkedV2, v2Context));
    expect((await assignmentStates(sourceId)).map(row => row.revision_key)).toEqual(['composition']);
    expect(await revisionKeys(sourceId)).toEqual(['composition', 'legacy-1', 'v2-membership']);
    expect(await fixture.snapshot(regressionRelations)).toEqual(before);
  }, 20000);

  it('conflicts a changed replay body and rejects changed inherited membership atomically', async () => {
    const source = await seedPendingComposition('conflict', 10, false);
    await setupAcceptComposition(source);
    const compositionCutId = await physicalLineId(source.sourceId, 'composition', 'composition-cut');
    const successor = lineageInput(source.sourceId, 'successor-1',
      [membershipLine('member-1', source.detailId, 10), physicalLine('successor-cut', source.detailId, 10)],
      carryManifest([carryAction('successor-cut', compositionCutId)]), execContext(source.demand),
      await headFence(source.sourceId));
    expect(await save(successor)).toMatchObject({ accepted: true, replay: false });
    const successorCutId = await physicalLineId(source.sourceId, 'successor-1', 'successor-cut');
    const before = await fixture.snapshot(regressionRelations);
    await expect(save({ ...successor, lines: [membershipLine('member-1', source.detailId, 9),
      physicalLine('successor-cut', source.detailId, 10)] }))
      .rejects.toMatchObject({ code: 'MDF_RECEIPT_CONFLICT' });
    // The membership change must be the only defect: 'successor-bad' carries
    // from the actual current accepted physical line, so a pass can never be
    // attributed to a stale composition-cut predecessor instead.
    await expect(save(lineageInput(source.sourceId, 'successor-bad',
      [membershipLine('member-1', source.detailId, 9), physicalLine('bad-cut', source.detailId, 10)],
      carryManifest([carryAction('bad-cut', successorCutId)]), execContext(source.demand),
      await headFence(source.sourceId)))).rejects.toMatchObject({ code: 'MDF_LINEAGE_INVALID' });
    expect(await revisionKeys(source.sourceId)).toEqual(['composition', 'root-v2', 'successor-1']);
    expect(await fixture.snapshot(regressionRelations)).toEqual(before);
  }, 20000);

  it('withholds inherited authority from a pending composition root and malformed predecessors', async () => {
    const source = await seedPendingComposition('pending-root', 10, false);
    const compositionCutId = await physicalLineId(source.sourceId, 'composition', 'composition-cut');
    const successor = lineageInput(source.sourceId, 'successor-1',
      [membershipLine('member-1', source.detailId, 10), physicalLine('successor-cut', source.detailId, 10)],
      carryManifest([carryAction('successor-cut', compositionCutId)]), execContext(source.demand),
      await headFence(source.sourceId));
    // The pending composition revision is received but not accepted: no
    // successor receipt may advance on top of it.
    await expect(save(successor)).rejects.toMatchObject({ code: 'MDF_SOURCE_STALE' });
    expect(await revisionKeys(source.sourceId)).toEqual(['composition', 'root-v2']);
    // TEST SETUP emulating a torn state for the authority check: the accepted
    // head moved to the composition revision while the exact job is still
    // pending. The marker must not authorize a successor until the job is done.
    await setupAdvanceAcceptedHead(source.sourceId, 'composition', 'root-v2');
    await expect(save({ ...successor, expectedFence: await headFence(source.sourceId) }))
      .rejects.toMatchObject({ code: 'MDF_LINEAGE_INVALID' });
    expect(await revisionKeys(source.sourceId)).toEqual(['composition', 'root-v2']);
    expect((await assignmentStates(source.sourceId)).map(row => row.revision_key)).toEqual(['composition']);
    // Control: the same successor becomes admissible once the exact job is done.
    await setupMarkCompositionJobDone(source.jobId);
    const saved = await save({ ...successor, expectedFence: await headFence(source.sourceId) });
    expect(saved).toMatchObject({ accepted: true, replay: false });
    expect(await payloadDigest(source.sourceId, 'successor-1')).toBe(markedGolden(successor,
      snapshotMdfExecutionContext(successor.executionContext), source.sealedState));
    const foreign = await seedPendingComposition('foreign-child', 4, false);
    const foreignCutId = await physicalLineId(foreign.sourceId, 'composition', 'composition-cut');
    // Missing, stale, and foreign physical parents are rejected where the
    // guards still permit construction. Direct SQL forgery of the markers
    // themselves is already rejected by migration 185's own guards, so it is
    // not re-forced here by disabling production guards.
    const badParents: readonly { revisionKey: string; lineKey: string; predecessorEvidenceLineId: string }[] = [
      { revisionKey: 'successor-missing-parent', lineKey: 'missing-cut', predecessorEvidenceLineId: randomUUID() },
      { revisionKey: 'successor-stale-parent', lineKey: 'stale-cut',
        predecessorEvidenceLineId: await physicalLineId(source.sourceId, 'root-v2', 'root-cut') },
      { revisionKey: 'successor-foreign-parent', lineKey: 'foreign-cut', predecessorEvidenceLineId: foreignCutId },
    ];
    for (const bad of badParents) {
      await expect(save(lineageInput(source.sourceId, bad.revisionKey,
        [membershipLine('member-1', source.detailId, 10), physicalLine(bad.lineKey, source.detailId, 10)],
        carryManifest([carryAction(bad.lineKey, bad.predecessorEvidenceLineId)]), execContext(source.demand),
        await headFence(source.sourceId)))).rejects.toMatchObject({ code: 'MDF_LINEAGE_INVALID' });
    }
    await expect(save(lineageInput(source.sourceId, 'successor-no-action',
      [membershipLine('member-1', source.detailId, 10), physicalLine('uncovered-cut', source.detailId, 10)],
      carryManifest([]), execContext(source.demand), await headFence(source.sourceId))))
      .rejects.toMatchObject({ code: 'MDF_LINEAGE_INVALID' });
    expect(await revisionKeys(source.sourceId)).toEqual(['composition', 'root-v2', 'successor-1']);
    expect((await assignmentStates(source.sourceId)).map(row => row.revision_key))
      .toEqual(['composition', 'successor-1']);
  }, 60000);
});
