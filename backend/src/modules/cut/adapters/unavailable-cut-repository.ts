import { ApiError } from '../../../common/errors/api-error';
import type { CutRepositoryPort } from '../application/cut-command.types';

/** Mirrors UnavailablePaymentRepository: used when no DATABASE_URL is configured. */
export class UnavailableCutRepository implements CutRepositoryPort {
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

  getJob() {
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

  setProfile() {
    return Promise.reject(unavailable());
  }
}

function unavailable(): ApiError {
  return new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is not configured');
}
