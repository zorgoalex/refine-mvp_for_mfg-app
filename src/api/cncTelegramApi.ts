import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';
import type {
  CncTelegramOrderCuttingSequencesResponse,
  CncTelegramTodayResponse,
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
  orderCuttingSequences(orderId: number): Promise<CncTelegramOrderCuttingSequencesResponse> {
    if (!Number.isInteger(orderId) || orderId <= 0) {
      throw new Error('Invalid orderId');
    }
    return httpClient.get<CncTelegramOrderCuttingSequencesResponse>(
      apiRoutes.cncTelegram.orderCuttingSequences(orderId),
    );
  },
  downloadSheetImage(path: string): Promise<{ blob: Blob; fileName: string | null; status: number }> {
    return httpClient.download(path);
  },
};
