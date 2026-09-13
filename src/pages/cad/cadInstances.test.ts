import { describe, expect, it } from 'vitest';
import { createGroups, type CadSourceSnapshot } from '@shared/cad-workspace';
import { expandInstances, differsFromPosition } from './cadInstances';
import { placedBounds } from './cadCanvasGeometry';

const source: CadSourceSnapshot = { id: 's', orderId: 1, orderName: 'Тест', capturedAt: '', parts: [
  { orderId: 1, detailId: 1, detailNumber: 1, widthMm: 400, heightMm: 700, quantity: 4,
    thicknessMm: 16, material: 'МДФ', millingTypeId: 1, millingName: 'Тест', edgeName: '',
    recipe: { code: 'neo', version: '1', parameters: {} } },
] };
const ids = (group: string, index: number) => `${group}-${index}`;
describe('independent CAD instances', () => {
  it('expands all quantities, preserves source and first placement, gives independent recipes', () => {
    const groups = createGroups([source], () => 'g'); const before = structuredClone(groups);
    const copies = expandInstances(groups, [source], ids);
    expect(copies).toHaveLength(4); expect(copies.every(g => g.quantity === 1)).toBe(true);
    expect(new Set(copies.map(g => g.id)).size).toBe(4);
    expect(copies[0]).toMatchObject({ id: 'g', xMm: 0, yMm: 0 });
    copies[1].xMm += 7; copies[1].recipe!.parameters.border_mm = 25;
    expect(copies[0].recipe!.parameters).toEqual({}); expect(groups).toEqual(before);
    expect(copies.reduce((n, g) => n + g.quantity, 0)).toBe(4);
    expect(expandInstances(copies, [source], ids)).toEqual(copies);
  });
  it('packs extra rotated copies outside all existing negative/custom placements', () => {
    const g = { ...createGroups([source], () => 'g')[0], xMm: -900, yMm: -300, rotationDeg: 35 };
    const copies = expandInstances([g], [source], ids);
    expect(copies[0]).toMatchObject({ xMm: -900, yMm: -300, rotationDeg: 35 });
    const boxes = copies.map(copy => placedBounds(copy, source.parts[0]));
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
      const x = boxes[a], y = boxes[b];
      expect(x.maxX <= y.minX || y.maxX <= x.minX || x.maxY <= y.minY || y.maxY <= x.minY).toBe(true);
    }
  });
  it('has no 200-copy truncation, accepts5000 and rejects5001 before allocating IDs', () => {
    const g = createGroups([source], () => 'g')[0];
    expect(expandInstances([{ ...g, quantity: 5000 }], [source], ids)).toHaveLength(5000);
    let calls = 0;
    expect(() => expandInstances([{ ...g, quantity: 5001 }], [source], () => { calls++; return 'x'; })).toThrow('5000');
    expect(calls).toBe(0);
  });
  it('supports500 positions×4 and does not inherit movement grouping when expanding', () => {
    const s = { ...source, parts: Array.from({ length: 500 }, (_, i) => ({ ...source.parts[0], detailId: i + 1 })) };
    let n = 0; const groups = createGroups([s], () => `g${++n}`).map(g => ({ ...g, placementGroupId: 'old-group' }));
    const copies = expandInstances(groups, [s], ids);
    expect(copies).toHaveLength(2000); expect(copies.every(g => !g.placementGroupId)).toBe(true);
  });
  it('compares resolved defaults and notices recipe/version/parameter changes', () => {
    const recipe = source.parts[0].recipe!;
    expect(differsFromPosition({ ...recipe, parameters: { border_mm: 20 } }, recipe, { border_mm: 20 })).toBe(false);
    expect(differsFromPosition({ ...recipe, parameters: { border_mm: 25 } }, recipe, { border_mm: 20 })).toBe(true);
    expect(differsFromPosition({ ...recipe, version: '2' }, recipe, {})).toBe(true);
    expect(differsFromPosition(null, recipe, {})).toBe(true);
    expect(differsFromPosition(recipe, recipe, {})).toBe(false);
  });
});
