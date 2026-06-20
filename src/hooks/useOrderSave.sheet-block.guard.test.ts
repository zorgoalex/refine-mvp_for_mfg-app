import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// SP3: the legacy (non-backend-write) Hasura save path must HARD-BLOCK any draft
// carrying a sheet material — a sheet order is backend-write-only. This guards
// against a regression that would page-level write the backend-owned field.
const saveSrc = readFileSync(new URL('./useOrderSave.ts', import.meta.url), 'utf8');

describe('useOrderSave legacy sheet hard-block', () => {
  it('throws when a non-backend-write draft contains a sheet material', () => {
    // The block lives in the legacy branch (after the useBackendOrdersWrite return).
    const legacyIndex = saveSrc.indexOf('Legacy rollback path');
    expect(legacyIndex).toBeGreaterThan(-1);
    const blockIndex = saveSrc.indexOf('draftHasSheetMaterial');
    expect(blockIndex).toBeGreaterThan(legacyIndex);
    expect(saveSrc).toMatch(/draftHasSheetMaterial[\s\S]*throw new Error/);
    expect(saveSrc).toContain('sheet_material_type_id');
  });

  it('checks both the header and every detail', () => {
    expect(saveSrc).toMatch(/values\.header\.sheet_material_type_id/);
    expect(saveSrc).toMatch(/values\.details[\s\S]*sheet_material_type_id/);
  });
});

describe('OrderDetailsTab bulk material scoping', () => {
  const tabSrc = readFileSync(
    new URL('../pages/orders/components/tabs/OrderDetailsTab.tsx', import.meta.url),
    'utf8',
  );

  it('strips a bulk material_id change for sheet rows', () => {
    expect(tabSrc).toMatch(/isSheetRow[\s\S]*delete updateData\.material_id/);
  });
});
