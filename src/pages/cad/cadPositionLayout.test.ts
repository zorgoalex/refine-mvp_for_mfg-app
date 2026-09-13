import { describe, expect, it } from 'vitest';
import { createGroups, type CadSourceSnapshot } from '@shared/cad-workspace';
import { expandInstances } from './cadInstances';
import { placedBounds } from './cadCanvasGeometry';
import { isInitialPositionLayout, layoutPositionBlocks } from './cadPositionLayout';

function fixture(count = 12, quantity = 4) {
  const source: CadSourceSnapshot = { id: 's', orderId: 1, orderName: 'Тест', capturedAt: '', parts: Array.from({ length: count }, (_, i) => ({
    orderId: 1, detailId: i + 1, detailNumber: i + 1, widthMm: 400, heightMm: 700, quantity, thicknessMm: 16,
    material: 'МДФ', millingTypeId: 1, millingName: 'Тест', edgeName: '', recipe: { code: 'neo', version: '1', parameters: {} },
  })) };
  let n = 0; const groups = createGroups([source], () => `g${++n}`);
  return { source, groups, copies: expandInstances(groups, [source], (id, index) => `${id}-${index}`) };
}
describe('position-block display layout', () => {
  it('only detects exact untouched version1 layouts, including quantity1 orders', () => {
    const { source, groups, copies } = fixture();
    expect(isInitialPositionLayout(groups, [source], 1)).toBe(true);
    expect(isInitialPositionLayout(groups, [source], 2)).toBe(false);
    expect(isInitialPositionLayout(copies, [source], 1)).toBe(false);
    for (const patch of [{ xMm: 1 }, { yMm: -5 }, { rotationDeg: 90 }, { quantity: 1 }, { placementGroupId: 'manual' }]) {
      expect(isInitialPositionLayout([{ ...groups[0], ...patch }, ...groups.slice(1)], [source], 1)).toBe(false);
    }
    const single = fixture(5, 1);
    expect(isInitialPositionLayout(single.groups, [single.source], 1)).toBe(true);
  });
  it('doubles horizontal block gaps to300mm, retains150mm vertical and50mm internal gaps', () => {
    const { source, copies } = fixture();
    const layout = layoutPositionBlocks(copies, [source], 1.6);
    const blocks = source.parts.map(p => {
      const boxes = layout.filter(g => g.detailId === p.detailId).map(g => placedBounds(g, p));
      return { minX: Math.min(...boxes.map(b => b.minX)), maxX: Math.max(...boxes.map(b => b.maxX)),
        minY: Math.min(...boxes.map(b => b.minY)), maxY: Math.max(...boxes.map(b => b.maxY)) };
    });
    expect(layout[0].xMm - layout[1].xMm - source.parts[0].widthMm).toBe(50);
    let rows = 1, horizontalGaps = 0;
    for (let i = 1; i < blocks.length; i++) {
      const prev = blocks[i - 1], next = blocks[i];
      if (next.maxY === prev.maxY) { horizontalGaps++; expect(prev.minX - next.maxX).toBeCloseTo(300); }
      else { rows++; expect(prev.minY - next.maxY).toBeCloseTo(150); expect(next.maxX).toBe(blocks[0].maxX); }
    }
    expect(rows).toBeGreaterThan(1);
    expect(horizontalGaps).toBeGreaterThan(0);
    for (let a = 0; a < blocks.length; a++) for (let b = a + 1; b < blocks.length; b++) {
      const x = blocks[a], y = blocks[b];
      expect(x.maxX <= y.minX || y.maxX <= x.minX || x.maxY <= y.minY || y.maxY <= x.minY).toBe(true);
    }
  });
  it('adapts to landscape/portrait while preserving IDs, recipes, rotations and input', () => {
    const { source, copies } = fixture();
    copies[1].rotationDeg = 35; copies[1].recipe!.parameters.depth_mm = 7;
    const before = structuredClone(copies);
    const extent = (aspect: number) => {
      const layout = layoutPositionBlocks(copies, [source], aspect);
      const boxes = layout.map(g => placedBounds(g, source.parts[g.detailId - 1]));
      for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
        const x = boxes[a], y = boxes[b];
        expect(x.maxX <= y.minX + 1e-8 || y.maxX <= x.minX + 1e-8 || x.maxY <= y.minY + 1e-8 || y.maxY <= x.minY + 1e-8).toBe(true);
      }
      expect(layout.map(({ xMm, yMm, ...g }) => g)).toEqual(copies.map(({ xMm, yMm, ...g }) => g));
      expect(layout.some(g => g.placementGroupId)).toBe(false);
      return Math.max(...boxes.map(b => b.maxX)) / Math.max(...boxes.map(b => b.maxY));
    };
    expect(extent(2.5)).toBeGreaterThan(extent(.6));
    expect(copies).toEqual(before);
    expect(layoutPositionBlocks(copies, [source], 2)).toEqual(layoutPositionBlocks(copies, [source], 2));
  });
  it('keeps source identity across imported orders and interleaved instances', () => {
    const { source, copies } = fixture(1, 2);
    const other = { ...source, id: 's2', orderId: 2, parts: source.parts.map(p => ({ ...p, orderId: 2 })) };
    const imported = copies.map(g => ({ ...g, id: `other-${g.id}`, sourceSnapshotId: 's2', orderId: 2 }));
    const arranged = layoutPositionBlocks([copies[0], imported[0], copies[1], imported[1]], [source, other], 5);
    expect(arranged[0].xMm).toBeGreaterThan(arranged[1].xMm);
    expect(arranged[2].xMm).toBeGreaterThan(arranged[1].xMm);
  });
  it('supports5000 instances without losing any and rejects missing geometry', () => {
    const { source, copies } = fixture(500, 10);
    const arranged = layoutPositionBlocks(copies, [source], 2);
    expect(arranged).toHaveLength(5000); expect(new Set(arranged.map(g => g.id)).size).toBe(5000);
    expect(arranged.every(g => Number.isFinite(g.xMm) && Number.isFinite(g.yMm))).toBe(true);
    expect(() => layoutPositionBlocks(copies, [], 2)).toThrow('источник');
    expect(() => layoutPositionBlocks([...copies, copies[0]], [source], 2)).toThrow();
  });
});
