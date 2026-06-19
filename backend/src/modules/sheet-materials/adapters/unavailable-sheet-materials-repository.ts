import { ApiError } from '../../../common/errors/api-error';
import type { SheetMaterialsPort } from '../application/sheet-materials.types';

function unavailable(): never {
  throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is not configured');
}

export class UnavailableSheetMaterialsRepository implements SheetMaterialsPort {
  async list() {
    return unavailable();
  }
  async getById() {
    return unavailable();
  }
  async create() {
    return unavailable();
  }
  async update() {
    return unavailable();
  }
  async deactivate() {
    return unavailable();
  }
  async recordPermissionDenied() {
    /* no-op: cannot audit without a DB (mirrors unavailable-cut-config) */
  }
}
