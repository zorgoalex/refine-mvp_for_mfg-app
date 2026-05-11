import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  ChangeOrderStatusRequest,
  DeleteOrderResponse,
  ImportOrderSnapshotBatchResponse,
  ImportOrderSnapshotResponse,
  OrderDto,
  OrderListQuery,
  OrderListResponse,
  OrderResponse,
  SaveOrderDto,
  SaveOrderResponse,
} from './types/orderApi.types';

export const ordersApi = {
  list(params: OrderListQuery = {}): Promise<OrderListResponse> {
    return httpClient.get<OrderListResponse>(withQuery(apiRoutes.orders.list, params));
  },

  async getById(orderId: number): Promise<OrderDto> {
    const response = await httpClient.get<OrderResponse>(
      apiRoutes.orders.byId(validateOrderId(orderId)),
    );
    return response.order;
  },

  create(dto: SaveOrderDto): Promise<SaveOrderResponse> {
    return httpClient.post<SaveOrderResponse>(apiRoutes.orders.list, dto);
  },

  update(orderId: number, dto: SaveOrderDto): Promise<SaveOrderResponse> {
    return httpClient.put<SaveOrderResponse>(
      apiRoutes.orders.byId(validateOrderId(orderId)),
      dto,
    );
  },

  changeStatus(
    orderId: number,
    request: ChangeOrderStatusRequest,
  ): Promise<OrderResponse> {
    return httpClient.patch<OrderResponse>(
      apiRoutes.orders.status(validateOrderId(orderId)),
      request,
    );
  },

  delete(orderId: number): Promise<DeleteOrderResponse> {
    return httpClient.delete<DeleteOrderResponse>(
      apiRoutes.orders.byId(validateOrderId(orderId)),
    );
  },

  async downloadSnapshot(orderId: number): Promise<void> {
    const response = await httpClient.download(apiRoutes.orders.snapshot(validateOrderId(orderId)));
    saveBlob(response.blob, response.fileName ?? `order-${orderId}-snapshot.erp-order.json`);
  },

  async downloadSnapshotBatch(dateFrom: string, dateTo: string): Promise<void> {
    const response = await httpClient.download(
      withQuery(apiRoutes.orders.snapshotBatch, { dateFrom, dateTo }),
    );
    saveBlob(response.blob, response.fileName ?? `orders-${dateFrom}-${dateTo}.erp-order-batch.zip`);
  },

  async importSnapshotFile(file: File): Promise<ImportOrderSnapshotResponse> {
    const snapshot = JSON.parse(await file.text());
    return httpClient.post<ImportOrderSnapshotResponse>(apiRoutes.orders.importSnapshot, {
      snapshot,
    });
  },

  async importSnapshotBatchFile(file: File): Promise<ImportOrderSnapshotBatchResponse> {
    return httpClient.post<ImportOrderSnapshotBatchResponse>(
      apiRoutes.orders.importSnapshotBatch,
      {
        fileName: file.name,
        zipBase64: await fileToBase64(file),
      },
    );
  },
};

export function withQuery(path: string, params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    searchParams.set(key, String(value));
  }

  const query = searchParams.toString();
  return query ? `${path}?${query}` : path;
}

export function validateOrderId(orderId: number): number {
  if (!Number.isInteger(orderId) || orderId < 1) {
    throw new Error('Invalid orderId');
  }

  return orderId;
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}
