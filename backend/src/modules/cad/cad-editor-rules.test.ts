import { describe, expect, it } from 'vitest';
import { cadDigest, manufacturingChanges, sourceComparisonHash, cadRenderPart } from './cad-editor-rules';
import type { CadVariant, CadSourceSnapshot } from '../../shared/cad-workspace';

const source: CadSourceSnapshot = { id: 'source', orderId: 1, orderName: 'Тест', capturedAt: 'now', parts: [
  { orderId: 1, detailId: 2, detailNumber: 1, widthMm: 400, heightMm: 700, quantity: 5, thicknessMm: 16,
    material: 'МДФ', millingTypeId: 1, millingName: 'Неоклассика', edgeName: '', recipe: null },
] };
const variant: CadVariant = { id: 'v', workspaceId: 'w', name: 'Тест', kind: 'working', version: 2, createdAt: 'now',
  parentId: null, jobId: null, renderRevision: null, sources: [source], groups: [
    { id: 'g', sourceSnapshotId: 'source', orderId: 1, detailId: 2, quantity: 5, xMm: 0, yMm: 0, rotationDeg: 0,
      recipe: { code: 'neo', version: '1', parameters: { depth_mm: 7 } } },
  ] };
describe('CAD trusted manufacturing changes', () => {
  it('carries unchanged settings through placement and splits only from trusted same source', () => {
    const group = variant.groups[0];
    expect(manufacturingChanges(variant, [{ ...group, xMm: 200 }, { ...group, id: 'split', quantity: 1 }])).toEqual([]);
    expect(manufacturingChanges(variant, [{ ...group, id: 'forged', sourceSnapshotId: 'foreign' }])).toHaveLength(1);
    expect(manufacturingChanges(variant, [{ ...group, recipe: { ...group.recipe!, parameters: { depth_mm: 8 } } }])).toHaveLength(1);
  });
  it('manufacturing payload excludes placement and derives dimensions from source', () => {
    const first = cadRenderPart(variant, variant.groups[0]);
    expect(first).toEqual(cadRenderPart(variant, { ...variant.groups[0], xMm: 100, rotationDeg: 90 }));
    expect(first.width_mm).toBe(400);
  });
  it('source hash ignores capture timestamps/IDs, not content or ordering semantics', () => {
    expect(sourceComparisonHash([source])).toBe(sourceComparisonHash([{ ...source, id: 'fresh', capturedAt: 'later' }]));
    expect(sourceComparisonHash([source])).not.toBe(sourceComparisonHash([{ ...source, orderName: 'Изменён' }]));
    expect(cadDigest({ a: 1, b: 2 })).toBe(cadDigest({ b: 2, a: 1 }));
  });
});
