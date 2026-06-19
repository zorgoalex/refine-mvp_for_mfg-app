import { describe, it, expect } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import { validateSheetMaterialTypeInput } from './sheet-materials-validation';
import type { SheetMaterialTypeInput } from './sheet-materials.types';

const valid = { name: 'ЛДСП 16', materialTypeId: 2, unitId: 1, thicknessMm: 16, widthMm: 2800, heightMm: 2070 };

/** Returns the list of failed field names (validation errors live in details.errors). */
function failedFields(input: SheetMaterialTypeInput): string[] {
  try {
    validateSheetMaterialTypeInput(input);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(422);
    const errors = ((error as ApiError).details?.errors ?? []) as { field: string }[];
    return errors.map((e) => e.field);
  }
}

describe('validateSheetMaterialTypeInput', () => {
  it('accepts a valid input', () => {
    expect(() => validateSheetMaterialTypeInput(valid)).not.toThrow();
  });
  it('rejects empty name', () => {
    expect(failedFields({ ...valid, name: '  ' })).toContain('name');
  });
  it('rejects non-positive dimensions', () => {
    expect(failedFields({ ...valid, widthMm: 0 })).toContain('widthMm');
  });
  it('rejects non-positive unitId', () => {
    expect(failedFields({ ...valid, unitId: 0 })).toContain('unitId');
  });
  it('rejects non-positive supplierId when present', () => {
    expect(failedFields({ ...valid, supplierId: 0 })).toContain('supplierId');
  });
  it('rejects non-positive vendorId when present', () => {
    expect(failedFields({ ...valid, vendorId: -1 })).toContain('vendorId');
  });
  it('accepts null/omitted supplierId/vendorId', () => {
    expect(() => validateSheetMaterialTypeInput({ ...valid, supplierId: null, vendorId: null })).not.toThrow();
  });
});
