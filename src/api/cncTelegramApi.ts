import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';
import type {
  CncAutoCutStatusConfigureResponse,
  CncTelegramManualSvgCommentPreset,
  CncTelegramManualSvgUploadRequest,
  CncTelegramManualSvgUploadResponse,
  CncTelegramMediaRestoreResponse,
  CncTelegramOrderCuttingSequencesResponse,
  CncTelegramOrderScreenshotsResponse,
  CncTelegramTodayResponse,
  CreateCncTelegramManualSvgCommentPresetRequest,
} from './types/cncTelegramApi.types';
import type {
  TelegramWorkerAuditExportQuery,
  TelegramWorkerAuditListResponse,
  TelegramWorkerAuditQuery,
  TelegramWorkerTechnicalLogExportQuery,
  TelegramWorkerTechnicalLogListResponse,
  TelegramWorkerTechnicalLogQuery,
} from './types/cncTelegramWorkerAudit.types';

export interface CncTelegramTodayQuery {
  date?: string;
  dateFrom?: string;
  dateTo?: string;
}

export const cncTelegramApi = {
  today(query: CncTelegramTodayQuery = {}): Promise<CncTelegramTodayResponse> {
    return httpClient.get<CncTelegramTodayResponse>(
      withQuery(apiRoutes.cncTelegram.today, query),
    );
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
