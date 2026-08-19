import { ApiError } from '../../../common/errors/api-error';
import type { CutRepositoryPort } from '../application/cut-command.types';

/** Mirrors UnavailablePaymentRepository: used when no DATABASE_URL is configured. */
export class UnavailableCutRepository implements CutRepositoryPort {
  reconcileExpiredCommands() {
    return Promise.resolve(0);
  }

  createJob() {
    return Promise.reject(unavailable());
  }

  recordPermissionDenied() {
    // Best-effort audit; no DB configured -> no-op (must not mask the 403).
    return Promise.resolve();
  }

  addItems() {
    return Promise.reject(unavailable());
  }

  removeItem() {
    return Promise.reject(unavailable());
  }

  calculate() {
    return Promise.reject(unavailable());
  }

  archive() {
    return Promise.reject(unavailable());
  }

  getDeleteImpact() {
    return Promise.reject(unavailable());
  }

  setCurrentResult() {
    return Promise.reject(unavailable());
  }

  archiveResult() {
    return Promise.reject(unavailable());
  }

  unarchiveResult() {
    return Promise.reject(unavailable());
  }

  getJob() {
    return Promise.reject(unavailable());
  }

  listResults() {
    return Promise.reject(unavailable());
  }

  getResult() {
    return Promise.reject(unavailable());
  }

  listJobs() {
    return Promise.reject(unavailable());
  }

  listEligibleDetails() {
    return Promise.reject(unavailable());
  }

  listDetailPlacements() {
    return Promise.reject(unavailable());
  }

  listDetailLastReady() {
    return Promise.reject(unavailable());
  }

  renderSheetPng() {
    return Promise.reject(unavailable());
  }

  renderSheetSvg() {
    return Promise.reject(unavailable());
  }

  renderGroupPdf() {
    return Promise.reject(unavailable());
  }

  renderJobPdf() {
    return Promise.reject(unavailable());
  }

  setPdfPrewarmState() {
    return Promise.reject(unavailable());
  }

  listSheetTypesForCut() {
    return Promise.reject(unavailable());
  }

  listFilmOptionsForCut() {
    return Promise.reject(unavailable());
  }

  setProfile() {
    return Promise.reject(unavailable());
  }

  setSheetMaterial() {
    return Promise.reject(unavailable());
  }

  setCombineFilms() {
    return Promise.reject(unavailable());
  }

  setSplitByMaterial() {
    return Promise.reject(unavailable());
  }

  setRotationAllowed() {
    return Promise.reject(unavailable());
  }

  setTextureDirection() {
    return Promise.reject(unavailable());
  }

  setJobPdfTemplate() {
    return Promise.reject(unavailable());
  }

  setName() {
    return Promise.reject(unavailable());
  }

  setGroupPdfTemplate() {
    return Promise.reject(unavailable());
  }

  getManualLayoutByKey() {
    return Promise.reject(unavailable());
  }

  upsertManualLayout() {
    return Promise.reject(unavailable());
  }

  listManualLayoutsForJob() {
    return Promise.reject(unavailable());
  }

  saveManualLayout() {
    return Promise.reject(unavailable());
  }

  getRenderCacheToken() {
    return Promise.reject(unavailable());
  }
}

function unavailable(): ApiError {
  return new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is not configured');
}
