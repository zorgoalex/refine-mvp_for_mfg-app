import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Source-text guards (vitest env=node, no jsdom). The cut sheet-type options
// hook must be gated on cut.view + sheetMaterialsReads ONLY — not
// useBackendOrdersWrite or sheet_materials.* perms (Critic R22 B3).
const source = readFileSync(
  fileURLToPath(new URL('../useCutSheetTypeOptions.ts', import.meta.url)),
  'utf8',
);

describe('useCutSheetTypeOptions gating (source guard)', () => {
  it('gates on cut.view permission only (not useBackendOrdersWrite, not sheet_materials.*)', () => {
    expect(source).toContain("can('cut.view')");
    // Must NOT depend on orders-write flag or catalog-level sheet perms.
    expect(source).not.toContain('useBackendOrdersWrite');
    expect(source).not.toMatch(/can\(['"]sheet_materials/);
    expect(source).not.toMatch(/canViewSheetMaterials/);
  });

  it('also requires sheetMaterialsReads schema flag (migration 029+ schema gate)', () => {
    expect(source).toContain('featureFlags.sheetMaterialsReads');
  });

  it('returns enabled=false when cut.view is absent (disabled without cut access)', () => {
    // Source guard: the enabled expression must AND cut.view AND sheetMaterialsReads.
    expect(source).toMatch(/can\(['"]cut\.view['"]\)\s*&&\s*featureFlags\.sheetMaterialsReads/);
  });

  it('exposes the correct interface shape: enabled, options, byId', () => {
    expect(source).toContain('enabled');
    expect(source).toContain('options');
    expect(source).toContain('byId');
    expect(source).toContain('SheetTypeOption');
  });

  it('does NOT import or call useSheetMaterialOptions (independent hook, no cross-dependency)', () => {
    expect(source).not.toContain('useSheetMaterialOptions');
    // And does not reference the catalog sheet grant.
    expect(source).not.toContain("can('sheet_materials.view')");
  });
});
