import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';
import type {
  CncTelegramManualSvgCommentPreset,
  CncTelegramManualSvgUploadRequest,
  CncTelegramManualSvgUploadResponse,
  CncTelegramOriginalBoardResponse,
  CncTelegramTodayResponse,
  CreateCncMdfCardResponse,
} from './types/cncTelegramApi.types';

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
  originalBoard(): Promise<CncTelegramOriginalBoardResponse> {
    return httpClient.get<CncTelegramOriginalBoardResponse>(
      apiRoutes.cncTelegram.originalBoard,
    );
  },
  downloadSheetImage(path: string): Promise<{ blob: Blob; fileName: string | null; status: number }> {
    return httpClient.download(path);
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
  createMdfCard(cutJobId: number, idempotencyKey: string): Promise<CreateCncMdfCardResponse> {
    return httpClient.post<CreateCncMdfCardResponse>(
      apiRoutes.cncTelegram.createMdfCard(cutJobId),
      {},
      { headers: { 'Idempotency-Key': idempotencyKey } },
    );
  },
  listManualSvgCommentPresets(): Promise<CncTelegramManualSvgCommentPreset[]> {
    return httpClient.get<CncTelegramManualSvgCommentPreset[]>(
      apiRoutes.cncTelegram.manualSvgCommentPresets,
    );
  },
  createManualSvgCommentPreset(
    body: Pick<CncTelegramManualSvgCommentPreset, 'label' | 'commentText'> &
      Partial<Pick<CncTelegramManualSvgCommentPreset, 'category' | 'sortOrder'>>,
    idempotencyKey: string,
  ): Promise<CncTelegramManualSvgCommentPreset> {
    return httpClient.post<CncTelegramManualSvgCommentPreset>(
      apiRoutes.cncTelegram.manualSvgCommentPresets,
      body,
      { headers: { 'Idempotency-Key': idempotencyKey } },
    );
  },
};
