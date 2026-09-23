import { describe, expect, it } from 'vitest';
import { planMdfBazisComposition, type MdfBazisCompositionInput } from './mdf-bazis-composition';
import { calculateMdfQuantities } from './mdf-quantities';
import type { MdfCorrectionAllocation, MdfCorrectionSourceLine } from './mdf-correction-plan';
import { planMdfCompatibleAdvance } from './mdf-compatible-advance';

const sourceKind = 'bazisCutSet' as const;
const sourceId = 'basis-set-1';
const revision = 'basis-r1';
const line = (patch: Partial<MdfCorrectionSourceLine> = {}): MdfCorrectionSourceLine => ({
  orderId: 1,
  detailId: 11,
  quantity: 10,
  evidenceLineId: 'evidence-member-old',
  lineKey: 'member:11',
  revision,
  stage: 'membership',
  evidence: 'derived',
  rework: false,
  ...patch,
});
const physical = (patch: Partial<MdfCorrectionSourceLine> = {}): MdfCorrectionSourceLine => line({
  evidenceLineId: 'evidence-cut-old',
  lineKey: 'cut:11',
  stage: 'cut',
  evidence: 'physical',
  ...patch,
});
const allocation = (patch: Partial<MdfCorrectionAllocation> = {}): MdfCorrectionAllocation => ({
  allocationId: 'allocation-1',
  evidenceLineId: 'evidence-cut-old',
  evidenceSourceKind: sourceKind,
  evidenceSourceId: sourceId,
  evidenceRevision: revision,
  bathId: 'cut-result:41',
  bathRevision: 'bath-r1',
  orderId: 1,
  detailId: 11,
  quantity: 10,
  state: 'consumed',
  ...patch,
});
const input = (patch: Partial<MdfBazisCompositionInput> = {}): MdfBazisCompositionInput => ({
  target: { kind: sourceKind, id: sourceId },
  previousRevision: revision,
  current: {
    kind: sourceKind,
    id: sourceId,
    acceptedRevision: revision,
    receivedRevision: revision,
    lines: [line(), physical()],
  },
  desiredMembership: [{ orderId: 1, detailId: 11, quantity: 8, lineKey: 'member:11', rework: false }],
  allocations: [allocation()],
  ...patch,
});
const ready = (value: MdfBazisCompositionInput) => {
  const result = planMdfBazisComposition(value);
  expect(result.status).toBe('ready');
  if (result.status !== 'ready') throw new Error(`expected ready plan, got ${JSON.stringify(result.blockers)}`);
  return result;
};
const blocked = (value: MdfBazisCompositionInput) => {
  const result = planMdfBazisComposition(value);
  expect(result.status).toBe('blocked');
  if (result.status !== 'blocked') throw new Error('expected blocked plan');
  return result;
};

describe('pure BASIS composition replacement with carried physical facts', () => {
  it('shrinks assignment 10 to 8 but preserves the exact performed-10 fact and its consumed pin', () => {
    const value = input();
    const before = JSON.stringify(value);
    const result = ready(value);

    expect(result.sourceReplacement.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ orderId: 1, detailId: 11, quantity: 8, lineKey: 'member:11',
        stage: 'membership', evidence: 'derived', rework: false }),
      expect.objectContaining({ orderId: 1, detailId: 11, quantity: 10, lineKey: 'cut:11',
        stage: 'cut', evidence: 'physical', rework: false }),
    ]));
    expect(result.lineage).toEqual([{ predecessorEvidenceLineId: 'evidence-cut-old', replacementLineKey: 'cut:11' }]);
    expect(result.allocationReleaseIds).toEqual(['allocation-1']);
    expect(result.allocationReplacementIds).toEqual(['allocation-1']);
    expect(result.allocationReplacements).toEqual([expect.objectContaining({ oldAllocationId: 'allocation-1',
      evidenceLine: { kind: 'replacement', sourceKind, sourceId, lineKey: 'cut:11' },
      bathId: 'cut-result:41', bathRevision: { kind: 'existing', revision: 'bath-r1' }, orderId: 1, detailId: 11,
      quantity: 10, state: 'consumed' })]);
    expect(result.assignmentChanges).toEqual([{ orderId: 1, detailId: 11, rework: false, before: 10, after: 8 }]);
    expect(result.currentActionPositions).toEqual([{ orderId: 1, detailId: 11 }]);
    expect(result.retainedEvidencePositions).toEqual([{ orderId: 1, detailId: 11 }]);
    expect(JSON.stringify(value)).toBe(before);
    expect(result).not.toHaveProperty('bathReplacements');
    expect(result).not.toHaveProperty('statusChanges');
  });

  it('keeps fact quantity separate from assignment and caps only against independent order demand', () => {
    const result = ready(input());
    const fact = result.sourceReplacement.lines.find(row => row.stage === 'cut' && row.evidence === 'physical')!;
    const evidence = [{ source: `${sourceKind}:${sourceId}`, line: fact.lineKey, orderId: fact.orderId,
      detailId: fact.detailId, quantity: fact.quantity, stage: 'cut' as const, kind: 'physical' as const, rework: fact.rework }];

    expect(calculateMdfQuantities({ demand: [{ orderId: 1, detailId: 11, quantity: 10 }], evidence }).positions[0])
      .toMatchObject({ rawCut: 10, creditedCut: 10, remaining: 0 });
    expect(calculateMdfQuantities({ demand: [{ orderId: 1, detailId: 11, quantity: 8 }], evidence }).positions[0])
      .toMatchObject({ rawCut: 10, creditedCut: 8, remaining: 0 });
    expect(calculateMdfQuantities({ demand: [{ orderId: 1, detailId: 11, quantity: 12 }], evidence }).positions[0])
      .toMatchObject({ rawCut: 10, creditedCut: 10, remaining: 2 });
  });

  it('grows assignment 10 to 12 without manufacturing the additional two physical parts', () => {
    const result = ready(input({ desiredMembership: [{ orderId: 1, detailId: 11, quantity: 12,
      lineKey: 'member:11:growth', rework: false }] }));

    expect(result.sourceReplacement.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ detailId: 11, quantity: 12, stage: 'membership', evidence: 'derived' }),
      expect.objectContaining({ detailId: 11, quantity: 10, stage: 'cut', evidence: 'physical' }),
    ]));
    expect(result.assignmentChanges).toEqual([{ orderId: 1, detailId: 11, rework: false, before: 10, after: 12 }]);
    const fact = result.sourceReplacement.lines.find(row => row.stage === 'cut' && row.evidence === 'physical')!;
    const projected = calculateMdfQuantities({ demand: [{ orderId: 1, detailId: 11, quantity: 12 }], evidence: [{
      source: `${sourceKind}:${sourceId}`, line: fact.lineKey, orderId: fact.orderId,
      detailId: fact.detailId, quantity: fact.quantity, stage: 'cut', kind: 'physical', rework: false,
    }] });
    expect(projected.positions[0]).toMatchObject({ rawCut: 10, creditedCut: 10, remaining: 2 });
  });

  it('retains a removed position fact without treating that position as a current assignment action', () => {
    const result = ready(input({ desiredMembership: [] }));

    expect(result.sourceReplacement.lines).toEqual([expect.objectContaining({ orderId: 1, detailId: 11,
      quantity: 10, lineKey: 'cut:11', stage: 'cut', evidence: 'physical', rework: false })]);
    expect(result.lineage).toEqual([{ predecessorEvidenceLineId: 'evidence-cut-old', replacementLineKey: 'cut:11' }]);
    expect(result.currentActionPositions).toEqual([]);
    expect(result.retainedEvidencePositions).toEqual([{ orderId: 1, detailId: 11 }]);
    expect(result.assignmentChanges).toEqual([{ orderId: 1, detailId: 11, rework: false, before: 10, after: 0 }]);
    expect(result.allocationReplacements).toHaveLength(1);
    expect(result.allocationReplacements[0]).toMatchObject({ quantity: 10, state: 'consumed', detailId: 11 });
  });

  it('carries the same performed fact through a second trusted composition shrink', () => {
    const first = ready(input());
    const secondCurrent = {
      kind: sourceKind,
      id: sourceId,
      acceptedRevision: 'basis-r2',
      receivedRevision: 'basis-r2',
      lines: first.sourceReplacement.lines.map(row => ({ ...row,
        evidenceLineId: row.stage === 'membership' ? 'evidence-member-r2' : 'evidence-cut-r2', revision: 'basis-r2' })),
    };
    const second = ready(input({ previousRevision: 'basis-r2', current: secondCurrent,
      desiredMembership: [{ orderId: 1, detailId: 11, quantity: 6, lineKey: 'member:11:r3', rework: false }],
      allocations: [allocation({ evidenceLineId: 'evidence-cut-r2', evidenceRevision: 'basis-r2' })] }));

    expect(second.sourceReplacement.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ detailId: 11, quantity: 6, stage: 'membership', lineKey: 'member:11:r3' }),
      expect.objectContaining({ detailId: 11, quantity: 10, stage: 'cut', evidence: 'physical', lineKey: 'cut:11' }),
    ]));
    expect(second.lineage).toEqual([{ predecessorEvidenceLineId: 'evidence-cut-r2', replacementLineKey: 'cut:11' }]);
    expect(second.allocationReplacements).toEqual([expect.objectContaining({ oldAllocationId: 'allocation-1',
      quantity: 10, state: 'consumed', evidenceLine: { kind: 'replacement', sourceKind, sourceId, lineKey: 'cut:11' } })]);
  });

  it('does not relax generic forward-compatible advance for a changed assignment', () => {
    const value = input();
    const composition = ready(value);
    const next = composition.sourceReplacement.lines.map((row, index) => ({ ...row,
      evidenceLineId: `new-evidence-${index}`, revision: 'basis-r2' }));
    const result = planMdfCompatibleAdvance({ kind: sourceKind, id: sourceId,
      previousRevision: revision, nextRevision: 'basis-r2', previous: value.current.lines, next,
      allocations: value.allocations });

    expect(result).toBeNull();
  });

  it('does not transfer carried facts to a new position or another rework class', () => {
    const result = ready(input({ desiredMembership: [{ orderId: 1, detailId: 12, quantity: 3,
      lineKey: 'member:12', rework: false }] }));

    expect(result.sourceReplacement.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ orderId: 1, detailId: 12, quantity: 3, lineKey: 'member:12',
        stage: 'membership', evidence: 'derived', rework: false }),
      expect.objectContaining({ orderId: 1, detailId: 11, quantity: 10, lineKey: 'cut:11',
        stage: 'cut', evidence: 'physical', rework: false }),
    ]));
    expect(result.currentActionPositions).toEqual([{ orderId: 1, detailId: 12 }]);
    expect(result.retainedEvidencePositions).toEqual([{ orderId: 1, detailId: 11 }]);
    expect(result.allocationReplacements[0]).toMatchObject({ orderId: 1, detailId: 11, quantity: 10 });
    const oldFact = result.sourceReplacement.lines.find(row => row.stage === 'cut' && row.evidence === 'physical')!;
    const positions = calculateMdfQuantities({ demand: [
      { orderId: 1, detailId: 11, quantity: 10 }, { orderId: 1, detailId: 12, quantity: 3 },
    ], evidence: [{ source: `${sourceKind}:${sourceId}`, line: oldFact.lineKey, orderId: oldFact.orderId,
      detailId: oldFact.detailId, quantity: oldFact.quantity, stage: 'cut', kind: 'physical', rework: false }] }).positions;
    expect(positions).toEqual([
      expect.objectContaining({ detailId: 11, rawCut: 10, creditedCut: 10, remaining: 0 }),
      expect.objectContaining({ detailId: 12, rawCut: 0, creditedCut: 0, remaining: 3 }),
    ]);
  });

  it.each([
    ['another detail', { orderId: 1, detailId: 12, quantity: 8, lineKey: 'member:11', rework: false }],
    ['another rework class', { orderId: 1, detailId: 11, quantity: 8, lineKey: 'member:11', rework: true }],
  ] as const)('does not reuse an existing membership line key for %s', (_name, member) => {
    blocked(input({ desiredMembership: [member] }));
  });

  it('preserves rework and declaration facts unchanged while only normal membership is replaced', () => {
    const declaration = line({ evidenceLineId: 'evidence-declaration', lineKey: 'decl:11', stage: 'cut',
      evidence: 'declaration', quantity: 10 });
    const reworkMember = line({ evidenceLineId: 'evidence-member-rework', lineKey: 'member:11:rework',
      quantity: 2, rework: true });
    const reworkCut = physical({ evidenceLineId: 'evidence-cut-rework', lineKey: 'cut:11:rework',
      quantity: 2, rework: true });
    const result = ready(input({ current: { ...input().current, lines: [line(), physical(), reworkMember, reworkCut, declaration] },
      desiredMembership: [
        { orderId: 1, detailId: 11, quantity: 8, lineKey: 'member:11', rework: false },
        { orderId: 1, detailId: 11, quantity: 2, lineKey: 'member:11:rework:new', rework: true },
      ] }));

    expect(result.sourceReplacement.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ lineKey: 'member:11', quantity: 8, stage: 'membership', rework: false }),
      expect.objectContaining({ lineKey: 'cut:11', quantity: 10, stage: 'cut', evidence: 'physical', rework: false }),
      expect.objectContaining({ lineKey: 'member:11:rework:new', quantity: 2, stage: 'membership', rework: true }),
      expect.objectContaining({ lineKey: 'cut:11:rework', quantity: 2, stage: 'cut', evidence: 'physical', rework: true }),
      expect.objectContaining({ lineKey: 'decl:11', quantity: 10, stage: 'cut', evidence: 'declaration', rework: false }),
    ]));
    expect(result.lineage).toEqual(expect.arrayContaining([
      { predecessorEvidenceLineId: 'evidence-cut-old', replacementLineKey: 'cut:11' },
      { predecessorEvidenceLineId: 'evidence-cut-rework', replacementLineKey: 'cut:11:rework' },
    ]));
    expect(result.lineage.some(row => row.predecessorEvidenceLineId === 'evidence-declaration')).toBe(false);
  });

  it('rebases each reserved and consumed active pin exactly once, skips released rows, and is deterministic', () => {
    const rows = [allocation({ allocationId: 'reserved', bathId: 'cut-result:42', bathRevision: 'bath-r2', quantity: 4, state: 'reserved' }),
      allocation({ allocationId: 'consumed', bathId: 'cut-result:41', bathRevision: 'bath-r1', quantity: 6, state: 'consumed' }),
      allocation({ allocationId: 'released', quantity: 9, state: 'released' })];
    const value = input({ allocations: rows });
    const before = JSON.stringify(value);
    const result = ready(value);

    expect(result.allocationReleaseIds).toEqual(['consumed', 'reserved']);
    expect(result.allocationReplacementIds).toEqual(['consumed', 'reserved']);
    expect(result.allocationReplacements).toEqual([
      expect.objectContaining({ oldAllocationId: 'consumed', quantity: 6, state: 'consumed',
        bathId: 'cut-result:41', bathRevision: { kind: 'existing', revision: 'bath-r1' },
        evidenceLine: { kind: 'replacement', sourceKind, sourceId, lineKey: 'cut:11' } }),
      expect.objectContaining({ oldAllocationId: 'reserved', quantity: 4, state: 'reserved',
        bathId: 'cut-result:42', bathRevision: { kind: 'existing', revision: 'bath-r2' },
        evidenceLine: { kind: 'replacement', sourceKind, sourceId, lineKey: 'cut:11' } }),
    ]);
    const reordered = input({ ...value,
      current: { ...value.current, lines: [...value.current.lines].reverse() },
      desiredMembership: [...value.desiredMembership].reverse(), allocations: [...value.allocations].reverse() });
    expect(planMdfBazisComposition(reordered)).toEqual(result);
    expect(JSON.stringify(value)).toBe(before);
  });

  it('rejects split active pins that collectively overbook one physical line, independent of row order', () => {
    const rows = [allocation({ allocationId: 'debit-a', quantity: 6 }), allocation({ allocationId: 'debit-b', quantity: 6 })];
    const first = blocked(input({ allocations: rows }));
    const reversed = blocked(input({ allocations: [...rows].reverse() }));
    expect(first.blockers).toEqual(reversed.blockers);
    expect(first.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ACTIVE_ALLOCATION_EXCEEDS_SUPPLY' })]));
  });

  it.each([
    ['unaccepted received revision', { current: { ...input().current, receivedRevision: 'basis-r2' } }],
    ['wrong source identity', { target: { kind: sourceKind, id: 'other-set' } }],
  ] as const)('blocks %s before constructing a replacement', (_name, patch) => {
    expect(blocked(input(patch as Partial<MdfBazisCompositionInput>)).blockers.length).toBeGreaterThan(0);
  });

  it('does not emit current production actions for a rework-only assignment', () => {
    const result = ready(input({ desiredMembership: [{ orderId: 1, detailId: 11, quantity: 2,
      lineKey: 'member:11:rework-only', rework: true }] }));
    expect(result.currentActionPositions).toEqual([]);
    expect(result.assignmentChanges).toEqual([{ orderId: 1, detailId: 11, rework: false, before: 10, after: 0 },
      { orderId: 1, detailId: 11, rework: true, before: 0, after: 2 }]);
  });

  it.each([
    ['wrong evidence source', allocation({ evidenceSourceId: 'other-set' })],
    ['wrong evidence revision', allocation({ evidenceRevision: 'basis-r0' })],
    ['wrong position', allocation({ detailId: 12 })],
    ['wrong evidence line', allocation({ evidenceLineId: 'not-in-current-source' })],
    ['overdrawn source line', allocation({ quantity: 11 })],
  ] as const)('blocks an active pin with %s', (_name, row) => {
    blocked(input({ allocations: [row] }));
  });

  it('does not permit active pins to declarations or rework facts', () => {
    const declaration = line({ evidenceLineId: 'evidence-declaration', lineKey: 'decl:11', stage: 'cut', evidence: 'declaration' });
    const reworkCut = physical({ evidenceLineId: 'evidence-cut-rework', lineKey: 'cut:11:rework', rework: true });
    for (const fact of [declaration, reworkCut]) {
      blocked(input({ current: { ...input().current, lines: [line(), physical(), fact] },
        allocations: [allocation({ evidenceLineId: fact.evidenceLineId })] }));
    }
    blocked(input({ desiredMembership: [{ orderId: 1, detailId: 11, quantity: 8, lineKey: 'cut:11', rework: false }] }));
  });

  it('blocks duplicate line/evidence/allocation identity and arithmetic overflow', () => {
    const duplicateLine = { ...physical(), evidenceLineId: 'evidence-cut-duplicate' };
    blocked(input({ current: { ...input().current, lines: [line(), physical(), duplicateLine] } }));
    blocked(input({ current: { ...input().current, lines: [line(), physical({ lineKey: 'member:11' })] } }));
    blocked(input({ allocations: [allocation(), allocation()] }));
    blocked(input({ current: { ...input().current, lines: [line({ quantity: Number.MAX_SAFE_INTEGER }),
      line({ evidenceLineId: 'evidence-member-2', lineKey: 'member:11:2', quantity: 1 }), physical()] } }));
    blocked(input({ current: { ...input().current, lines: [line(), physical({ quantity: Number.MAX_SAFE_INTEGER }),
      physical({ evidenceLineId: 'evidence-cut-2', lineKey: 'cut:11:2', quantity: 1 })] } }));
    blocked(input({ desiredMembership: [
      { orderId: 1, detailId: 11, quantity: Number.MAX_SAFE_INTEGER, lineKey: 'member:11:large', rework: false },
      { orderId: 1, detailId: 11, quantity: 1, lineKey: 'member:11:overflow', rework: false },
    ] }));
  });
});
