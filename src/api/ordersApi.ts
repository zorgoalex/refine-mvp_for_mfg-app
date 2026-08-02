import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  ChangeOrderStatusRequest,
  DeleteOrderRequest,
  DeleteOrderResponse,
  ImportOrderSnapshotBatchResponse,
  ImportOrderSnapshotReferenceMapping,
  ImportOrderSnapshotResponse,
  OrderDto,
  OrderFormDataResponse,
  OrderListQuery,
  OrderListResponse,
  OrderTransferTargetsResponse,
  OrderResponse,
  RestoreOrderRequest,
  RestoreOrderResponse,
  SaveOrderDto,
  SaveOrderResponse,
  TransferOrderDetailsRequest,
  TransferOrderDetailsResponse,
} from './types/orderApi.types';

export const ordersApi = {
  list(params: OrderListQuery = {}): Promise<OrderListResponse> {
    return httpClient.get<OrderListResponse>(withQuery(apiRoutes.orders.list, params));
  },

  getFormData(): Promise<OrderFormDataResponse> {
    return httpClient.get<OrderFormDataResponse>(apiRoutes.orders.formData);
  },

  async getById(orderId: number, opts?: { includeDeleted?: boolean }): Promise<OrderDto> {
    const basePath = apiRoutes.orders.byId(validateOrderId(orderId));
    const path = opts?.includeDeleted ? withQuery(basePath, { includeDeleted: 'true' }) : basePath;
    const response = await httpClient.get<OrderResponse>(path);
    return response.order;
  },

  listTransferTargets(
    orderId: number,
    params: { search?: string; limit?: number } = {},
  ): Promise<OrderTransferTargetsResponse> {
    return httpClient.get<OrderTransferTargetsResponse>(
      withQuery(apiRoutes.orders.transferTargets(validateOrderId(orderId)), params),
    );
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

  restore(orderId: number, request: RestoreOrderRequest): Promise<RestoreOrderResponse> {
    const version = validateOrderVersion(request.version);
    return httpClient.request<RestoreOrderResponse>(
      apiRoutes.orders.restore(validateOrderId(orderId)),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'If-Match': `"${version}"`,
          'Idempotency-Key': request.idempotencyKey ?? createOrderRestoreIdempotencyKey(),
        },
        body: JSON.stringify(request.orderName ? { orderName: request.orderName } : {}),
      },
    );
  },

  delete(orderId: number, request: DeleteOrderRequest): Promise<DeleteOrderResponse> {
    const version = validateOrderVersion(request.version);
    return httpClient.request<DeleteOrderResponse>(
      apiRoutes.orders.byId(validateOrderId(orderId)),
      {
        method: 'DELETE',
        headers: {
          'If-Match': `"${version}"`,
          'Idempotency-Key': request.idempotencyKey ?? createOrderDeleteIdempotencyKey(),
        },
      },
    );
  },

  transferDetails(
    orderId: number,
    request: TransferOrderDetailsRequest,
  ): Promise<TransferOrderDetailsResponse> {
    const version = validateOrderVersion(request.sourceVersion);
    const body = {
      detailIds: request.detailIds,
      target: request.target,
      ...(request.note !== undefined ? { note: request.note } : {}),
    };
    return httpClient.request<TransferOrderDetailsResponse>(
      apiRoutes.orders.transferDetails(validateOrderId(orderId)),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'If-Match': `"${version}"`,
          'Idempotency-Key': request.idempotencyKey ?? createOrderTransferIdempotencyKey(),
        },
        body: JSON.stringify(body),
      },
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

  async importSnapshotFile(
    file: File,
    referenceMappings: ImportOrderSnapshotReferenceMapping[] = [],
  ): Promise<ImportOrderSnapshotResponse> {
    const snapshot = JSON.parse(await file.text());
    return httpClient.post<ImportOrderSnapshotResponse>(apiRoutes.orders.importSnapshot, {
      snapshot,
      referenceMappings,
    });
  },

  async importSnapshotBatchFile(
    file: File,
    referenceMappings: ImportOrderSnapshotReferenceMapping[] = [],
  ): Promise<ImportOrderSnapshotBatchResponse> {
    return httpClient.post<ImportOrderSnapshotBatchResponse>(
      apiRoutes.orders.importSnapshotBatch,
      {
        fileName: file.name,
        zipBase64: await fileToBase64(file),
        referenceMappings,
      },
    );
  },
};

export function withQuery(path: string, params: object): string {
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

export function validateOrderVersion(version: number): number {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error('Invalid order version');
  }

  return version;
}

export function createOrderDeleteIdempotencyKey(): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return `order-delete:${uuid}`;
}

export function createOrderRestoreIdempotencyKey(): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return `order-restore:${uuid}`;
}

export function createOrderTransferIdempotencyKey(): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return `order-detail-transfer:${uuid}`;
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
