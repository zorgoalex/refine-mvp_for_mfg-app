import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';
import type { OnecReceiptCardResponse, OnecReceiptListParams, OnecReceiptListResponse } from './types/paymentsOnecApi.types';

/** «Платежи → Поступления 1С»: только backend (ни чтения, ни записи через Hasura). */
export const paymentsOnecApi = {
  listReceipts(params: OnecReceiptListParams): Promise<OnecReceiptListResponse> {
    return httpClient.get<OnecReceiptListResponse>(withQuery(apiRoutes.paymentsOnec.receipts, params));
  },

  getReceipt(lineId: number): Promise<OnecReceiptCardResponse> {
    if (!Number.isInteger(lineId) || lineId <= 0) throw new Error('lineId must be a positive integer');
    return httpClient.get<OnecReceiptCardResponse>(apiRoutes.paymentsOnec.receipt(lineId));
  },
};
