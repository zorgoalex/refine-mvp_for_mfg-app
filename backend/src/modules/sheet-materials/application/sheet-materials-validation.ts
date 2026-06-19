import { ApiError } from '../../../common/errors/api-error';
import type { SheetMaterialTypeInput } from './sheet-materials.types';

/**
 * Server-side structural validation for sheet material types. Layered on top of
 * the controller Zod schema so non-HTTP callers cannot bypass it. Throws 422 with
 * a normalized { errors: [{ field, message }] } shape.
 */
export function validateSheetMaterialTypeInput(input: SheetMaterialTypeInput): void {
  const errors: { field: string; message: string }[] = [];
  if (!input.name || input.name.trim().length === 0) {
    errors.push({ field: 'name', message: 'name is required' });
  }
  if (!Number.isInteger(input.materialTypeId) || input.materialTypeId <= 0) {
    errors.push({ field: 'materialTypeId', message: 'materialTypeId must be a positive integer' });
  }
  if (!Number.isInteger(input.unitId) || input.unitId <= 0) {
    errors.push({ field: 'unitId', message: 'unitId must be a positive integer' });
  }
  if (!(input.thicknessMm > 0)) {
    errors.push({ field: 'thicknessMm', message: 'thicknessMm must be > 0' });
  }
  if (!(input.widthMm > 0)) {
    errors.push({ field: 'widthMm', message: 'widthMm must be > 0' });
  }
  if (!(input.heightMm > 0)) {
    errors.push({ field: 'heightMm', message: 'heightMm must be > 0' });
  }
  // Optional FK fields: when present (non-null), must be positive integers.
  if (input.supplierId != null && (!Number.isInteger(input.supplierId) || input.supplierId <= 0)) {
    errors.push({ field: 'supplierId', message: 'supplierId must be a positive integer' });
  }
  if (input.vendorId != null && (!Number.isInteger(input.vendorId) || input.vendorId <= 0)) {
    errors.push({ field: 'vendorId', message: 'vendorId must be a positive integer' });
  }
  if (input.texture != null && typeof input.texture !== 'boolean') {
    errors.push({ field: 'texture', message: 'texture must be boolean' });
  }
  if (errors.length > 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Sheet material payload validation failed', { errors });
  }
}
