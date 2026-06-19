import { describe, it, expect } from 'vitest';
import plan from './plan.js';
const { buildSheetCopyPlan } = plan;

const base = {
  materialId: 1, materialName: 'ЛДСП 2800x2070 16мм', materialTypeId: 2, unitId: 3,
  defaultSupplierId: 5, vendorId: 7, refKey1c: 'k-1', isActive: true, sheetMaterialTypeId: null,
};
const args = (materials, existing = []) => ({
  materials, existingSheetTypesByName: new Map(existing), materialTypeAllowlist: [1, 2],
});

describe('buildSheetCopyPlan', () => {
  it('inserts + links an eligible unlinked sheet material', () => {
    const plan = buildSheetCopyPlan(args([base]));
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]).toMatchObject({
      materialId: 1, name: base.materialName, materialTypeId: 2, unitId: 3,
      supplierId: 5, vendorId: 7, refKey1c: 'k-1', thicknessMm: 16, widthMm: 2800, heightMm: 2070,
    });
    expect(plan.links).toEqual([{ materialId: 1, name: base.materialName }]);
    expect(plan.skipped).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it('skips inactive, wrong-type, already-linked', () => {
    const plan = buildSheetCopyPlan(args([
      { ...base, materialId: 10, isActive: false },
      { ...base, materialId: 11, materialTypeId: 3 },
      { ...base, materialId: 12, sheetMaterialTypeId: 99 },
    ]));
    expect(plan.inserts).toEqual([]); expect(plan.links).toEqual([]);
    expect(plan.skipped).toEqual([
      { materialId: 10, reason: 'inactive' },
      { materialId: 11, reason: 'type-not-allowed' },
      { materialId: 12, reason: 'already-linked' },
    ]);
  });

  // base name 'ЛДСП 2800x2070 16мм' parses to t16/w2800/h2070; full compatible existing row (SP2 never sets
  // supplier_article/texture/color → they must be NULL on the existing row to reuse it):
  const existingMatch = { id: 42, materialTypeId: 2, unitId: 3, supplierId: 5, vendorId: 7, refKey1c: 'k-1',
    isActive: true, thicknessMm: 16, widthMm: 2800, heightMm: 2070, supplierArticle: null, texture: null, color: null };

  it('links to a fully-compatible existing row by name without inserting (idempotent)', () => {
    const plan = buildSheetCopyPlan(args([base], [[base.materialName, existingMatch]]));
    expect(plan.inserts).toEqual([]);
    expect(plan.links).toEqual([{ materialId: 1, name: base.materialName }]);
    expect(plan.conflicts).toEqual([]);
  });

  it('CONFLICTS when an existing row has the same name but different material_type_id/unit_id', () => {
    const plan = buildSheetCopyPlan(args([base], [[base.materialName, { ...existingMatch, materialTypeId: 1 }]]));
    expect(plan.inserts).toEqual([]); expect(plan.links).toEqual([]);
    expect(plan.conflicts).toEqual([{ materialId: 1, name: base.materialName, reason: 'existing-row-mismatch', detail: expect.any(String) }]);
  });

  it('CONFLICTS on provenance mismatch (supplier/vendor/ref_key_1c) even when type+unit agree', () => {
    expect(buildSheetCopyPlan(args([base], [[base.materialName, { ...existingMatch, supplierId: 99 }]])).conflicts).toHaveLength(1);
    expect(buildSheetCopyPlan(args([base], [[base.materialName, { ...existingMatch, refKey1c: 'other' }]])).conflicts).toHaveLength(1);
  });

  it('CONFLICTS when an existing same-name row has non-NULL supplier_article/texture/color (SP2 writes NULL)', () => {
    expect(buildSheetCopyPlan(args([base], [[base.materialName, { ...existingMatch, supplierArticle: 'ART-9' }]])).conflicts).toHaveLength(1);
    expect(buildSheetCopyPlan(args([base], [[base.materialName, { ...existingMatch, texture: true }]])).conflicts).toHaveLength(1);
    expect(buildSheetCopyPlan(args([base], [[base.materialName, { ...existingMatch, color: '白' }]])).conflicts).toHaveLength(1);
  });

  it('CONFLICTS (never reuses) when the existing same-name row is inactive', () => {
    const plan = buildSheetCopyPlan(args([base], [[base.materialName, { ...existingMatch, isActive: false }]]));
    expect(plan.links).toEqual([]);
    expect(plan.conflicts).toEqual([{ materialId: 1, name: base.materialName, reason: 'existing-row-mismatch', detail: expect.any(String) }]);
  });

  it('CONFLICTS when the name yields concrete dims that disagree with the existing row', () => {
    const plan = buildSheetCopyPlan(args([base], [[base.materialName, { ...existingMatch, thicknessMm: 18 }]]));
    expect(plan.conflicts).toHaveLength(1);
  });

  it('CONFLICTS reusing a same-name row whose dims differ from the parse-else-default spec (no ambient inherit)', () => {
    const noDims = { ...base, materialName: 'ЛДСП белый' };   // no parseable dims → spec defaults 16/2800/2070
    const existing = { ...existingMatch, thicknessMm: 25, widthMm: 3000, heightMm: 1500 };
    const plan = buildSheetCopyPlan(args([noDims], [['ЛДСП белый', existing]]));
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.links).toEqual([]);
  });

  it('REUSES a same-name row only when its dims EQUAL the default for a no-dim name', () => {
    const noDims = { ...base, materialName: 'ЛДСП белый' };
    const existing = { ...existingMatch, thicknessMm: 16, widthMm: 2800, heightMm: 2070 };
    const plan = buildSheetCopyPlan(args([noDims], [['ЛДСП белый', existing]]));
    expect(plan.conflicts).toEqual([]);
    expect(plan.links).toEqual([{ materialId: 1, name: 'ЛДСП белый' }]);
  });

  it('partial-dim: name "...18мм" reuses only when existing = 18 thickness + DEFAULT sides', () => {
    const m = { ...base, materialName: 'ЛДСП 18мм' };   // thickness parsed=18, sides default 2800/2070
    expect(buildSheetCopyPlan(args([m], [['ЛДСП 18мм', { ...existingMatch, thicknessMm: 18, widthMm: 2800, heightMm: 2070 }]])).conflicts).toEqual([]);
    expect(buildSheetCopyPlan(args([m], [['ЛДСП 18мм', { ...existingMatch, thicknessMm: 18, widthMm: 2440, heightMm: 1220 }]])).conflicts).toHaveLength(1);
  });

  it('partial-dim: name "...2800x2070" reuses only when existing = default thickness 16', () => {
    const m = { ...base, materialName: 'ЛДСП 2800x2070' };   // sides parsed, thickness default 16
    expect(buildSheetCopyPlan(args([m], [['ЛДСП 2800x2070', { ...existingMatch, thicknessMm: 16, widthMm: 2800, heightMm: 2070 }]])).conflicts).toEqual([]);
    expect(buildSheetCopyPlan(args([m], [['ЛДСП 2800x2070', { ...existingMatch, thicknessMm: 22, widthMm: 2800, heightMm: 2070 }]])).conflicts).toHaveLength(1);
  });

  it('dedups two compatible same-named materials: one insert, two links', () => {
    const plan = buildSheetCopyPlan(args([{ ...base, materialId: 1 }, { ...base, materialId: 2 }]));
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0].materialId).toBe(1);
    expect(plan.links).toEqual([{ materialId: 1, name: base.materialName }, { materialId: 2, name: base.materialName }]);
  });

  it('CONFLICTS when two same-named materials differ within one run', () => {
    const plan = buildSheetCopyPlan(args([{ ...base, materialId: 1 }, { ...base, materialId: 2, unitId: 9 }]));
    expect(plan.inserts).toHaveLength(1);
    expect(plan.links).toEqual([{ materialId: 1, name: base.materialName }]);
    expect(plan.conflicts).toEqual([{ materialId: 2, name: base.materialName, reason: 'within-run-mismatch', detail: expect.any(String) }]);
  });

  it('marks placeholder dims when the name lacks sizes', () => {
    const plan = buildSheetCopyPlan(args([{ ...base, materialName: 'МДФ белый', materialTypeId: 1 }]));
    expect(plan.inserts[0]).toMatchObject({ thicknessMm: 16, widthMm: 2800, heightMm: 2070 });
    expect(plan.inserts[0].dimsParsed).toEqual({ thickness: false, width: false, height: false });
  });
});
