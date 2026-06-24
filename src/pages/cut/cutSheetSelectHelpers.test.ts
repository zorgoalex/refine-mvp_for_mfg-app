import { describe, expect, it } from 'vitest';
import { jobMaterialTypeIds, partitionSheetOptions, isMixedMaterialSelection, formatSheetOptionLabel } from './cutSheetSelectHelpers';

const opt = (id: number, mt: number) => ({ sheetMaterialTypeId: id, name: `S${id}`, materialTypeId: mt, thicknessMm: 18, widthMm: 2800, heightMm: 2070, isCuttable: true });

describe('cutSheetSelectHelpers', () => {
  const options = [opt(1, 5), opt(2, 5), opt(3, 8)];

  it('jobMaterialTypeIds maps detail sheet ids to their material types', () => {
    const mt = jobMaterialTypeIds([1, 3, null], options);
    expect([...mt].sort()).toEqual([5, 8]);
  });

  it('partitionSheetOptions puts same-material variants first', () => {
    const { preferred, others } = partitionSheetOptions(options, new Set([5]));
    expect(preferred.map((o) => o.sheetMaterialTypeId)).toEqual([1, 2]);
    expect(others.map((o) => o.sheetMaterialTypeId)).toEqual([3]);
  });

  it('isMixedMaterialSelection is true when chosen material is absent from the job', () => {
    expect(isMixedMaterialSelection(3, options, new Set([5]))).toBe(true);
    expect(isMixedMaterialSelection(1, options, new Set([5]))).toBe(false);
    expect(isMixedMaterialSelection(null, options, new Set([5]))).toBe(false);
  });

  it('isMixedMaterialSelection is true when the job spans multiple materials and chosen matches only one', () => {
    expect(isMixedMaterialSelection(1, options, new Set([5, 8]))).toBe(true);
  });

  it('formatSheetOptionLabel renders name, thickness and dims', () => {
    expect(formatSheetOptionLabel(opt(1, 5))).toContain('S1');
    expect(formatSheetOptionLabel(opt(1, 5))).toContain('18');
    expect(formatSheetOptionLabel(opt(1, 5))).toMatch(/2800.*2070/);
  });
});
