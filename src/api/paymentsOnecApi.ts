import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';
import type {
  OnecReceiptCardResponse, OnecReceiptCommandResponse, OnecReceiptListParams, OnecReceiptListResponse, OnecReceiptMatchRequest,
} from './types/paymentsOnecApi.types';

/** «Платежи → Поступления 1С»: только backend (ни чтения, ни записи через Hasura). Команды — срез B. */
export const paymentsOnecApi = {
  listReceipts(params: OnecReceiptListParams): Promise<OnecReceiptListResponse> {
    return httpClient.get<OnecReceiptListResponse>(withQuery(apiRoutes.paymentsOnec.receipts, params));
  },

  getReceipt(lineId: number): Promise<OnecReceiptCardResponse> {
    if (!Number.isInteger(lineId) || lineId <= 0) throw new Error('lineId must be a positive integer');
    return httpClient.get<OnecReceiptCardResponse>(apiRoutes.paymentsOnec.receipt(lineId));
  },

  match(lineId: number, body: OnecReceiptMatchRequest): Promise<OnecReceiptCommandResponse> {
    return httpClient.post<OnecReceiptCommandResponse>(apiRoutes.paymentsOnec.receiptMatch(lineId), body);
  },

  unmatch(lineId: number, body: { expectedMatchId: number; reason?: string | null }): Promise<OnecReceiptCommandResponse> {
    return httpClient.post<OnecReceiptCommandResponse>(apiRoutes.paymentsOnec.receiptUnmatch(lineId), body);
  },

  dismiss(lineId: number, body: { expectedStateToken: string; note: string }): Promise<OnecReceiptCommandResponse> {
    return httpClient.post<OnecReceiptCommandResponse>(apiRoutes.paymentsOnec.receiptDismiss(lineId), body);
  },

  /** `orderId: null` — «заказ 1С не относится к приложению». */
  linkOrder(lineId: number, body: { expectedStateToken: string; orderId: number | null; note?: string | null }): Promise<OnecReceiptCommandResponse> {
    return httpClient.put<OnecReceiptCommandResponse>(apiRoutes.paymentsOnec.receiptOrderLink(lineId), body);
  },

  unlinkOrder(lineId: number, body: { expectedStateToken: string }): Promise<OnecReceiptCommandResponse> {
    return httpClient.post<OnecReceiptCommandResponse>(apiRoutes.paymentsOnec.receiptOrderUnlink(lineId), body);
  },

  /** «Сверить сейчас»: автосверка по заказам в вашей области доступа. */
  autoMatch(): Promise<{ matched: number; candidates: number; skipped: boolean }> {
    return httpClient.post<{ matched: number; candidates: number; skipped: boolean }>(apiRoutes.paymentsOnec.autoMatch, {});
  },
};
