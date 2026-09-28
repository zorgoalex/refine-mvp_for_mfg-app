import { describe, expect, it } from 'vitest';
import { buildMdfReconciliationComponents, classifyMdfReconciliationSource, evaluateMdfReconciliationComponent,
  type MdfReconciliationItem, type MdfReconciliationSourceInput } from './mdf-reconciliation';

const item = (line: string, orderId: number | null, detailId: number | null, quantity = 2,
  ownerState: MdfReconciliationItem['ownerState'] = 'live'): MdfReconciliationItem =>
  ({ line, orderId, detailId, quantity, resolved: ownerState === 'live' && orderId !== null && detailId !== null, ownerState });
const packet = (patch: Partial<MdfReconciliationSourceInput> = {}): MdfReconciliationSourceInput => ({
  kind: 'packet', id: 'p1', exists: true, mdf: true, createdAt: '2026-09-01T00:00:00Z', items: [item('a', 1, 10)],
  completed: false, returned: false, rework: false, manualColumn: null, manualAudited: false, ...patch });
const T = { packed: 5, issued: 8, laminated: 4 };
const bath = (id: string, createdAt: string, items: MdfReconciliationItem[], patch: Partial<MdfReconciliationSourceInput> = {}) =>
  classifyMdfReconciliationSource({ kind: 'bath', id, exists: true, mdf: true, createdAt, items, manualColumn: null,
    manualAudited: false, ...patch });

describe('classifyMdfReconciliationSource', () => {
  it('credits physical cut from CNC completion and ignores a bare manual column for it', () => {
    const s = classifyMdfReconciliationSource(packet({ completed: true, manualColumn: 'completed' }));
    expect(s.disposition).toBe('credited');
    expect(s.lines.filter(l => l.stage === 'cut')).toEqual([expect.objectContaining({ evidence: 'physical', quantity: 2 })]);
    expect(s.warnings).toEqual([]);
    expect(s.unverifiedQuantity).toBe(0);
  });

  it('keeps membership and a completed packet supply while a bare manual placement gets zero credit', () => {
    const s = classifyMdfReconciliationSource(packet({ completed: true, returned: true, manualColumn: 'completed', manualAudited: true }));
    expect(s.disposition).toBe('credited');
    expect(s.lines.map(l => l.stage)).toEqual(['membership']);
    expect(s.warnings).toEqual(['HISTORY_AUDITED_UNBOUND', 'HISTORY_RETURNED', 'HISTORY_UNVERIFIED']);
    expect(s.unverifiedQuantity).toBe(2);
  });

  it('rework packet: membership without supply', () => {
    const s = classifyMdfReconciliationSource(packet({ completed: true, rework: true }));
    expect(s.warnings).toEqual(['HISTORY_REWORK']);
    expect(s.lines.every(l => l.stage === 'membership' && l.rework)).toBe(true);
  });

  it('partial items: matched credited, unmatched listed', () => {
    const s = classifyMdfReconciliationSource(packet({ completed: true, items: [item('a', 1, 10), item('b', 1, null, 3, 'missing')] }));
    expect(s.disposition).toBe('credited');
    expect(s.warnings).toEqual(['HISTORY_PARTIAL_ITEMS']);
    expect(s.unresolvedItems).toEqual([expect.objectContaining({ line: 'b', reason: 'HISTORY_UNMATCHED_ITEMS' })]);
    expect(s.lines.filter(l => l.stage === 'cut').map(l => l.detailId)).toEqual([10]);
  });

  it.each([
    [{ exists: false }, 'blocked', 'HISTORY_SOURCE_MISSING'],
    [{ mdf: false }, 'excluded', 'HISTORY_NOT_MDF'],
    [{ kind: 'bath', inactive: true }, 'excluded', 'HISTORY_BATH_NOT_CURRENT'],
    [{ items: [] }, 'blocked', 'HISTORY_INCOMPLETE_COMPOSITION'],
    [{ items: [item('a', 1, 10, 2, 'deleted')] }, 'blocked', 'HISTORY_OWNER_DELETED'],
    [{ items: [item('a', 1, 10, 2, 'not_production')] }, 'blocked', 'HISTORY_OWNER_NOT_PRODUCTION'],
    [{ items: [item('a', null, null, 2, 'missing')] }, 'blocked', 'HISTORY_NO_OWNER'],
    [{ items: [item('a', 1, null, 2, 'missing'), item('b', 1, 11, 2, 'deleted')] }, 'blocked', 'HISTORY_UNMATCHED_ITEMS'],
  ] as const)('source-level failure %j', (patch, disposition, reason) => {
    const s = classifyMdfReconciliationSource(packet({ ...(patch as Partial<MdfReconciliationSourceInput>), completed: true }));
    expect([s.disposition, s.reason, s.lines]).toEqual([disposition, reason, []]);
  });

  it('an inactive bath with a legacy lamination manual column is blocked (production history), not excluded; owners are the live resolved ones only', () => {
    const items = [item('1:10', 1, 10), item('1:11', 1, 11, 2, 'deleted'), item('2:20', 2, 20)];
    const s = bath('cut-result:9', '2026-09-01T00:00:00Z', items, { inactive: true, manualColumn: 'completed_baths' });
    expect(s.disposition).toBe('blocked');
    expect(s.reason).toBe('HISTORY_BATH_NOT_CURRENT_WITH_PRODUCTION');
    expect(s.owners).toEqual([1, 2]);
    expect(s.lines).toEqual([]);
  });

  it('an inactive bath with a strict lamination proof (no manual column) is blocked (production history); owners are the live resolved ones only', () => {
    const items = [item('1:10', 1, 10), item('2:20', 2, 20, 2, 'not_production')];
    const s = bath('cut-result:10', '2026-09-01T00:00:00Z', items, { inactive: true, provenLaminated: true, manualColumn: null });
    expect(s.disposition).toBe('blocked');
    expect(s.reason).toBe('HISTORY_BATH_NOT_CURRENT_WITH_PRODUCTION');
    expect(s.owners).toEqual([1]);
    expect(s.lines).toEqual([]);
  });

  it('an inactive bath with neither a lamination manual column nor a proof stays excluded (not a production-history exception)', () => {
    const s = bath('cut-result:11', '2026-09-01T00:00:00Z', [item('1:10', 1, 10)], { inactive: true, manualColumn: 'baths_ready' });
    expect(s.disposition).toBe('excluded');
    expect(s.reason).toBe('HISTORY_BATH_NOT_CURRENT');
    expect(s.owners).toEqual([]);
  });

  it('BASIS cut only from an audited composition-bound proof, as declaration', () => {
    const base = { kind: 'bazisCutSet' as const, id: '5', manualColumn: 'completed', manualAudited: true };
    const proven = classifyMdfReconciliationSource(packet({ ...base, provenCut: true }));
    expect(proven.lines.filter(l => l.stage === 'cut')).toEqual([expect.objectContaining({ evidence: 'declaration' })]);
    expect(proven.warnings).toEqual([]);
    const bare = classifyMdfReconciliationSource(packet(base));
    expect(bare.lines.filter(l => l.stage === 'cut')).toEqual([]);
    expect(bare.warnings).toEqual(['HISTORY_AUDITED_UNBOUND', 'HISTORY_UNVERIFIED']);
    // A BASIS set never has a CNC completion signal.
    expect(classifyMdfReconciliationSource(packet({ ...base, completed: true })).lines.some(l => l.evidence === 'physical')).toBe(false);
  });

  it('bath lamination: declaration only from a proof; a bare laminated column is placement only', () => {
    const proven = bath('cut-result:1', '2026-09-01T00:00:00Z', [item('a', 1, 10)], { manualColumn: 'baths_laminated', provenLaminated: true });
    expect(proven.lines.filter(l => l.stage === 'laminated')).toEqual([expect.objectContaining({ evidence: 'declaration' })]);
    const bare = bath('cut-result:1', '2026-09-01T00:00:00Z', [item('a', 1, 10)], { manualColumn: 'completed_baths' });
    expect(bare.lines.map(l => l.stage)).toEqual(['membership']);
    expect(bare.warnings).toEqual(['HISTORY_UNVERIFIED']);
  });
});

describe('components and evaluation', () => {
  it('reports projected frozen demand above the context limit while source/evidence counts pass', () => {
    const sources = Array.from({ length: 12 }, (_, i) => classifyMdfReconciliationSource(packet({ id: `p${i}`,
      items: [item('a', 7, 70 + i)] })));
    const [component] = buildMdfReconciliationComponents(sources, new Map([[7, 4500]]));
    expect(component.counts).toMatchObject({ owners: 1, sources: 12, liveDemand: 4500, frozenDemand: 54000 });
    expect(component.exceeded).toEqual(['frozenDemand:54000>50000']);
  });

  it('separates components that share no order', () => {
    const a = classifyMdfReconciliationSource(packet({ id: 'a', items: [item('x', 1, 10)] }));
    const b = classifyMdfReconciliationSource(packet({ id: 'b', items: [item('x', 2, 20)] }));
    const c = classifyMdfReconciliationSource(packet({ id: 'c', items: [item('x', 1, 11), item('y', 3, 30)] }));
    const components = buildMdfReconciliationComponents([a, b, c], new Map());
    expect(components.map(x => x.orderIds)).toEqual([[1, 3], [2]]);
  });

  it('competing baths on one supply: FIFO by bath creation, never above supply or membership', () => {
    const supply = classifyMdfReconciliationSource(packet({ completed: true, items: [item('a', 1, 10, 3)] }));
    const older = bath('cut-result:1', '2026-09-01T00:00:00Z', [item('1:10', 1, 10, 2)]);
    const newer = bath('cut-result:2', '2026-09-02T00:00:00Z', [item('1:10', 1, 10, 2)]);
    const result = evaluateMdfReconciliationComponent([supply, newer, older], [{ orderId: 1, detailId: 10, quantity: 4, rank: 1 }], T);
    expect(result.invariantViolations).toEqual([]);
    expect(result.readyBathIds).toEqual(['cut-result:1']);
    expect(result.reservations.reduce((n, r) => n + r.quantity, 0)).toBeLessThanOrEqual(3);
    expect(result.reservations.filter(r => r.bathId === 'cut-result:1').reduce((n, r) => n + r.quantity, 0)).toBe(2);
    expect(result.positions).toEqual([expect.objectContaining({ orderId: 1, detailId: 10, creditedCut: 3 })]);
  });

  it('declared cut is coverage only, never allocatable supply', () => {
    const declared = classifyMdfReconciliationSource(packet({ kind: 'bazisCutSet', id: '9', provenCut: true, items: [item('a', 1, 10, 2)] }));
    const b = bath('cut-result:1', '2026-09-01T00:00:00Z', [item('1:10', 1, 10, 2)]);
    const result = evaluateMdfReconciliationComponent([declared, b], [{ orderId: 1, detailId: 10, quantity: 2, rank: 1 }], T);
    expect(result.reservations).toEqual([]);
    expect(result.readyBathIds).toEqual([]);
    expect(result.positions[0].creditedCut).toBe(2);
  });

  it('split items of one proven source are declared as one whole position (no max-undercount)', () => {
    const declared = classifyMdfReconciliationSource(packet({ kind: 'bazisCutSet', id: '9', provenCut: true,
      items: [item('a', 1, 10, 2), item('b', 1, 10, 3)] }));
    expect(declared.lines.filter(l => l.stage === 'cut')).toEqual([expect.objectContaining({ quantity: 5, evidence: 'declaration' })]);
    const result = evaluateMdfReconciliationComponent([declared], [{ orderId: 1, detailId: 10, quantity: 5, rank: 1 }], T);
    expect(result.positions[0]).toMatchObject({ creditedCut: 5, remaining: 0 });
  });

  it('proved lamination survives a cleared manual placement (projection placement contract)', () => {
    const b = bath('cut-result:1', '2026-09-01T00:00:00Z', [item('1:10', 1, 10, 2)], { manualColumn: null, provenLaminated: true });
    const result = evaluateMdfReconciliationComponent([b], [{ orderId: 1, detailId: 10, quantity: 2, rank: 1 }], T);
    expect(result.cards).toEqual([expect.objectContaining({ id: 'cut-result:1', column: 'baths_laminated', verified: true })]);
  });

  it('a credited line outside live MDF demand is not verified by the projection', () => {
    const s = classifyMdfReconciliationSource(packet({ completed: true, items: [item('a', 1, 10)] }));
    const result = evaluateMdfReconciliationComponent([s], [{ orderId: 1, detailId: 11, quantity: 2, rank: 1 }], T);
    expect(result.cards[0]).toMatchObject({ verified: false, issues: expect.arrayContaining(['MEMBER_OUTSIDE_LIVE_MDF_DEMAND']) });
    expect(result.positions[0].creditedCut).toBe(0);
  });
});

describe('outside live MDF demand', () => {
  it('items outside demand keep an explicit reason; all outside ⇒ blocked', () => {
    const partial = classifyMdfReconciliationSource(packet({ items: [item('a', 1, 10), item('b', 1, 11, 2, 'outside_demand')] }));
    expect(partial.warnings).toEqual(['HISTORY_PARTIAL_ITEMS']);
    expect(partial.unresolvedItems).toEqual([expect.objectContaining({ line: 'b', reason: 'HISTORY_OUTSIDE_MDF_DEMAND' })]);
    const all = classifyMdfReconciliationSource(packet({ items: [item('a', 1, 10, 2, 'outside_demand')] }));
    expect([all.disposition, all.reason]).toEqual(['blocked', 'HISTORY_OUTSIDE_MDF_DEMAND']);
  });

  it('a source over the proof loader limit is credited without proofs and flagged', () => {
    const s = classifyMdfReconciliationSource(packet({ kind: 'bazisCutSet', id: '3', proofLimit: true, manualColumn: 'completed' }));
    expect(s.warnings).toEqual(['HISTORY_PROOF_LIMIT', 'HISTORY_UNVERIFIED']);
  });
});
