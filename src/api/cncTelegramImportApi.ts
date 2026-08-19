import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  CncTelegramImportCandidatesResponse,
  CncTelegramImportConfirmRequest,
  CncTelegramImportPrepareRequest,
  CncTelegramImportPrepareResponse,
  CncTelegramImportMatch,
  CncTelegramImportRequest,
  CncTelegramImportScan,
  CncTelegramImportScanRequest,
} from './types/cncTelegramImportApi.types';
import type { CncTelegramImportCandidate } from './types/cncTelegramImportApi.types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizePrepared(
  response: CncTelegramImportPrepareResponse | CncTelegramImportRequest,
): CncTelegramImportPrepareResponse {
  // The backend's persisted request response also contains selectionHash, but
  // it is not the prepare shape (it has items instead of candidates).  Check
  // the fields that are unique to prepare before trusting the response.
  if (Array.isArray((response as Partial<CncTelegramImportPrepareResponse>).candidates)
    && typeof (response as Partial<CncTelegramImportPrepareResponse>).duplicateCount === 'number') {
    return response as CncTelegramImportPrepareResponse;
  }
  const request = response as CncTelegramImportRequest;
  return {
    importRequestId: request.importRequestId,
    scanId: request.scanId,
    selectionHash: '',
    confirmationId: request.confirmationId,
    duplicateMatchVersion: '',
    duplicateCount: request.items.filter((item) => item.matches.length > 0).length,
    candidates: [],
    refreshedMatches: Object.fromEntries(request.items.map((item) => [item.candidateId, item.matches as CncTelegramImportMatch[]])),
    status: request.status,
  };
}

function assertUuid(value: string, name: string): void {
  if (!UUID_RE.test(value)) throw new Error(`Invalid ${name}`);
}

function assertCandidateIds(candidateIds: string[]): void {
  if (!Array.isArray(candidateIds) || candidateIds.length < 1 || candidateIds.length > 500) {
    throw new Error('Invalid candidateIds');
  }
  const distinct = new Set(candidateIds);
  if (distinct.size !== candidateIds.length || candidateIds.some((id) => !UUID_RE.test(id))) {
    throw new Error('Invalid candidateIds');
  }
}

export const cncTelegramImportApi = {
  createScan(body: CncTelegramImportScanRequest, idempotencyKey: string): Promise<CncTelegramImportScan> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(body.dateTo)) {
      throw new Error('Invalid scan date range');
    }
    return httpClient.post<CncTelegramImportScan>(apiRoutes.cncTelegram.importScans, body, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  },

  getScan(scanId: string): Promise<CncTelegramImportScan> {
    assertUuid(scanId, 'scanId');
    return httpClient.get<CncTelegramImportScan>(apiRoutes.cncTelegram.importScan(scanId));
  },

  listCandidates(scanId: string, page = 1, pageSize = 100): Promise<CncTelegramImportCandidatesResponse> {
    assertUuid(scanId, 'scanId');
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new Error('Invalid pagination');
    }
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    return httpClient.get<CncTelegramImportCandidatesResponse | { items: CncTelegramImportCandidate[]; total: number }>(
      `${apiRoutes.cncTelegram.importScanCandidates(scanId)}?${query.toString()}`,
    ).then((response) => 'candidates' in response
      ? response
      : {
        scanId,
        candidates: response.items,
        pagination: { page, pageSize, total: response.total, totalPages: Math.ceil(response.total / pageSize) },
      });
  },

  prepare(scanId: string, body: CncTelegramImportPrepareRequest, idempotencyKey: string): Promise<CncTelegramImportPrepareResponse> {
    assertUuid(scanId, 'scanId');
    assertCandidateIds(body.candidateIds);
    return httpClient.post<CncTelegramImportPrepareResponse | CncTelegramImportRequest>(
      apiRoutes.cncTelegram.importPrepare(scanId),
      body,
      { headers: { 'Idempotency-Key': idempotencyKey } },
    ).then(normalizePrepared);
  },

  confirm(importRequestId: string, body: CncTelegramImportConfirmRequest): Promise<CncTelegramImportRequest> {
    assertUuid(importRequestId, 'importRequestId');
    return httpClient.post<CncTelegramImportRequest>(
      apiRoutes.cncTelegram.importConfirm(importRequestId),
      body,
      { headers: { 'Idempotency-Key': body.confirmationId } },
    );
  },

  getRequest(importRequestId: string): Promise<CncTelegramImportRequest> {
    assertUuid(importRequestId, 'importRequestId');
    return httpClient.get<CncTelegramImportRequest & { candidates?: CncTelegramImportCandidate[]; items: Array<CncTelegramImportRequest['items'][number] & { errorCode?: string | null; errorMessage?: string | null }> }>(apiRoutes.cncTelegram.importRequest(importRequestId))
      .then((response) => {
        const candidates = new Map((response.candidates ?? []).map((candidate) => [candidate.candidateId, candidate]));
        return {
          ...response,
          items: response.items.map((item) => {
          const rawItem = item as CncTelegramImportRequest['items'][number] & { errorCode?: string | null; errorMessage?: string | null };
          return {
            ...item,
            svgFileName: rawItem.svgFileName ?? candidates.get(rawItem.candidateId)?.svgFileName ?? rawItem.candidateId,
            error: rawItem.error ?? rawItem.errorMessage ?? rawItem.errorCode ?? null,
          };
        }),
        };
      });
  },

  prepareRepeat(importRequestId: string, candidateIds: string[], idempotencyKey: string): Promise<CncTelegramImportPrepareResponse> {
    assertUuid(importRequestId, 'importRequestId');
    assertCandidateIds(candidateIds);
    return httpClient.post<CncTelegramImportPrepareResponse | CncTelegramImportRequest>(
      apiRoutes.cncTelegram.importRepeatPrepare(importRequestId),
      { candidateIds },
      { headers: { 'Idempotency-Key': idempotencyKey } },
    ).then(normalizePrepared);
  },
};

export function createCncTelegramImportIdempotencyKey(prefix = 'cnc-telegram-import'): string {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${suffix}`;
}
