import { describe, expect, it } from 'vitest';
import { buildMdfBaselineItems, expectMdfBaseline, mdfBaselineItemDigest, type MdfBaselineOrder } from './mdf-baseline';
import { classifyMdfReconciliationSource, type MdfReconciliationItem, type MdfReconciliationSourceInput } from './mdf-reconciliation';

const item = (line: string, orderId: number, detailId: number, quantity = 2): MdfReconciliationItem =>
  ({ line, orderId, detailId, quantity, resolved: true, ownerState: 'live' });
const src = (patch: Partial<MdfReconciliationSourceInput>) => classifyMdfReconciliationSource({ kind: 'packet', id: 'p1',
  exists: true, mdf: true, createdAt: '2026-09-01T00:00:00Z', displayName: 'Файл 1', items: [item('a', 1, 10)],
  completed: false, returned: false, rework: false, manualColumn: null, manualAudited: false, legacyColumn: null, ...patch });
const order = (id: number, readyOrLater: boolean): [number, MdfBaselineOrder] =>
  [id, { id, name: `N${id}`, readyOrLater, deleted: false, kind: 'production_order', createdAt: '2026-08-01T00:00:00Z' }];
const demand = [{ orderId: 1, detailId: 10, quantity: 2, rank: 1 }, { orderId: 2, detailId: 20, quantity: 3, rank: 9 }];

describe('buildMdfBaselineItems', () => {
  it('closes finished orders in full by status (cut + laminated declarations at demand quantity)', () => {
    const build = buildMdfBaselineItems({ sources: [], demand, orders: new Map([order(1, false), order(2, true)]) });
    const closure = build.items.find(i => i.itemKey === 'order:2')!;
    expect(closure).toMatchObject({ itemKind: 'order_closure', sourceKind: 'order', sourceId: '2', orderIds: [2] });
    expect(closure.lines).toEqual([
      expect.objectContaining({ lineKey: 'closed-by-status:20:cut', quantity: 3, stageCode: 'cut', evidenceKind: 'declaration' }),
      expect.objectContaining({ lineKey: 'closed-by-status:20:laminated', quantity: 3, stageCode: 'laminated' })]);
    expect(build.closedOrderIds).toEqual([2]);
    expect(build.manualReviewOrderIds).toEqual([1]);
  });

  it('audited legacy manual move counts as a declaration only for CURRENT owners', () => {
    const s = src({ items: [item('a', 1, 10), item('b', 2, 20, 3)], manualColumn: 'completed', manualAudited: true });
    const build = buildMdfBaselineItems({ sources: [s], demand, orders: new Map([order(1, false), order(2, true)]) });
    const source = build.items.find(i => i.itemKey === 'packet:p1')!;
    expect(source.lines.filter(l => l.evidenceKind === 'declaration')).toEqual([
      expect.objectContaining({ lineKey: 'legacy-audited:1:10', orderId: 1, quantity: 2, stageCode: 'cut' })]);
    expect(source.provenance).toEqual({ legacy_audited: 2 });
    expect(source.context).toMatchObject({ manualPlacementColumn: 'completed', compositionComplete: true, displayName: 'Файл 1' });
    expect(build.manualReviewOrderIds).toEqual([]);
  });

  it('bare (unaudited) manual column and rework get no declaration', () => {
    const bare = src({ manualColumn: 'completed', manualAudited: false });
    const rework = src({ id: 'p2', rework: true, manualColumn: 'completed', manualAudited: true });
    const build = buildMdfBaselineItems({ sources: [bare, rework], demand, orders: new Map([order(1, false)]) });
    expect(build.items.flatMap(i => i.lines).filter(l => l.evidenceKind === 'declaration')).toEqual([]);
  });

  it('bath: audited lamination column ⇒ laminated declaration; physical CNC cut stays physical', () => {
    const bath = src({ kind: 'bath', id: 'cut-result:5', items: [item('1:10', 1, 10)], manualColumn: 'baths_laminated',
      manualAudited: true });
    const packet = src({ completed: true });
    const build = buildMdfBaselineItems({ sources: [bath, packet], demand, orders: new Map([order(1, false)]) });
    expect(build.items.find(i => i.itemKey === 'bath:cut-result:5')!.lines.find(l => l.evidenceKind === 'declaration'))
      .toMatchObject({ stageCode: 'laminated', quantity: 2 });
    expect(build.items.find(i => i.itemKey === 'packet:p1')!.provenance).toEqual({ physical_cnc: 2 });
  });

  it('blocked/excluded sources produce no item; digests are deterministic and content-bound', () => {
    const blocked = src({ id: 'x', exists: false });
    const a = buildMdfBaselineItems({ sources: [blocked, src({})], demand, orders: new Map([order(1, false)]) });
    const b = buildMdfBaselineItems({ sources: [src({}), blocked], demand, orders: new Map([order(1, false)]) });
    expect(a.items.map(i => i.itemKey)).toEqual(['packet:p1']);
    expect(a.itemsDigest).toBe(b.itemsDigest);
    const { digest, ...rest } = a.items[0];
    expect(mdfBaselineItemDigest(rest)).toBe(digest);
    expect(mdfBaselineItemDigest({ ...rest, lines: rest.lines.map(l => ({ ...l, quantity: l.quantity + 1 })) })).not.toBe(digest);
  });
});

describe('expectMdfBaseline', () => {
  it('closed order fully credited; current order credited by declaration coverage', () => {
    const s = src({ items: [item('a', 1, 10)], manualColumn: 'completed', manualAudited: true });
    const build = buildMdfBaselineItems({ sources: [s], demand, orders: new Map([order(1, false), order(2, true)]) });
    const positions = expectMdfBaseline(build, demand);
    expect(positions.find(p => p.orderId === 2)).toMatchObject({ creditedCut: 0, creditedRolled: 3, remaining: 0 });
    expect(positions.find(p => p.orderId === 1)).toMatchObject({ creditedCut: 2 });
  });
});
