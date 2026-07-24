import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';
import type { CncTelegramTodayResponse } from './types/cncTelegramApi.types';

export const cncTelegramApi = {
  today(query: { date?: string } = {}): Promise<CncTelegramTodayResponse> {
    return httpClient.get<CncTelegramTodayResponse>(
      withQuery(apiRoutes.cncTelegram.today, query),
    );
  },
};
