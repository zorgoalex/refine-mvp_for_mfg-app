import { describe, expect, it } from 'vitest';
import { applyVariantChanges, cloneVariant, createGroups, refreshVariant, validateComposition, type CadSourceSnapshot, type CadVariant } from './cad-workspace';
const source: CadSourceSnapshot = { id: 'source', orderId: 1, orderName: 'Тест заказ', capturedAt: '2026-09-06', parts: [{ orderId: 1, detailId: 11, detailNumber: 1, widthMm: 200, heightMm: 400, quantity: 10, thicknessMm: 16, material: 'МДФ', millingTypeId: 1, millingName: 'Тест', edgeName: '', recipe: { code: 'quadro', version: '1', parameters: {} } }] };
const original: CadVariant = { id: 'original', workspaceId: 'workspace', kind: 'original', name: 'Оригинал', version: 1, sources: [source], groups: createGroups([source], () => 'g1'), createdAt: '2026-09-06', parentId: null, jobId: null, renderRevision: null };
const working = () => cloneVariant(original, 'working', 'Рабочая 1', '2026-09-06');
describe('CAD document invariants', () => {
  it('protects original and uses CAS for working saves', () => {
    expect(() => applyVariantChanges(original, 1, original.groups, original.sources)).toThrow('Оригинал');
    expect(() => applyVariantChanges(working(), 2, original.groups, original.sources)).toThrow('другим пользователем');
    expect(applyVariantChanges(working(), 1, original.groups, original.sources).version).toBe(2);
  });
  it('clones independently, never links mutable arrays or render state', () => {
    const next = working(); next.groups[0].recipe!.parameters.depth = 2; next.sources[0].parts[0].quantity = 2;
    expect(original.groups[0].recipe!.parameters).toEqual({}); expect(source.parts[0].quantity).toBe(10); expect(next.jobId).toBeNull();
  });
  it('conserves summed quantity across recipe splits, independently per variant', () => {
    const groups = [{ ...original.groups[0], quantity: 4 }, { ...original.groups[0], id: 'g2', quantity: 6, recipe: null }];
    expect(validateComposition(groups, [source])).toEqual([]);
    expect(validateComposition([{ ...groups[0], quantity: 5 }, groups[1]], [source]).map(i => i.code)).toContain('QUANTITY_EXCEEDED');
    expect(validateComposition(original.groups, [source])).toEqual([]);
  });
  it('rejects forged provenance and source replacement in save', () => {
    expect(() => applyVariantChanges(working(), 1, [{ ...original.groups[0], detailId: 99 }], [source])).toThrow('источник');
    expect(() => applyVariantChanges(working(), 1, original.groups, [{ ...source, id: 'new' }])).toThrow('новую версию');
    expect(validateComposition(original.groups, [source, { ...source, id: 'new' }]).map(i => i.code)).toContain('SOURCE_DUPLICATE');
  });
  it('refresh preserves selected groups, overrides and quantity conflicts; no auto-add/trim', () => {
    const v = working(); v.groups[0].recipe!.parameters.depth_mm = 2;
    const fresh = structuredClone(source); fresh.id = 'fresh'; fresh.parts[0].quantity = 3; fresh.parts.push({ ...fresh.parts[0], detailId: 12 });
    const result = refreshVariant(v, [fresh], 'new', 'Новая', '2026-09-07');
    expect(result.variant.groups).toHaveLength(1); expect(result.variant.groups[0].quantity).toBe(10);
    expect(result.variant.groups[0].recipe!.parameters).toEqual({ depth_mm: 2 });
    expect(result.issues.map(i => i.code)).toContain('QUANTITY_EXCEEDED'); expect(original.sources[0].id).toBe('source');
  });
  it('refresh retains missing position as explicit conflict', () => {
    const result = refreshVariant(working(), [{ ...source, id: 'fresh', parts: [] }], 'new', 'Новая', 'today');
    expect(result.variant.groups).toHaveLength(1); expect(result.issues[0].code).toBe('SOURCE_PART_MISSING');
  });
  it('enforces both 30mm dimensions and finite placement', () => {
    const small = structuredClone(source); small.parts[0].heightMm = 29;
    expect(validateComposition([{ ...original.groups[0], xMm: NaN }], [small]).map(i => i.code)).toEqual(['PLACEMENT_INVALID', 'CNC_MINIMUM_SIZE']);
  });
  it('keeps stable order/detail identity when importing another order', () => {
    const other = { ...source, id: 'second', orderId: 2, parts: source.parts.map(p => ({ ...p, orderId: 2 })) };
    let n = 0; expect(validateComposition(createGroups([source, other], () => String(++n)), [source, other])).toEqual([]);
  });
});
