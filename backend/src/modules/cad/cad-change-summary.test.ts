import { expect, it } from 'vitest';
import { cadChangeSummary, cadSourceAuditSummary } from './cad-change-summary';
import type { CadGroup } from '../../shared/cad-workspace';
it('keeps5000-record audit bounded and points to exact immutable revisions', () => {
  const before: CadGroup[] = Array.from({ length: 5000 }, (_, i) => ({ id: String(i), sourceSnapshotId: 's', orderId: 1, detailId: 1,
    quantity: 1, xMm: i, yMm: 0, rotationDeg: 0, recipe: { code: 'neo', version: '1', parameters: { data: 'x'.repeat(1000) } } }));
  const after = before.map(g => ({ ...g, xMm: g.xMm + 1 }));
  const result = cadChangeSummary(4, before, after);
  expect(result).toMatchObject({ beforeRevision: 4, revision: 5, beforeCount: 5000, afterCount: 5000,
    modified: { count: 5000, truncated: true }, added: { count: 0 }, removed: { count: 0 } });
  expect(result.modified.ids).toHaveLength(50);
  expect(JSON.stringify(result).length).toBeLessThan(10000);
  expect(cadChangeSummary(4, before, [{ ...before[0], xMm: 5 }, ...before.slice(1)])).toMatchObject({ modified: { count: 1, ids: ['0'], truncated: false } });
});
it('bounds source audit across500 orders with500 changed positions each', () => {
  const result = cadSourceAuditSummary(Array.from({ length: 500 }, (_, orderId) => ({ orderId, orderName: 'Тест'.repeat(100), stale: true,
    changedDetailIds: Array.from({ length: 500 }, (_, i) => i) })));
  expect(result).toMatchObject({ sourceCount: 500, changedSourceCount: 500, changedDetailCount: 250000, ordersTruncated: true, detailsTruncated: true });
  expect(result.changedDetails).toHaveLength(50); expect(result.changedOrderIds).toHaveLength(50);
  expect(JSON.stringify(result).length).toBeLessThan(5000);
});
