import { describe, expect, it } from 'vitest';
import type { MdfReconciliationInventory } from '../adapters/mdf-reconciliation-inventory';
import { buildMdfReconciliationReport, renderMdfReconciliationMarkdown } from './mdf-reconciliation-report';

const live = (line: string, orderId: number, detailId: number, quantity: number) =>
  ({ line, orderId, detailId, quantity, resolved: true, ownerState: 'live' as const });
function inventory(): MdfReconciliationInventory {
  return {
    inputs: [
      { kind: 'packet', id: 'p1', exists: true, mdf: true, createdAt: '2026-09-01', items: [live('a', 1, 10, 3)],
        completed: true, returned: false, rework: false, manualColumn: null, manualAudited: false, legacyColumn: 'completed' },
      { kind: 'packet', id: 'p2', exists: true, mdf: true, createdAt: '2026-09-01', items: [live('a', 2, 20, 4)],
        completed: false, manualColumn: 'completed', manualAudited: true, legacyColumn: 'completed' },
      { kind: 'bath', id: 'cut-result:1', exists: true, mdf: true, createdAt: '2026-09-02', items: [live('1:10', 1, 10, 2)],
        manualColumn: null, manualAudited: false, legacyColumn: 'baths_ready' },
      { kind: 'bath', id: 'cut-result:9', exists: false, mdf: false, createdAt: null, items: [], manualColumn: 'baths',
        manualAudited: true },
      { kind: 'packet', id: 'p3', exists: true, mdf: false, createdAt: '2026-09-01', items: [], manualColumn: null,
        manualAudited: false },
    ],
    references: { total: 6, byOrigin: { table: 4, manual_move: 2 }, nonSource: [] },
    demand: [{ orderId: 1, detailId: 10, quantity: 3, rank: 1 }, { orderId: 2, detailId: 20, quantity: 4, rank: 9 }],
    orders: new Map([[1, { id: 1, name: 'A', status: 'В работе', deleted: false, kind: 'production_order', readyOrLater: false, createdAt: null }],
      [2, { id: 2, name: 'B', status: 'Выдан', deleted: false, kind: 'production_order', readyOrLater: true, createdAt: null }]]),
    thresholds: { packed: 5, issued: 8, laminated: 4 },
  };
}

describe('buildMdfReconciliationReport', () => {
  const report = buildMdfReconciliationReport(inventory(), [], { commit: 'x' });

  it('classifies every entry once and passes the invariants', () => {
    expect(report.invariants.every(i => i.ok)).toBe(true);
    expect(report.totals.byKind).toEqual({ packet: { credited: 2, blocked: 0, excluded: 1 },
      bazisCutSet: { credited: 0, blocked: 0, excluded: 0 }, bath: { credited: 1, blocked: 1, excluded: 0 } });
  });

  it('reserves physical supply for the bath and credits the cut', () => {
    const b = report.sources.find(s => s.id === 'cut-result:1')!;
    expect([b.reservedQuantity, b.engineColumn]).toEqual([2, 'baths_ready']);
    expect(report.totals.quantities).toMatchObject({ physicalCut: 3, reserved: 2, unverified: 4, auditedUnbound: 4, consumed: 0 });
  });

  it('lists issued orders with remaining quantity separately, with the unverified manual quantity', () => {
    expect(report.orders).toEqual([
      expect.objectContaining({ id: 1, remaining: 0, readyOrIssuedWithoutProof: false }),
      expect.objectContaining({ id: 2, remaining: 4, unverifiedQuantity: 4, readyOrIssuedWithoutProof: true }),
    ]);
    expect(renderMdfReconciliationMarkdown(report)).toContain('| B | Выдан | 4 | 0 | 0 | 4 | 4 |');
  });

  it('fails the parity invariant when the shadow loader disagrees', () => {
    const failed = buildMdfReconciliationReport(inventory(), ['packet:p1'], {});
    expect(failed.invariants.find(i => i.name === 'shadow_loader_parity')).toEqual({ name: 'shadow_loader_parity', ok: false,
      detail: ['packet:p1'] });
  });
});
