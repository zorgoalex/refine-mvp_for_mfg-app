import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// Variant B: all details use sheet_material_type_id — legacy material_id is always null.
// SP3 "no-flip" guards (isExistingLegacyDetail / showSheetPicker gate) are intentionally
// removed: the concept of a "legacy row that must not flip" no longer exists in VB because
// every row is a sheet row.
// These guards confirm that the VB-era invariants are in place:
//   - The modal shows an unconditional sheet picker (no conditional gate).
//   - The table column is keyed on sheet_material_type_id unconditionally.
const modalSrc = readFileSync(
  new URL('./modals/OrderDetailModal.tsx', import.meta.url),
  'utf8',
);
const tableSrc = readFileSync(
  new URL('./tables/OrderDetailTable.tsx', import.meta.url),
  'utf8',
);

describe('OrderDetailModal VB: unconditional sheet picker (no legacy guard)', () => {
  it('no longer contains isExistingLegacyDetail (SP3 guard removed in VB)', () => {
    expect(modalSrc).not.toMatch(/isExistingLegacyDetail/);
  });

  it('no longer conditionally gates the sheet picker on showSheetPicker', () => {
    // In VB the picker is always rendered — showSheetPicker is gone or not used as a gate.
    expect(modalSrc).not.toMatch(/\{showSheetPicker\s*&&/);
  });

  it('sheet picker Form.Item is unconditionally present with name sheet_material_type_id', () => {
    expect(modalSrc).toMatch(/name=["']sheet_material_type_id["']/);
  });
});

describe('OrderDetailTable VB: sheet column unconditional', () => {
  it('table column is keyed on sheet_material_type_id', () => {
    expect(tableSrc).toMatch(/dataIndex:\s*['"]sheet_material_type_id['"]/);
  });

  it('no longer has a conditional spread for the sheet column', () => {
    expect(tableSrc).not.toMatch(/showSheetPicker\s*\?/);
  });
});
