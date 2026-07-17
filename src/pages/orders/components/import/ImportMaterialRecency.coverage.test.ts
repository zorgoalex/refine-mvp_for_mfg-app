import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe.each([
  'ExcelImportModal.tsx',
  'PdfImportModal.tsx',
  'VlmImportModal.tsx',
])('%s material recency coverage', (fileName) => {
  const source = readFileSync(new URL(`./${fileName}`, import.meta.url), 'utf8');

  it('orders material options by current-user recency', () => {
    expect(source).toContain("useRecentReferences('sheet_material_types')");
    expect(source).toContain('sortOptionsByRecency');
  });

  it('promotes unique materials applied by automatic import', () => {
    expect(source).toContain('const usedMaterialIds = new Set<number>()');
    expect(source).toContain('usedMaterialIds.add(Number(row.sheet_material_type_id))');
    expect(source).toContain('usedMaterialIds.forEach(materialRecency.promote)');
  });
});
