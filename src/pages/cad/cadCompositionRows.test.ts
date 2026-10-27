import { describe, expect, it } from 'vitest';
import type { CadGroup, CadSourceSnapshot } from '@shared/cad-workspace';
import { buildCompositionRows, type CadTreeInput } from './cadCompositionRows';

const source: CadSourceSnapshot = { id: 's', orderId: 1, orderName: 'Тест', capturedAt: '', parts: [1, 2].map(n => ({
  orderId: 1, detailId: n, detailNumber: n, widthMm: 400, heightMm: 700, quantity: 2, thicknessMm: 16, material: null, millingTypeId: 1, millingName: '', edgeName: '', recipe: null })) };
const group = (id: string, detailId: number, recipe = true): CadGroup => ({ id, sourceSnapshotId: 's', orderId: 1, detailId, quantity: 1,
  recipe: recipe ? { code: 'neo', version: '1', parameters: {} } : null, xMm: 0, yMm: 0, rotationDeg: 0 });
const groups = [group('a', 1), group('b', 2, false), group('c', 1), group('d', 2)];
const input = (patch: Partial<CadTreeInput> = {}): CadTreeInput => ({ groups, sources: [source], search: '', filter: 'all', collapsed: new Set(),
  issueIds: new Set(), changedIds: new Set(), recipeName: g => g.recipe ? 'Неоклассика' : 'Нет фрезеровки', ...patch });
const shape = (rows: ReturnType<typeof buildCompositionRows>) => rows.map(r => r.kind === 'position' ? `P${r.part?.detailNumber}:${r.ids.join('')}/${r.total}` : r.key);

describe('CAD composition tree rows', () => {
  it('groups instances under positions in first-appearance order', () => {
    expect(shape(buildCompositionRows(input()))).toEqual(['P1:ac/2', 'a', 'c', 'P2:bd/2', 'b', 'd']);
  });
  it('collapsed positions keep the header and all their ids for selection', () => {
    expect(shape(buildCompositionRows(input({ collapsed: new Set(['s:1']) })))).toEqual(['P1:ac/2', 'P2:bd/2', 'b', 'd']);
  });
  it('filters hide positions without matches and report partial counts', () => {
    expect(shape(buildCompositionRows(input({ filter: 'unassigned' })))).toEqual(['P2:b/2', 'b']);
    expect(shape(buildCompositionRows(input({ filter: 'issues', issueIds: new Set(['c']) })))).toEqual(['P1:c/2', 'c']);
    expect(shape(buildCompositionRows(input({ filter: 'changed', changedIds: new Set(['d', 'a']) })))).toEqual(['P1:a/2', 'a', 'P2:d/2', 'd']);
  });
  it('searches by position number and milling name', () => {
    expect(shape(buildCompositionRows(input({ search: 'нет фрез' })))).toEqual(['P2:b/2', 'b']);
    expect(shape(buildCompositionRows(input({ search: '2 ' })))).toEqual(['P2:bd/2', 'b', 'd']);
  });
});
