import { ApiError } from '../../../common/errors/api-error';

export class SheetMaterialNotFoundError extends ApiError {
  constructor(id: number) {
    super(404, 'SHEET_MATERIAL_NOT_FOUND', 'Sheet material type not found', { sheetMaterialTypeId: id });
  }
}

export class SheetMaterialStaleVersionError extends ApiError {
  constructor(expectedVersion: number, actualVersion: number) {
    super(409, 'SHEET_MATERIAL_STALE_VERSION', 'Sheet material type version mismatch', {
      expectedVersion,
      actualVersion,
    });
  }
}
