import { ApiError } from '../../../common/errors/api-error';
import type { CutConfigAdminPort } from '../application/cut-config-admin.types';

/** Used when no DATABASE_URL is configured (mirrors UnavailableCutRepository). */
export class UnavailableCutConfigAdminRepository implements CutConfigAdminPort {
  getConfig() {
    return Promise.reject(unavailable());
  }
  recordPermissionDenied() {
    return Promise.resolve();
  }
  updateSetting() {
    return Promise.reject(unavailable());
  }
  upsertParamProfile() {
    return Promise.reject(unavailable());
  }
  deleteParamProfile() {
    return Promise.reject(unavailable());
  }
  upsertRenderPreset() {
    return Promise.reject(unavailable());
  }
  deleteRenderPreset() {
    return Promise.reject(unavailable());
  }
}

function unavailable(): ApiError {
  return new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is not configured');
}
