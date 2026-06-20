import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// SP3 invariant 5 (detail-level new-only): an EXISTING detail saved as legacy (persisted
// detail_id, no stored sheet id) must NOT be flippable to a sheet detail in the UI — the
// backend rejects the flip with 422, so the picker must not be offered for such rows.
// Verified as source-text guards (Vitest node env, no DOM).
const modalSrc = readFileSync(
  new URL('./modals/OrderDetailModal.tsx', import.meta.url),
  'utf8',
);
const tableSrc = readFileSync(
  new URL('./tables/OrderDetailTable.tsx', import.meta.url),
  'utf8',
);

describe('OrderDetailModal hides the sheet picker for existing legacy rows', () => {
  it('derives an existing-legacy-detail guard from a persisted detail_id with no stored sheet id', () => {
    expect(modalSrc).toMatch(/isExistingDetail\s*=\s*typeof detail\?\.detail_id === ['"]number['"]/);
    expect(modalSrc).toMatch(/isExistingLegacyDetail\s*=\s*isExistingDetail\s*&&\s*!detailHasStoredSheetId/);
  });

  it('gates showSheetPicker on NOT being an existing legacy detail', () => {
    expect(modalSrc).toMatch(/showSheetPicker\s*=[\s\S]{0,80}!isExistingLegacyDetail/);
  });
});

describe('OrderDetailTable inline picker is read-only for existing legacy rows', () => {
  it('renders the sheet column read-only when the row is a persisted legacy detail', () => {
    // editing path must exclude rows with a persisted detail_id and no stored sheet id
    expect(tableSrc).toMatch(
      /isEditing\(record\)\s*&&[\s\S]{0,200}record\.detail_id[\s\S]{0,160}sheet_material_type_id/,
    );
  });
});
