import { describe, expect, it } from 'vitest';
import type { SheetMaterialTypeDto } from '../../api/sheetMaterialsApi';
import { sheetMaterialEditSource, sheetSupplierPayload } from './editSource';

const snapshot = {
  sheetMaterialTypeId: 5, name: 'МДФ 16', materialTypeId: 1, unitId: 1, thicknessMm: 16, widthMm: 2800, heightMm: 2070,
  supplierId: 3, vendorId: null, supplierArticle: null, texture: null, color: null, refKey1c: null, isActive: true,
  isCuttable: true, sortOrder: 100, version: 7,
} as SheetMaterialTypeDto;

describe('sheet material suppliers in the edit form', () => {
  it('backend snapshot with the list: the form edits all suppliers, the body carries main + additional', () => {
    const source = sheetMaterialEditSource({ ...snapshot, suppliers: [{ id: 3, name: 'A', isActive: true }, { id: 9, name: 'B', isActive: true }], additionalSupplierIds: [9] }, undefined);
    expect(source?.supplierListEditable).toBe(true);
    expect(source?.values.supplierIds).toEqual([3, 9]);
    expect(sheetSupplierPayload({ supplierIds: [9, 3] }, true)).toEqual({ supplierId: 9, additionalSupplierIds: [3] });
    expect(sheetSupplierPayload({ supplierIds: [] }, true)).toEqual({ supplierId: null, additionalSupplierIds: [] });
  });

  it('Hasura fallback (backend GET failed): only the main supplier, no additionalSupplierIds in the body', () => {
    const source = sheetMaterialEditSource(undefined, { name: 'МДФ 16', supplier_id: 3, version: 7 });
    expect(source?.supplierListEditable).toBe(false);
    expect(source?.values.supplierIds).toBeUndefined();
    const body = sheetSupplierPayload({ supplierId: 3, supplierIds: undefined }, false);
    expect(body).toEqual({ supplierId: 3 });
    expect('additionalSupplierIds' in body).toBe(false);
  });

  it('an older backend snapshot without the list behaves like the fallback (its strict schema would reject the field)', () => {
    expect(sheetMaterialEditSource(snapshot, undefined)?.supplierListEditable).toBe(false);
  });
});
