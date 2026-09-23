import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMdfCorrectionPgFixture } from './mdf-correction-test-fixture.integration';
import type { MdfExecutionContext } from '../domain/mdf-execution-context';
import type { MdfReceiptFence, MdfReceiptLine } from '../application/mdf-receipt';
import { recordMdfReceipt } from '../application/mdf-receipt';
import { recordMdfLineageReceipt, type MdfLineageReceiptInput } from '../application/mdf-receipt';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';
type Action = MdfLineageReceiptInput['lineage']['actions'][number];
type Manifest = MdfLineageReceiptInput['lineage'];

describe.skipIf(!enabled)('MDF persisted physical lineage, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e_mdf_lineage');
  let databaseService: ReturnType<typeof fixture.createDatabaseService> | undefined;
  const database = () => {
    if (!databaseService) throw new Error('MDF_TEST_DATABASE_NOT_READY');
    return databaseService;
  };
  const revisionLines = async (sourceId: string, revisionKey: string, sourceKind = 'bazisCutSet') => (await fixture.client.query<{
    evidence_line_id: string; line_key: string; order_id: string; detail_id: string; quantity: string;
    stage_code: string; evidence_kind: string; rework: boolean;
  }>(`SELECT evidence_line_id,line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework
      FROM mdf_evidence_lines WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3
      ORDER BY line_key`, [sourceKind, sourceId, revisionKey])).rows;
  const context = (demand: readonly { orderId: number; detailId: number; quantity: number }[]): MdfExecutionContext => ({
    sourceCreatedAt: '2026-09-01T00:00:00.000Z', displayName: 'E2E physical lineage',
    priorColumn: 'parsed', compositionComplete: true, demand,
  });
  const membership = (lineKey: string, detailId: number, quantity: number, rework = false): MdfReceiptLine => ({
    lineKey, orderId: 1, detailId, quantity, stageCode: 'membership', evidenceKind: 'derived', rework,
  });
  const physical = (lineKey: string, detailId: number, quantity: number, rework = false): MdfReceiptLine => ({
    lineKey, orderId: 1, detailId, quantity, stageCode: 'cut', evidenceKind: 'physical', rework,
  });
  const declaration = (lineKey: string, detailId: number, quantity: number): MdfReceiptLine => ({
    lineKey, orderId: 1, detailId, quantity, stageCode: 'cut', evidenceKind: 'declaration', rework: false,
  });
  const manifest = (operation: Manifest['operation'], actions: readonly Action[], extra: Partial<Manifest> = {}): Manifest => ({
    operation,
    ...(operation === 'production' ? { authority: 'manual_production' as const } : {}),
    actions,
    droppedPredecessorEvidenceLineIds: [],
    ...extra,
  });
  const input = (sourceId: string, revisionKey: string, lines: readonly MdfReceiptLine[], lineage: Manifest,
    expectedFence: MdfReceiptFence | null, options: { accept?: boolean; sourceKind?: 'packet' | 'bazisCutSet' | 'bath';
      origin?: 'manual' | 'cnc'; demand: readonly { orderId: number; detailId: number; quantity: number }[] }): MdfLineageReceiptInput => ({
    sourceKind: options.sourceKind ?? 'bazisCutSet', sourceId, revisionKey, origin: options.origin ?? 'manual', actorUserId: 158,
    requestId: `lineage-request-${sourceId}-${revisionKey}`, causeKey: `lineage-cause-${sourceId}-${revisionKey}`,
    expectedFence, accept: options.accept ?? true, sourceDigest: undefined,
    executionContext: context(options.demand),
    lines, rules: [], lineage,
  });
  const save = (value: MdfLineageReceiptInput) => database().transaction(tx => recordMdfLineageReceipt(tx, value));
  const expectLineageGuard = async (statement: string, params: readonly unknown[] = []) => {
    await fixture.client.query('BEGIN');
    try {
      await expect(fixture.client.query(statement, [...params])).rejects.toMatchObject({ code: '55000' });
    } finally {
      await fixture.client.query('ROLLBACK');
    }
  };

  beforeAll(async () => {
    await fixture.connect();
    await fixture.applyMigrations([
      '165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql', '175_mdf_command_placement.sql',
      '178_mdf_correction_receipts.sql', '182_mdf_physical_lineage.sql',
    ]);
    await fixture.assertLocalRelations([
      'mdf_evidence_revisions', 'mdf_revision_context', 'mdf_revision_seals', 'mdf_source_heads',
      'mdf_evidence_lines', 'mdf_recalculation_jobs', 'mdf_recalculation_job_rules',
      'mdf_physical_lineage_contracts', 'mdf_physical_lineage_transitions',
    ]);
    databaseService = fixture.createDatabaseService();
  }, 30000);

  afterAll(async () => {
    await databaseService?.onModuleDestroy();
    await fixture.drop();
  });

  it('budgets new physical roots by position and rework after retaining carried overproof', async () => {
    const sourceId = `capacity-${randomUUID()}`;
    const first = await save(input(sourceId, '1', [membership('member-a', 11, 10), physical('cut-a', 11, 10)],
      manifest('production', [{ lineKey: 'cut-a', action: 'root' }]), null,
      { demand: [{ orderId: 1, detailId: 11, quantity: 10 }] }));
    const prior = await revisionLines(sourceId, '1');
    const priorCutId = prior.find(line => line.line_key === 'cut-a')!.evidence_line_id;

    const carried = await save(input(sourceId, '2', [
      membership('member-a2', 11, 8), physical('cut-a2', 11, 10),
      membership('member-b', 12, 3), physical('cut-b', 12, 3),
      membership('member-r', 13, 5, true), physical('cut-r', 13, 5, true),
    ], manifest('production', [
      { lineKey: 'cut-a2', action: 'carry', predecessorEvidenceLineId: priorCutId },
      { lineKey: 'cut-b', action: 'root' }, { lineKey: 'cut-r', action: 'root' },
    ]), { version: first.version, correctionEpoch: first.correctionEpoch }, {
      demand: [{ orderId: 1, detailId: 11, quantity: 8 }, { orderId: 1, detailId: 12, quantity: 3 },
        { orderId: 1, detailId: 13, quantity: 5 }],
    }));
    expect(carried).toMatchObject({ accepted: true, replay: false, version: '2' });
    expect((await revisionLines(sourceId, '2')).filter(line => line.evidence_kind === 'physical')
      .map(line => [line.detail_id, line.quantity, line.rework])).toEqual([
      ['11', '10', false], ['12', '3', false], ['13', '5', true],
    ]);

    const tooMuchId = `over-root-${randomUUID()}`;
    await expect(save(input(tooMuchId, '1', [membership('m', 21, 3), physical('p', 21, 4)],
      manifest('production', [{ lineKey: 'p', action: 'root' }]), null,
      { demand: [{ orderId: 1, detailId: 21, quantity: 3 }] })))
      .rejects.toMatchObject({ code: 'MDF_LINEAGE_INVALID' });
    expect((await fixture.client.query('SELECT 1 FROM mdf_source_heads WHERE source_id=$1', [tooMuchId])).rows)
      .toHaveLength(0);

    const aggregateId = `over-aggregate-${randomUUID()}`;
    await expect(save(input(aggregateId, '1', [membership('m', 22, 3), physical('p1', 22, 2), physical('p2', 22, 2)],
      manifest('production', [{ lineKey: 'p1', action: 'root' }, { lineKey: 'p2', action: 'root' }]), null,
      { demand: [{ orderId: 1, detailId: 22, quantity: 3 }] })))
      .rejects.toMatchObject({ code: 'MDF_LINEAGE_INVALID' });

    // Capacity is partitioned by rework as well as order/detail: the combined
    // sum (10) fits the combined membership (10), but neither partition does.
    const reworkId = `over-rework-${randomUUID()}`;
    await expect(save(input(reworkId, '1', [
      membership('normal-member', 23, 3), membership('rework-member', 23, 7, true),
      physical('normal-root', 23, 4), physical('rework-root', 23, 6, true),
    ], manifest('production', [
      { lineKey: 'normal-root', action: 'root' }, { lineKey: 'rework-root', action: 'root' },
    ]), null, { demand: [{ orderId: 1, detailId: 23, quantity: 10 }] })))
      .rejects.toMatchObject({ code: 'MDF_LINEAGE_INVALID' });

    // Each quantity is representable, but the normal physical aggregate is
    // not a safe integer. It must fail closed as a lineage contract violation.
    const overflowId = `overflow-root-${randomUUID()}`;
    await expect(save(input(overflowId, '1', [
      membership('large-member', 24, Number.MAX_SAFE_INTEGER),
      physical('large-root', 24, Number.MAX_SAFE_INTEGER), physical('extra-root', 24, 1),
    ], manifest('production', [
      { lineKey: 'large-root', action: 'root' }, { lineKey: 'extra-root', action: 'root' },
    ]), null, { demand: [{ orderId: 1, detailId: 24, quantity: Number.MAX_SAFE_INTEGER }] })))
      .rejects.toMatchObject({ code: 'MDF_LINEAGE_INVALID' });
  });

  it('requires a complete exact predecessor manifest and rejects historical or foreign proof', async () => {
    const sourceId = `predecessor-${randomUUID()}`;
    const first = await save(input(sourceId, '1', [membership('m1', 31, 10), physical('p1', 31, 10)],
      manifest('production', [{ lineKey: 'p1', action: 'root' }]), null,
      { demand: [{ orderId: 1, detailId: 31, quantity: 10 }] }));
    const firstCutId = (await revisionLines(sourceId, '1')).find(line => line.line_key === 'p1')!.evidence_line_id;
    const second = await save(input(sourceId, '2', [membership('m2', 31, 10), physical('p2', 31, 10)],
      manifest('carry', [{ lineKey: 'p2', action: 'carry', predecessorEvidenceLineId: firstCutId }]),
      { version: first.version, correctionEpoch: first.correctionEpoch },
      { demand: [{ orderId: 1, detailId: 31, quantity: 10 }] }));
    const secondCutId = (await revisionLines(sourceId, '2')).find(line => line.line_key === 'p2')!.evidence_line_id;

    await expect(save(input(sourceId, '3', [membership('m3', 31, 10), physical('p3', 31, 10)],
      manifest('carry', [{ lineKey: 'p3', action: 'carry', predecessorEvidenceLineId: firstCutId }]),
      { version: second.version, correctionEpoch: second.correctionEpoch },
      { demand: [{ orderId: 1, detailId: 31, quantity: 10 }] })))
      .rejects.toMatchObject({ code: 'MDF_LINEAGE_INVALID' });
    await expect(save(input(`foreign-${randomUUID()}`, '1', [membership('mf', 31, 10), physical('pf', 31, 10)],
      manifest('carry', [{ lineKey: 'pf', action: 'carry', predecessorEvidenceLineId: secondCutId }]), null,
      { demand: [{ orderId: 1, detailId: 31, quantity: 10 }] })))
      .rejects.toMatchObject({ code: 'MDF_LINEAGE_INVALID' });
    expect((await fixture.client.query('SELECT count(*)::int AS n FROM mdf_evidence_revisions WHERE source_id=$1', [sourceId])).rows[0].n)
      .toBe(2);
  });

  it('binds authority by source kind and preserves the canonical root across accepted carry', async () => {
    const packetId = `packet-lineage-${randomUUID()}`;
    const packetOptions = { sourceKind: 'packet' as const, origin: 'cnc' as const,
      demand: [{ orderId: 1, detailId: 32, quantity: 2 }] };
    const first = await save(input(packetId, '1', [membership('m', 32, 2), physical('cut-root', 32, 2)],
      manifest('production', [{ lineKey: 'cut-root', action: 'root' }], { authority: 'cnc_observation' }), null, packetOptions));
    const firstLine = (await revisionLines(packetId, '1', 'packet')).find(line => line.line_key === 'cut-root')!;
    const firstOrigin = (await fixture.client.query<{ canonical_origin_evidence_line_id: string }>(`
      SELECT canonical_origin_evidence_line_id::text FROM mdf_physical_lineage_transitions
      WHERE evidence_line_id=$1`, [firstLine.evidence_line_id])).rows[0].canonical_origin_evidence_line_id;
    expect(firstOrigin).toBe(firstLine.evidence_line_id);

    const carried = await save(input(packetId, '2', [membership('m2', 32, 2), physical('cut-carry', 32, 2)],
      manifest('carry', [{ lineKey: 'cut-carry', action: 'carry', predecessorEvidenceLineId: firstLine.evidence_line_id }]),
      { version: first.version, correctionEpoch: first.correctionEpoch }, { ...packetOptions, origin: 'manual' }));
    const carriedLine = (await revisionLines(packetId, '2', 'packet')).find(line => line.line_key === 'cut-carry')!;
    const carriedOrigin = (await fixture.client.query<{ canonical_origin_evidence_line_id: string }>(`
      SELECT canonical_origin_evidence_line_id::text FROM mdf_physical_lineage_transitions
      WHERE evidence_line_id=$1`, [carriedLine.evidence_line_id])).rows[0].canonical_origin_evidence_line_id;
    expect(carriedOrigin).toBe(firstOrigin);

    const bathId = `bath-lineage-${randomUUID()}`;
    const bathOptions = { sourceKind: 'bath' as const, origin: 'manual' as const,
      demand: [{ orderId: 1, detailId: 33, quantity: 3 }] };
    const bath = await save(input(bathId, '1', [membership('bm', 33, 3), {
      ...physical('laminated-root', 33, 3), stageCode: 'laminated',
    }], manifest('production', [{ lineKey: 'laminated-root', action: 'root' }]), null, bathOptions));
    expect(bath.accepted).toBe(true);
    expect((await revisionLines(bathId, '1', 'bath')).find(line => line.line_key === 'laminated-root'))
      .toMatchObject({ stage_code: 'laminated', evidence_kind: 'physical' });

    const mismatchId = `packet-authority-mismatch-${randomUUID()}`;
    await expect(save(input(mismatchId, '1', [membership('m', 34, 1), physical('p', 34, 1)],
      manifest('production', [{ lineKey: 'p', action: 'root' }], { authority: 'cnc_observation' }), null,
      { ...packetOptions, origin: 'manual', demand: [{ orderId: 1, detailId: 34, quantity: 1 }] })))
      .rejects.toMatchObject({ code: 'MDF_LINEAGE_INVALID' });
  });

  it('supports explicit correction reduction but never treats omitted parents as implicit drops', async () => {
    const sourceId = `reduce-${randomUUID()}`;
    const first = await save(input(sourceId, '1', [membership('m1', 41, 10), physical('p1', 41, 10)],
      manifest('production', [{ lineKey: 'p1', action: 'root' }]), null,
      { demand: [{ orderId: 1, detailId: 41, quantity: 10 }] }));
    const firstId = (await revisionLines(sourceId, '1')).find(line => line.line_key === 'p1')!.evidence_line_id;
    const carried = await save(input(sourceId, '2', [membership('m2', 41, 8), physical('p2', 41, 10)],
      manifest('production', [{ lineKey: 'p2', action: 'carry', predecessorEvidenceLineId: firstId }]),
      { version: first.version, correctionEpoch: first.correctionEpoch },
      { demand: [{ orderId: 1, detailId: 41, quantity: 8 }] }));
    const carriedId = (await revisionLines(sourceId, '2')).find(line => line.line_key === 'p2')!.evidence_line_id;

    await expect(save(input(sourceId, '3', [membership('m3', 41, 8)],
      manifest('correction', [], { droppedPredecessorEvidenceLineIds: [] }),
      { version: carried.version, correctionEpoch: carried.correctionEpoch },
      { demand: [{ orderId: 1, detailId: 41, quantity: 8 }] })))
      .rejects.toMatchObject({ code: 'MDF_LINEAGE_INVALID' });

    const reduced = await save(input(sourceId, '3', [membership('m3', 41, 8), physical('p3', 41, 8)],
      manifest('correction', [{ lineKey: 'p3', action: 'reduce', predecessorEvidenceLineId: carriedId }]),
      { version: carried.version, correctionEpoch: carried.correctionEpoch },
      { demand: [{ orderId: 1, detailId: 41, quantity: 8 }] }));
    expect(reduced).toMatchObject({ accepted: true, version: '3', correctionEpoch: '1' });
    expect((await revisionLines(sourceId, '3')).filter(line => line.evidence_kind === 'physical')
      .map(line => line.quantity)).toEqual(['8']);
    const originalOrigin = (await fixture.client.query<{ canonical_origin_evidence_line_id: string }>(`
      SELECT canonical_origin_evidence_line_id::text FROM mdf_physical_lineage_transitions WHERE evidence_line_id=$1`, [firstId]))
      .rows[0].canonical_origin_evidence_line_id;
    const reducedLineId = (await revisionLines(sourceId, '3')).find(line => line.line_key === 'p3')!.evidence_line_id;
    const reducedOrigin = (await fixture.client.query<{ canonical_origin_evidence_line_id: string }>(`
      SELECT canonical_origin_evidence_line_id::text FROM mdf_physical_lineage_transitions WHERE evidence_line_id=$1`, [reducedLineId]))
      .rows[0].canonical_origin_evidence_line_id;
    expect(reducedOrigin).toBe(originalOrigin);
  });

  it('permits a full physical drop only when every predecessor is explicitly listed by correction', async () => {
    const sourceId = `drop-${randomUUID()}`;
    const first = await save(input(sourceId, '1', [membership('m1', 45, 4), physical('p1', 45, 4)],
      manifest('production', [{ lineKey: 'p1', action: 'root' }]), null,
      { demand: [{ orderId: 1, detailId: 45, quantity: 4 }] }));
    const predecessor = (await revisionLines(sourceId, '1')).find(line => line.line_key === 'p1')!.evidence_line_id;
    const dropped = await save(input(sourceId, '2', [membership('m2', 45, 4)],
      manifest('correction', [], { droppedPredecessorEvidenceLineIds: [predecessor] }),
      { version: first.version, correctionEpoch: first.correctionEpoch },
      { demand: [{ orderId: 1, detailId: 45, quantity: 4 }] }));
    expect(dropped).toMatchObject({ accepted: true, version: '2', correctionEpoch: '1' });
    expect((await revisionLines(sourceId, '2')).filter(line => line.evidence_kind === 'physical')).toEqual([]);
    await expect(save(input(sourceId, '3', [membership('m3', 45, 4), physical('resurrect', 45, 4)],
      manifest('carry', [{ lineKey: 'resurrect', action: 'carry', predecessorEvidenceLineId: predecessor }]),
      { version: dropped.version, correctionEpoch: dropped.correctionEpoch },
      { demand: [{ orderId: 1, detailId: 45, quantity: 4 }] })))
      .rejects.toMatchObject({ code: 'MDF_LINEAGE_INVALID' });
  });

  it('does not let declarations become physical roots or duplicate a root action', async () => {
    const sourceId = `declaration-${randomUUID()}`;
    await expect(save(input(sourceId, '1', [membership('m', 51, 5), declaration('d', 51, 5)],
      manifest('production', [{ lineKey: 'd', action: 'root' }]), null,
      { demand: [{ orderId: 1, detailId: 51, quantity: 5 }] })))
      .rejects.toMatchObject({ code: 'MDF_LINEAGE_INVALID' });
    await expect(save(input(sourceId, '1', [membership('m', 51, 5), physical('p', 51, 5)],
      manifest('production', [{ lineKey: 'p', action: 'root' }, { lineKey: 'p', action: 'root' }]), null,
      { demand: [{ orderId: 1, detailId: 51, quantity: 5 }] })))
      .rejects.toMatchObject({ code: 'MDF_LINEAGE_INVALID' });
  });

  it('keeps the sealed lineage manifest and transitions immutable and blocks post-seal transition insertion', async () => {
    const sourceId = `sealed-${randomUUID()}`;
    await save(input(sourceId, '1', [membership('m', 55, 5), physical('p', 55, 5)],
      manifest('production', [{ lineKey: 'p', action: 'root' }]), null,
      { demand: [{ orderId: 1, detailId: 55, quantity: 5 }] }));
    const lineId = (await revisionLines(sourceId, '1')).find(line => line.line_key === 'p')!.evidence_line_id;
    await expectLineageGuard(`UPDATE mdf_physical_lineage_contracts SET operation=operation
      WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key='1'`, [sourceId]);
    await expectLineageGuard('DELETE FROM mdf_physical_lineage_transitions WHERE evidence_line_id=$1', [lineId]);
    await expectLineageGuard(`INSERT INTO mdf_physical_lineage_transitions
      (source_kind,source_id,revision_key,evidence_line_id,action,predecessor_evidence_line_id,canonical_origin_evidence_line_id)
      SELECT source_kind,source_id,revision_key,evidence_line_id,action,predecessor_evidence_line_id,canonical_origin_evidence_line_id
      FROM mdf_physical_lineage_transitions WHERE evidence_line_id=$1`, [lineId]);
    await expectLineageGuard(`INSERT INTO mdf_evidence_lines
      (source_kind,source_id,revision_key,line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework)
      VALUES('bazisCutSet',$1,'1','post-seal',1,55,1,'cut','physical',false)`, [sourceId]);
  });

  it('rejects a direct SQL transition whose child line belongs to a different source', async () => {
    const foreignId = `foreign-child-${randomUUID()}`;
    await database().transaction(tx => recordMdfReceipt(tx, {
      sourceKind: 'bazisCutSet', sourceId: foreignId, revisionKey: 'legacy', origin: 'manual',
      actorUserId: 158, requestId: `legacy-${foreignId}`, causeKey: `legacy-${foreignId}`,
      expectedFence: null, accept: true, rules: [],
      lines: [membership('foreign-m', 91, 5), physical('foreign-p', 91, 5)],
    }));
    const foreignLineId = (await revisionLines(foreignId, 'legacy'))
      .find(line => line.line_key === 'foreign-p')!.evidence_line_id;
    const targetId = `forged-child-${randomUUID()}`;
    await fixture.client.query('BEGIN');
    try {
      await fixture.client.query(`INSERT INTO mdf_evidence_revisions
        (source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key)
        VALUES('bazisCutSet',$1,'1',$2,'manual',158,$3,$4)`, [targetId, 'a'.repeat(64), `target-${targetId}`, `cause-${targetId}`]);
      await fixture.client.query(`INSERT INTO mdf_revision_context
        (source_kind,source_id,revision_key,source_created_at,display_name,prior_column,composition_complete,
          demand_digest,acceptance_requested,predecessor_accepted_revision_key,predecessor_received_revision_key)
        VALUES('bazisCutSet',$1,'1','2026-09-01','forged target','parsed',true,$2,true,NULL,NULL)`,
      [targetId, 'b'.repeat(64)]);
      await fixture.client.query(`INSERT INTO mdf_revision_demand
        (source_kind,source_id,revision_key,order_id,detail_id,quantity)
        VALUES('bazisCutSet',$1,'1',1,91,5)`, [targetId]);
      await fixture.client.query(`INSERT INTO mdf_evidence_lines
        (source_kind,source_id,revision_key,line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework)
        VALUES('bazisCutSet',$1,'1','member',1,91,5,'membership','derived',false),
          ('bazisCutSet',$1,'1','cut',1,91,5,'cut','physical',false)`, [targetId]);
      const targetLine = (await fixture.client.query<{ evidence_line_id: string }>(`SELECT evidence_line_id
        FROM mdf_evidence_lines WHERE source_id=$1 AND revision_key='1' AND line_key='cut'`, [targetId])).rows[0].evidence_line_id;
      await fixture.client.query(`INSERT INTO mdf_physical_lineage_contracts
        (source_kind,source_id,revision_key,operation,production_authority,predecessor_accepted_revision_key,
          manifest_digest,dropped_predecessor_evidence_line_ids)
        VALUES('bazisCutSet',$1,'1','production','manual_production',NULL,$2,ARRAY[]::uuid[])`,
      [targetId, 'c'.repeat(64)]);
      await fixture.client.query(`INSERT INTO mdf_physical_lineage_transitions
        (source_kind,source_id,revision_key,evidence_line_id,action,predecessor_evidence_line_id,canonical_origin_evidence_line_id)
        VALUES('bazisCutSet',$1,'1',$2,'root',NULL,$2),('bazisCutSet',$1,'1',$3,'root',NULL,$3)`,
      [targetId, targetLine, foreignLineId]);
      await expect(fixture.client.query(`INSERT INTO mdf_revision_seals(source_kind,source_id,revision_key)
        VALUES('bazisCutSet',$1,'1')`, [targetId])).rejects.toMatchObject({ code: '23514' });
    } finally {
      await fixture.client.query('ROLLBACK');
    }
    expect((await fixture.client.query(`SELECT count(*)::int AS n FROM mdf_revision_seals
      WHERE source_kind='bazisCutSet' AND source_id=$1 AND revision_key='1'`, [targetId])).rows[0].n).toBe(0);
  });

  it.each([
    { label: 'stage/evidence meaning', memberDetail: 92, demandDetail: 92, stage: 'laminated', memberQty: 5, proofQty: 5 },
    { label: 'frozen demand membership', memberDetail: 91, demandDetail: 92, stage: 'cut', memberQty: 5, proofQty: 5 },
    { label: 'root aggregate capacity', memberDetail: 91, demandDetail: 91, stage: 'cut', memberQty: 3, proofQty: 4 },
  ])('prevents direct SQL from bypassing $label validation at seal time', async scenario => {
    const sourceId = `sql-${randomUUID()}`;
    await fixture.client.query('BEGIN');
    try {
      await fixture.client.query(`INSERT INTO mdf_evidence_revisions
        (source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key)
        VALUES('bazisCutSet',$1,'1',$2,'manual',158,$3,$4)`,
      [sourceId, 'a'.repeat(64), `request-${sourceId}`, `cause-${sourceId}`]);
      await fixture.client.query(`INSERT INTO mdf_revision_context
        (source_kind,source_id,revision_key,source_created_at,display_name,prior_column,composition_complete,
          demand_digest,acceptance_requested,predecessor_accepted_revision_key,predecessor_received_revision_key,effect_policy)
        VALUES('bazisCutSet',$1,'1','2026-09-01','direct SQL bypass','parsed',true,$2,true,NULL,NULL,'forward')`,
      [sourceId, 'b'.repeat(64)]);
      await fixture.client.query(`INSERT INTO mdf_revision_demand
        (source_kind,source_id,revision_key,order_id,detail_id,quantity)
        VALUES('bazisCutSet',$1,'1',1,$2,$3)`, [sourceId, scenario.demandDetail, scenario.memberQty]);
      await fixture.client.query(`INSERT INTO mdf_evidence_lines
        (source_kind,source_id,revision_key,line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework)
        VALUES('bazisCutSet',$1,'1','member',1,$2,$3,'membership','derived',false),
          ('bazisCutSet',$1,'1','physical',1,$2,$4,$5,'physical',false)`,
      [sourceId, scenario.memberDetail, scenario.memberQty, scenario.proofQty, scenario.stage]);
      const lineId = (await fixture.client.query<{ evidence_line_id: string }>(`SELECT evidence_line_id
        FROM mdf_evidence_lines WHERE source_kind='bazisCutSet' AND source_id=$1
          AND revision_key='1' AND line_key='physical'`, [sourceId])).rows[0].evidence_line_id;
      await fixture.client.query(`INSERT INTO mdf_physical_lineage_contracts
        (source_kind,source_id,revision_key,operation,production_authority,predecessor_accepted_revision_key,
          manifest_digest,dropped_predecessor_evidence_line_ids)
        VALUES('bazisCutSet',$1,'1','production','manual_production',NULL,$2,ARRAY[]::uuid[])`,
      [sourceId, 'c'.repeat(64)]);
      await fixture.client.query(`INSERT INTO mdf_physical_lineage_transitions
        (source_kind,source_id,revision_key,evidence_line_id,action,predecessor_evidence_line_id,canonical_origin_evidence_line_id)
        VALUES('bazisCutSet',$1,'1',$2,'root',NULL,$2)`, [sourceId, lineId]);
      await expect(fixture.client.query(`INSERT INTO mdf_revision_seals(source_kind,source_id,revision_key)
        VALUES('bazisCutSet',$1,'1')`, [sourceId])).rejects.toMatchObject({ code: '23514' });
    } finally {
      await fixture.client.query('ROLLBACK');
    }
  });

  it('rejects a NULL element in the dropped-predecessor manifest at seal time', async () => {
    const sourceId = `null-drop-${randomUUID()}`;
    const first = await save(input(sourceId, '1', [membership('m1', 93, 4), physical('p1', 93, 4)],
      manifest('production', [{ lineKey: 'p1', action: 'root' }]), null,
      { demand: [{ orderId: 1, detailId: 93, quantity: 4 }] }));
    const parentLineId = (await revisionLines(sourceId, '1')).find(line => line.line_key === 'p1')!.evidence_line_id;

    await fixture.client.query('BEGIN');
    try {
      await fixture.client.query(`INSERT INTO mdf_evidence_revisions
        (source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key)
        VALUES('bazisCutSet',$1,'2',$2,'manual',158,$3,$4)`,
      [sourceId, 'a'.repeat(64), `request-${sourceId}-2`, `cause-${sourceId}-2`]);
      await fixture.client.query(`INSERT INTO mdf_revision_context
        (source_kind,source_id,revision_key,source_created_at,display_name,prior_column,composition_complete,
          demand_digest,acceptance_requested,predecessor_accepted_revision_key,predecessor_received_revision_key,effect_policy)
        VALUES('bazisCutSet',$1,'2','2026-09-01','NULL drop guard','parsed',true,$2,true,'1','1','publish_only')`,
      [sourceId, 'b'.repeat(64)]);
      await fixture.client.query(`INSERT INTO mdf_revision_demand
        (source_kind,source_id,revision_key,order_id,detail_id,quantity)
        VALUES('bazisCutSet',$1,'2',1,93,4)`, [sourceId]);
      await fixture.client.query(`INSERT INTO mdf_evidence_lines
        (source_kind,source_id,revision_key,line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework)
        VALUES('bazisCutSet',$1,'2','member',1,93,4,'membership','derived',false),
          ('bazisCutSet',$1,'2','physical',1,93,4,'cut','physical',false)`, [sourceId]);
      const childLineId = (await fixture.client.query<{ evidence_line_id: string }>(`SELECT evidence_line_id
        FROM mdf_evidence_lines WHERE source_kind='bazisCutSet' AND source_id=$1
          AND revision_key='2' AND line_key='physical'`, [sourceId])).rows[0].evidence_line_id;
      await fixture.client.query(`INSERT INTO mdf_physical_lineage_contracts
        (source_kind,source_id,revision_key,operation,production_authority,predecessor_accepted_revision_key,
          manifest_digest,dropped_predecessor_evidence_line_ids)
        VALUES('bazisCutSet',$1,'2','correction',NULL,'1',$2,ARRAY[NULL]::uuid[])`,
      [sourceId, 'c'.repeat(64)]);
      await fixture.client.query(`INSERT INTO mdf_physical_lineage_transitions
        (source_kind,source_id,revision_key,evidence_line_id,action,predecessor_evidence_line_id,canonical_origin_evidence_line_id)
        VALUES('bazisCutSet',$1,'2',$2,'carry',$3,$3)`, [sourceId, childLineId, parentLineId]);
      await expect(fixture.client.query(`INSERT INTO mdf_revision_seals(source_kind,source_id,revision_key)
        VALUES('bazisCutSet',$1,'2')`, [sourceId])).rejects.toMatchObject({ code: '23514' });
    } finally {
      await fixture.client.query('ROLLBACK');
    }
    expect((await fixture.client.query(`SELECT received_revision_key,accepted_revision_key
      FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`, [sourceId])).rows)
      .toEqual([{ received_revision_key: '1', accepted_revision_key: '1' }]);
    expect(first).toMatchObject({ accepted: true, version: '1' });
  });

  it('keeps exact lineage replay idempotent and rolls every receipt side table back on late failure', async () => {
    const sourceId = `atomic-${randomUUID()}`;
    const root = input(sourceId, '1', [membership('m', 61, 6), physical('p', 61, 6)],
      manifest('production', [{ lineKey: 'p', action: 'root' }]), null,
      { demand: [{ orderId: 1, detailId: 61, quantity: 6 }] });
    const saved = await save(root);
    expect(await save(root)).toEqual({ ...saved, replay: true });
    await expect(save({ ...root, lineage: manifest('carry', [{ lineKey: 'p', action: 'carry',
      predecessorEvidenceLineId: randomUUID() }]) }))
      .rejects.toMatchObject({ code: 'MDF_RECEIPT_CONFLICT' });

    const orderedId = `ordered-actions-${randomUUID()}`;
    const orderedLines = [membership('member', 64, 3), physical('cut-a', 64, 1),
      physical('cut-B', 64, 1), physical('cut-é', 64, 1)];
    const forwardActions: Action[] = [
      { lineKey: 'cut-a', action: 'root' }, { lineKey: 'cut-B', action: 'root' },
      { lineKey: 'cut-é', action: 'root' },
    ];
    const orderedInput = input(orderedId, '1', orderedLines, manifest('production', forwardActions), null,
      { demand: [{ orderId: 1, detailId: 64, quantity: 3 }] });
    const orderedSaved = await save(orderedInput);
    // Canonical action ordering must not depend on caller order or database
    // collation for mixed-case/Unicode keys.
    expect(await save({ ...orderedInput,
      lineage: manifest('production', [...forwardActions].reverse()) }))
      .toEqual({ ...orderedSaved, replay: true });

    const rollbackId = `rollback-${randomUUID()}`;
    const rollbackInput = input(rollbackId, '1', [membership('m', 62, 7), physical('p', 62, 7)],
      manifest('production', [{ lineKey: 'p', action: 'root' }]), null,
      { demand: [{ orderId: 1, detailId: 62, quantity: 7 }] });
    const before = await fixture.snapshot([
      'mdf_evidence_revisions', 'mdf_evidence_lines', 'mdf_revision_context', 'mdf_revision_demand',
      'mdf_revision_seals', 'mdf_source_heads', 'mdf_recalculation_jobs', 'mdf_recalculation_job_rules',
      'mdf_physical_lineage_contracts', 'mdf_physical_lineage_transitions',
    ]);
    await expect(database().transaction(async tx => {
      await recordMdfLineageReceipt(tx, rollbackInput);
      await tx.query('SELECT 1/0');
    })).rejects.toMatchObject({ code: '22012' });
    expect(await fixture.snapshot(Object.keys(before))).toEqual(before);
  });

  it('does not silently promote v1 physical evidence, while preserving legacy v1 replay', async () => {
    const sourceId = `v1-physical-${randomUUID()}`;
    const legacy: MdfReceiptLine[] = [membership('m1', 71, 10), physical('p1', 71, 10)];
    const oldInput = {
      sourceKind: 'bazisCutSet' as const, sourceId, revisionKey: 'legacy-1', origin: 'manual' as const,
      actorUserId: 158, requestId: `legacy-${sourceId}`, causeKey: `legacy-${sourceId}`,
      expectedFence: null, accept: true, lines: legacy, rules: [],
    };
    const old = await database().transaction(tx => recordMdfReceipt(tx, oldInput));
    expect(await database().transaction(tx => recordMdfReceipt(tx, oldInput)))
      .toEqual({ ...old, replay: true });
    const predecessor = (await revisionLines(sourceId, 'legacy-1')).find(line => line.line_key === 'p1')!.evidence_line_id;
    await expect(save(input(sourceId, '2', [membership('m2', 71, 8), physical('p2', 71, 10)],
      manifest('carry', [{ lineKey: 'p2', action: 'carry', predecessorEvidenceLineId: predecessor }]),
      { version: old.version, correctionEpoch: old.correctionEpoch },
      { demand: [{ orderId: 1, detailId: 71, quantity: 8 }] })))
      .rejects.toMatchObject({ code: 'MDF_LINEAGE_INVALID' });
    expect((await fixture.client.query('SELECT accepted_revision_key,received_revision_key FROM mdf_source_heads WHERE source_id=$1', [sourceId])).rows[0])
      .toEqual({ accepted_revision_key: 'legacy-1', received_revision_key: 'legacy-1' });
  });

  it('preserves legacy v1 pending-revision advancement after migration 182', async () => {
    const sourceId = `v1-pending-compat-${randomUUID()}`;
    const original = {
      sourceKind: 'bazisCutSet' as const, sourceId, revisionKey: '1', origin: 'manual' as const,
      actorUserId: 158, requestId: `v1-${sourceId}`, causeKey: `v1-${sourceId}`,
      expectedFence: null, accept: true, rules: [], lines: [membership('m1', 76, 5)],
    };
    const accepted = await database().transaction(tx => recordMdfReceipt(tx, original));
    const pending = await database().transaction(tx => recordMdfReceipt(tx, {
      ...original, revisionKey: '2', requestId: `v1-pending-${sourceId}`, causeKey: `v1-pending-${sourceId}`,
      expectedFence: { version: accepted.version, correctionEpoch: accepted.correctionEpoch }, accept: false,
      lines: [membership('m2', 76, 4)],
    }));
    expect(pending.accepted).toBe(false);
    const next = await database().transaction(tx => recordMdfReceipt(tx, {
      ...original, revisionKey: '3', requestId: `v1-next-${sourceId}`, causeKey: `v1-next-${sourceId}`,
      expectedFence: { version: pending.version, correctionEpoch: pending.correctionEpoch },
      lines: [membership('m3', 76, 6)],
    }));
    expect(next).toMatchObject({ accepted: true, replay: false, version: '3' });
    expect((await fixture.client.query(`SELECT accepted_revision_key,received_revision_key
      FROM mdf_source_heads WHERE source_id=$1`, [sourceId])).rows[0])
      .toEqual({ accepted_revision_key: '3', received_revision_key: '3' });
  });

  it('serializes concurrent first lineage receipts for one source without accepting both', async () => {
    const sourceId = `lineage-race-${randomUUID()}`;
    const first = input(sourceId, 'r1', [membership('m1', 79, 5), physical('p1', 79, 5)],
      manifest('production', [{ lineKey: 'p1', action: 'root' }]), null,
      { demand: [{ orderId: 1, detailId: 79, quantity: 5 }] });
    const second = input(sourceId, 'r2', [membership('m2', 79, 5), physical('p2', 79, 5)],
      manifest('production', [{ lineKey: 'p2', action: 'root' }]), null,
      { demand: [{ orderId: 1, detailId: 79, quantity: 5 }] });
    const outcomes = await Promise.allSettled([save(first), save(second)]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(result => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'MDF_SOURCE_STALE' } });
    expect((await fixture.client.query(`SELECT count(*)::int AS n FROM mdf_evidence_revisions
      WHERE source_kind='bazisCutSet' AND source_id=$1`, [sourceId])).rows[0].n).toBe(1);
    expect((await fixture.client.query(`SELECT count(*)::int AS n FROM mdf_physical_lineage_contracts
      WHERE source_kind='bazisCutSet' AND source_id=$1`, [sourceId])).rows[0].n).toBe(1);
  });

  it('allows v1 membership-only upgrade, then keeps lineage sticky on a pending v2 head', async () => {
    const sourceId = `v1-membership-${randomUUID()}`;
    const old = await database().transaction(tx => recordMdfReceipt(tx, {
      sourceKind: 'bazisCutSet', sourceId, revisionKey: 'legacy-1', origin: 'manual',
      actorUserId: 158, requestId: `legacy-${sourceId}`, causeKey: `legacy-${sourceId}`,
      expectedFence: null, accept: true, rules: [],
      lines: [membership('legacy-membership', 81, 5)],
    }));
    const upgraded = await save(input(sourceId, 'v2-membership', [membership('member', 81, 5)],
      manifest('carry', []), { version: old.version, correctionEpoch: old.correctionEpoch },
      { demand: [{ orderId: 1, detailId: 81, quantity: 5 }] }));
    expect(upgraded).toMatchObject({ accepted: true, version: '2' });
    const rooted = await save(input(sourceId, 'v2-root', [membership('member-root', 81, 5), physical('cut-root', 81, 5)],
      manifest('production', [{ lineKey: 'cut-root', action: 'root' }]),
      { version: upgraded.version, correctionEpoch: upgraded.correctionEpoch },
      { demand: [{ orderId: 1, detailId: 81, quantity: 5 }] }));
    const rootLineId = (await revisionLines(sourceId, 'v2-root')).find(line => line.line_key === 'cut-root')!.evidence_line_id;
    await fixture.client.query(`INSERT INTO mdf_bath_allocations
      (evidence_line_id,bath_id,bath_revision,order_id,detail_id,quantity,state,cause_key)
      VALUES($1,'lineage-sticky-bath','1',1,81,5,'reserved',$2)`, [rootLineId, `sticky-${sourceId}`]);
    const pending = await save(input(sourceId, 'v2-pending', [membership('member-pending', 81, 5), physical('cut-pending', 81, 5)],
      manifest('carry', [{ lineKey: 'cut-pending', action: 'carry', predecessorEvidenceLineId: rootLineId }]),
      { version: rooted.version, correctionEpoch: rooted.correctionEpoch },
      { demand: [{ orderId: 1, detailId: 81, quantity: 5 }] }));
    expect(pending).toMatchObject({ accepted: false, version: '4' });
    expect((await fixture.client.query(`SELECT accepted_revision_key,received_revision_key
      FROM mdf_source_heads WHERE source_id=$1`, [sourceId])).rows[0])
      .toEqual({ accepted_revision_key: 'v2-root', received_revision_key: 'v2-pending' });
    await expect(fixture.client.query(`UPDATE mdf_source_heads SET received_revision_key='forged-v1'
      WHERE source_kind='bazisCutSet' AND source_id=$1`, [sourceId]))
      .rejects.toMatchObject({ code: '23514' });
    expect((await fixture.client.query(`SELECT accepted_revision_key,received_revision_key
      FROM mdf_source_heads WHERE source_id=$1`, [sourceId])).rows[0])
      .toEqual({ accepted_revision_key: 'v2-root', received_revision_key: 'v2-pending' });
    const pendingCutId = (await revisionLines(sourceId, 'v2-pending')).find(line => line.line_key === 'cut-pending')!.evidence_line_id;
    await expect(save(input(sourceId, 'v2-after-pending', [membership('member-after', 81, 5), physical('cut-after', 81, 5)],
      manifest('carry', [{ lineKey: 'cut-after', action: 'carry', predecessorEvidenceLineId: pendingCutId }]),
      { version: pending.version, correctionEpoch: pending.correctionEpoch },
      { demand: [{ orderId: 1, detailId: 81, quantity: 5 }] })))
      .rejects.toMatchObject({ code: 'MDF_SOURCE_STALE' });
    await expect(database().transaction(tx => recordMdfReceipt(tx, {
      sourceKind: 'bazisCutSet', sourceId, revisionKey: 'legacy-2', origin: 'manual',
      actorUserId: 158, requestId: `legacy-next-${sourceId}`, causeKey: `legacy-next-${sourceId}`,
      expectedFence: { version: pending.version, correctionEpoch: pending.correctionEpoch }, accept: true, rules: [],
      lines: [membership('legacy-membership-next', 81, 5)],
    }))).rejects.toMatchObject({ code: '23514' });
  });
});
