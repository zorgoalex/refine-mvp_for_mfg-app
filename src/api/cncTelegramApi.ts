import { apiRoutes } from './apiRoutes';
import { authSession } from './authSession';
import { httpClient, type RequestOptions } from './httpClient';
import { withQuery } from './ordersApi';
import type {
  CncAutoCutStatusConfigureResponse,
  CncTelegramManualSvgCommentPreset,
  CncTelegramManualSvgUploadRequest,
  CncTelegramManualSvgUploadResponse,
  CncTelegramMediaRestoreResponse,
  CncTelegramOrderCuttingSequencesResponse,
  CncTelegramOriginalBoardResponse,
  CncTelegramOrderScreenshotsResponse,
  CncTelegramTodayResponse,
  CreateCncTelegramManualSvgCommentPresetRequest,
  MdfBoardHistoryOrderOptionsResponse,
  MdfBoardHistoryResponse,
} from './types/cncTelegramApi.types';
import type {
  TelegramWorkerAuditExportQuery,
  TelegramWorkerAuditListResponse,
  TelegramWorkerAuditQuery,
  TelegramWorkerHealthResponse,
  TelegramWorkerTechnicalLogExportQuery,
  TelegramWorkerTechnicalLogListResponse,
  TelegramWorkerTechnicalLogQuery,
} from './types/cncTelegramWorkerAudit.types';

export interface CncTelegramTodayQuery {
  date?: string;
  dateFrom?: string;
  dateTo?: string;
}

interface CncTodayPrefetch {
  key: string;
  sessionGeneration: number;
  createdAt: number;
  promise: Promise<CncTelegramTodayResponse>;
}

const CNC_TODAY_PREFETCH_MAX_AGE_MS = 20_000;
let cncTodayPrefetch: CncTodayPrefetch | null = null;

function cncTodayQueryKey(query: CncTelegramTodayQuery): string {
  return withQuery(apiRoutes.cncTelegram.today, query);
}

function requestCncToday(
  query: CncTelegramTodayQuery,
  options?: RequestOptions,
): Promise<CncTelegramTodayResponse> {
  return httpClient.get<CncTelegramTodayResponse>(cncTodayQueryKey(query), options);
}

export const cncTelegramApi = {
  searchMdfBoardHistoryOrders(
    query: string,
    limit = 20,
    options?: RequestOptions,
  ): Promise<MdfBoardHistoryOrderOptionsResponse> {
    return httpClient.get<MdfBoardHistoryOrderOptionsResponse>(withQuery(
      apiRoutes.cncTelegram.mdfBoardHistoryOrders,
      { query, limit },
    ), options);
  },
  mdfBoardHistory(
    orderId: number,
    date?: string,
    options?: RequestOptions,
  ): Promise<MdfBoardHistoryResponse> {
    assertOrderId(orderId);
    return httpClient.get<MdfBoardHistoryResponse>(withQuery(
      apiRoutes.cncTelegram.mdfBoardHistory(orderId),
      { date },
    ), options);
  },
  originalBoard(options?: RequestOptions): Promise<CncTelegramOriginalBoardResponse> {
    return httpClient.get<CncTelegramOriginalBoardResponse>(
      apiRoutes.cncTelegram.originalBoard,
      options,
    );
  },
  today(
    query: CncTelegramTodayQuery = {},
    options?: RequestOptions,
  ): Promise<CncTelegramTodayResponse> {
    return requestCncToday(query, options);
  },
  prefetchToday(query: CncTelegramTodayQuery): Promise<CncTelegramTodayResponse> {
    const key = cncTodayQueryKey(query);
    const sessionGeneration = authSession.getSessionGeneration();
    if (
      cncTodayPrefetch
      && cncTodayPrefetch.key === key
      && cncTodayPrefetch.sessionGeneration === sessionGeneration
      && Date.now() - cncTodayPrefetch.createdAt <= CNC_TODAY_PREFETCH_MAX_AGE_MS
    ) {
      return cncTodayPrefetch.promise;
    }
    const promise = requestCncToday(query, { cache: 'no-store' });
    const entry: CncTodayPrefetch = {
      key,
      sessionGeneration,
      createdAt: Date.now(),
      promise,
    };
    cncTodayPrefetch = entry;
    void promise.catch(() => {
      if (cncTodayPrefetch === entry) cncTodayPrefetch = null;
    });
    return promise;
  },
  consumePrefetchedToday(
    query: CncTelegramTodayQuery = {},
    options?: RequestOptions,
  ): Promise<CncTelegramTodayResponse> {
    const entry = cncTodayPrefetch;
    const valid = entry
      && entry.key === cncTodayQueryKey(query)
      && entry.sessionGeneration === authSession.getSessionGeneration()
      && Date.now() - entry.createdAt <= CNC_TODAY_PREFETCH_MAX_AGE_MS;
    if (!valid) return requestCncToday(query, options);
    cncTodayPrefetch = null;
    return entry.promise.catch(() => requestCncToday(query, options));
  },
  orderCuttingSequences(orderId: number): Promise<CncTelegramOrderCuttingSequencesResponse> {
    if (!Number.isInteger(orderId) || orderId <= 0) {
      throw new Error('Invalid orderId');
    }
    return httpClient.get<CncTelegramOrderCuttingSequencesResponse>(
      apiRoutes.cncTelegram.orderCuttingSequences(orderId),
    );
  },
  orderScreenshots(orderId: number): Promise<CncTelegramOrderScreenshotsResponse> {
    assertOrderId(orderId);
    return httpClient.get<CncTelegramOrderScreenshotsResponse>(
      apiRoutes.cncTelegram.orderScreenshots(orderId),
    );
  },
  downloadOrderScreenshotPreview(orderId: number, packetId: string) {
    assertOrderScreenshotIdentity(orderId, packetId);
    return httpClient.download(apiRoutes.cncTelegram.orderScreenshotPreview(orderId, packetId));
  },
  downloadOrderScreenshotImage(orderId: number, packetId: string) {
    assertOrderScreenshotIdentity(orderId, packetId);
    return httpClient.download(apiRoutes.cncTelegram.orderScreenshotImage(orderId, packetId));
  },
  restoreOrderScreenshot(orderId: number, packetId: string): Promise<CncTelegramMediaRestoreResponse> {
    assertOrderScreenshotIdentity(orderId, packetId);
    return httpClient.post<CncTelegramMediaRestoreResponse>(
      apiRoutes.cncTelegram.orderScreenshotRestore(orderId, packetId),
      {},
    );
  },
  downloadOrderManualSvgFile(orderId: number, fileId: string) {
    assertOrderManualSvgFileIdentity(orderId, fileId);
    return httpClient.download(apiRoutes.cncTelegram.orderManualSvgFile(orderId, fileId));
  },
  workerLogs(query: TelegramWorkerAuditQuery = {}): Promise<TelegramWorkerAuditListResponse> {
    return httpClient.get<TelegramWorkerAuditListResponse>(
      withQuery(apiRoutes.cncTelegram.workerLogs, query),
    );
  },
  exportWorkerLogs(query: TelegramWorkerAuditExportQuery): Promise<{ blob: Blob; fileName: string | null; status: number }> {
    return httpClient.download(
      withQuery(apiRoutes.cncTelegram.workerLogsExport, query),
    );
  },
  workerTechnicalLogs(query: TelegramWorkerTechnicalLogQuery = {}): Promise<TelegramWorkerTechnicalLogListResponse> {
    return httpClient.get<TelegramWorkerTechnicalLogListResponse>(
      withQuery(apiRoutes.cncTelegram.workerTechnicalLogs, query),
    );
  },
  workerHealth(): Promise<TelegramWorkerHealthResponse> {
    return httpClient.get<TelegramWorkerHealthResponse>(apiRoutes.cncTelegram.workerHealth);
  },
  exportWorkerTechnicalLogs(query: TelegramWorkerTechnicalLogExportQuery): Promise<{ blob: Blob; fileName: string | null; status: number }> {
    return httpClient.download(withQuery(apiRoutes.cncTelegram.workerTechnicalLogsExport, query));
  },
  configureAutoCutStatus(
    enabled: boolean,
    idempotencyKey = createCncAutoCutStatusIdempotencyKey(),
  ): Promise<CncAutoCutStatusConfigureResponse> {
    if (typeof enabled !== 'boolean') throw new Error('Invalid enabled');
    if (idempotencyKey.trim().length < 8 || idempotencyKey.length > 160) {
      throw new Error('Invalid idempotencyKey');
    }
    return httpClient.post<CncAutoCutStatusConfigureResponse>(
      apiRoutes.cncTelegram.autoCutStatus,
      { enabled },
      { headers: { 'Idempotency-Key': idempotencyKey } },
    );
  },
  manualSvgUpload(
    body: CncTelegramManualSvgUploadRequest,
    idempotencyKey: string,
  ): Promise<CncTelegramManualSvgUploadResponse> {
    return httpClient.post<CncTelegramManualSvgUploadResponse>(
      apiRoutes.cncTelegram.manualSvgUpload,
      body,
      { headers: { 'Idempotency-Key': idempotencyKey } },
    );
  },
  listManualSvgCommentPresets(): Promise<CncTelegramManualSvgCommentPreset[]> {
    return httpClient.get<CncTelegramManualSvgCommentPreset[]>(
      apiRoutes.cncTelegram.manualSvgCommentPresets,
    );
  },
  createManualSvgCommentPreset(
    body: CreateCncTelegramManualSvgCommentPresetRequest,
    idempotencyKey: string,
  ): Promise<CncTelegramManualSvgCommentPreset> {
    return httpClient.post<CncTelegramManualSvgCommentPreset>(
      apiRoutes.cncTelegram.manualSvgCommentPresets,
      body,
      { headers: { 'Idempotency-Key': idempotencyKey } },
    );
  },
  downloadSheetImage(path: string): Promise<{ blob: Blob; fileName: string | null; status: number }> {
    return httpClient.download(path);
  },
};

function assertOrderId(orderId: number): void {
  if (!Number.isInteger(orderId) || orderId <= 0) throw new Error('Invalid orderId');
}

function assertOrderScreenshotIdentity(orderId: number, packetId: string): void {
  assertOrderId(orderId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(packetId)) {
    throw new Error('Invalid packetId');
  }
}

function assertOrderManualSvgFileIdentity(orderId: number, fileId: string): void {
  assertOrderId(orderId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) {
    throw new Error('Invalid fileId');
  }
}

export function createCncAutoCutStatusIdempotencyKey(): string {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `cnc-auto-cut-status:${suffix}`;
}
