import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';
import type {
  CncAutoCutStatusConfigureResponse,
  CncTelegramOrderCuttingSequencesResponse,
  CncTelegramTodayResponse,
} from './types/cncTelegramApi.types';
import type {
  TelegramWorkerAuditExportQuery,
  TelegramWorkerAuditListResponse,
  TelegramWorkerAuditQuery,
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
  downloadSheetImage(path: string): Promise<{ blob: Blob; fileName: string | null; status: number }> {
    return httpClient.download(path);
  },
};

export function createCncAutoCutStatusIdempotencyKey(): string {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `cnc-auto-cut-status:${suffix}`;
}
