import { httpClient } from './httpClient';
import { validateOrderId } from './ordersApi';
import type { ExportOrderRequest, ExportOrderResponse } from './types/orderApi.types';

export const exportApi = {
  exportOrderToGoogleDrive(
    orderId: number,
    request: ExportOrderRequest = { format: 'xlsx' },
  ): Promise<ExportOrderResponse> {
    return httpClient.post<ExportOrderResponse>(
      `/api/orders/${validateOrderId(orderId)}/export/google-drive`,
      normalizeExportOrderRequest(request),
    );
  },
};

export function normalizeExportOrderRequest(
  request: ExportOrderRequest | undefined,
): ExportOrderRequest {
  const format = request?.format ?? 'xlsx';
  const fileName = request?.fileName?.trim() || null;

  return {
    format,
    ...(fileName ? { fileName } : {}),
  };
}
