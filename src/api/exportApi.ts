import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { validateOrderId } from './ordersApi';
import type { ExportOrderRequest, ExportOrderResponse } from './types/orderApi.types';

export const exportApi = {
  exportOrderToGoogleDrive(
    orderId: number,
    request: ExportOrderRequest = { format: 'xlsx' },
  ): Promise<ExportOrderResponse> {
    const orderIdValue = validateOrderId(orderId);
    return httpClient.post<ExportOrderResponse>(
      apiRoutes.orders.exportGoogleDrive(orderIdValue),
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
