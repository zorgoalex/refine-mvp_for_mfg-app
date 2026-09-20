import { describe, expect, it } from 'vitest';
import { compareMdfShadow, legacyShadowQuantities, type ShadowComparisonInput, type ShadowSource } from './mdf-shadow-comparison';

const member = (quantity = 5, detailId = 11) => ({ orderId: 1, detailId, quantity, line: `line-${detailId}` });
const source = (overrides: Partial<ShadowSource> = {}): ShadowSource => ({ kind: 'packet', id: 'p',
  revision: 'r', createdAt: '2026-01-01', members: [member()], issues: [], rawCut: true, rework: false,
  manual: null, legacyColumn: 'completed', ...overrides });
const input = (sources: ShadowSource[] = [source()]): ShadowComparisonInput => ({ sources,
  details: [{ ...member(10), rank: 2 }], thresholds: { laminated: 3, packed: 4, issued: 5 }, allocations: [], issues: [],
  legacyCards: sources.filter(s => s.legacyColumn).map(s => ({ kind: s.kind, id: s.id, column: s.legacyColumn!, members: s.members })) });

describe('MDF source-scope shadow comparison', () => {
  it('compares independent quantities and never declares cutover/match', () => {
    const report = compareMdfShadow(input());
    expect(report).toMatchObject({ status: 'blocked', cutoverReady: false, differenceCount: 0,
      surface: 'legacy-server-return-model', semantics: 'current-state-not-event-replay' });
    expect(report.positions[0]).toMatchObject({ legacy: { cut: 5, remaining: 5 }, candidate: { cut: 5, remaining: 5 } });
  });
  it('detects legacy visually finished volume without physical proof', () => {
    const report = compareMdfShadow(input([source({ rawCut: false, legacyColumn: 'completed_laminated' })]));
    expect(report.status).toBe('differences');
    expect(report.columns[0]).toMatchObject({ legacy: 'completed_laminated', candidate: 'parsed', different: true });
    expect(report.positions[0].differences).toContain('remaining');
  });
  it('adds distinct raw CNC sources, retains rework statistics without readiness credit', () => {
    const report = compareMdfShadow(input([source(), source({ id: 'other' }), source({ id: 'redo', rework: true })]));
    expect(report.positions[0]).toMatchObject({ legacy: { cut: 10, remaining: 0 }, candidate: { cut: 15, creditedCut: 10, remaining: 0 } });
  });
  it('keeps excess A from filling missing B', () => {
    const data = input([source({ members: [member(20)] })]);
    data.details.push({ ...member(3, 12), rank: null });
    const report = compareMdfShadow(data);
    expect(report.orders[0]).toMatchObject({ legacy: { remaining: 3 }, candidate: { remaining: 3 } });
  });
  it('limits terminal status to own members, not every detail of the order', () => {
    const data = input(); data.details[0].rank = 4;
    data.details.push({ ...member(9, 12), rank: null });
    expect(compareMdfShadow(data).columns[0].candidate).toBe('completed_laminated');
    data.sources[0].members.push(member(2, 12));
    expect(compareMdfShadow(data).columns[0].candidate).toBe('completed');
  });
  it('uses issued own composition even without CNC signal', () => {
    const data = input([source({ rawCut: false })]); data.details[0].rank = 5;
    expect(compareMdfShadow(data).columns[0].candidate).toBe('completed_laminated');
    expect(compareMdfShadow(data).positions[0].candidate.cut).toBe(0);
  });
  it('does not spend one cut portion on two baths; old hidden bath participates', () => {
    const bath = source({ kind: 'bath', id: 'old-hidden', rawCut: false, legacyColumn: null, createdAt: '2001-01-01' });
    const report = compareMdfShadow(input([source(), bath, { ...bath, id: 'new', createdAt: '2026-01-01', legacyColumn: 'baths_ready' }]));
    expect(report.allocation?.readyBathIds).toEqual(['old-hidden']);
    expect(report.columns.find(c => c.id === 'new')?.candidate).toBe('baths');
    expect(report.issues).toContain('NOT_IN_LEGACY_SCOPE');
  });
  it('blocks allocation when historical consumption or accepted allocations cannot be reconciled', () => {
    const bath = source({ kind: 'bath', id: 'bath', rawCut: false, manual: 'baths_laminated', legacyColumn: null });
    const report = compareMdfShadow(input([source(), bath]));
    expect(report.allocation).toBeNull();
    expect(report.issues).toContain('ALLOCATION_BASELINE_UNKNOWN');
    const data = input(); data.allocations = [{ ...member(5), bathId: 'hidden', bathRevision: 'r', state: 'consumed' }];
    expect(compareMdfShadow(data).allocation).toBeNull();
  });
  it('preserves manual visual placement without inventing physical readiness', () => {
    const report = compareMdfShadow(input([source({ kind: 'bazisCutSet', rawCut: false, manual: 'completed' })]));
    expect(report.columns[0]).toMatchObject({ candidate: 'completed', comparable: false });
    expect(report.positions[0].candidate.cut).toBe(0);
    expect(report.issues).toContain('MANUAL_FACT_PROVENANCE_UNKNOWN');
  });
  it('unknown identity/whole-order/material cannot become an apparently matching candidate', () => {
    for (const issue of ['UNRESOLVED_MEMBERSHIP', 'WHOLE_ORDER_DECLARATION_NOT_FROZEN', 'MATERIAL_OR_SOURCE_EXCLUDED']) {
      const report = compareMdfShadow(input([source({ issues: [issue] })]));
      expect(report.columns[0]).toMatchObject({ candidate: null, comparable: false });
      expect(report.issues).toContain(issue);
    }
  });
  it('legacy independently sums CNC+BASIS and subtracts lamination only at its own position', () => {
    const demand = [member(5), member(3, 12)];
    const cards = [
      { kind: 'packet' as const, id: 'p', column: 'completed', members: [member(2)] },
      { kind: 'bazisCutSet' as const, id: 'b', column: 'completed', members: [member(3)] },
      { kind: 'bath' as const, id: 'v', column: 'baths_laminated', members: [member(3, 12)] },
    ];
    expect(legacyShadowQuantities(demand, [...cards, cards[0]], new Set())).toMatchObject([
      { cut: 5, rolled: 0, remaining: 0 }, { cut: 0, rolled: 3, remaining: 0 },
    ]);
  });
});
