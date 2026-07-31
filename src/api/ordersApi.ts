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
  OrderResourceDemandQuery,
  OrderResourceDemandResponse,
  OrderResponse,
  RestoreOrderRequest,
  RestoreOrderResponse,
  SaveOrderDto,
  SaveOrderResponse,
} from './types/orderApi.types';

export const ordersApi = {
  list(params: OrderListQuery = {}): Promise<OrderListResponse> {
    return httpClient.get<OrderListResponse>(withQuery(apiRoutes.orders.list, params));
  },

  getFormData(): Promise<OrderFormDataResponse> {
    return httpClient.get<OrderFormDataResponse>(apiRoutes.orders.formData);
  },

  listResourceDemands(params: OrderResourceDemandQuery = {}): Promise<OrderResourceDemandResponse> {
    return httpClient.get<OrderResourceDemandResponse>(withQuery(apiRoutes.orders.resourceDemands, params));
  },

  async getById(orderId: number, opts?: { includeDeleted?: boolean }): Promise<OrderDto> {
    const basePath = apiRoutes.orders.byId(validateOrderId(orderId));
    const path = opts?.includeDeleted ? withQuery(basePath, { includeDeleted: 'true' }) : basePath;
    const response = await httpClient.get<OrderResponse>(path);
    return response.order;
  },

  async create(dto: SaveOrderDto): Promise<SaveOrderResponse> {
    const response = await httpClient.post<SaveOrderResponse>(apiRoutes.orders.list, dto);
    emitOrderDataChanged(response.order.header.orderId);
    return response;
  },

  async update(orderId: number, dto: SaveOrderDto): Promise<SaveOrderResponse> {
    const response = await httpClient.put<SaveOrderResponse>(
      apiRoutes.orders.byId(validateOrderId(orderId)),
      dto,
    );
    emitOrderDataChanged(response.order.header.orderId);
    return response;
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

export const ORDER_DATA_CHANGED_EVENT = 'erp:order-data-changed';
const ORDER_DATA_CHANGED_STORAGE_KEY = 'erp.orderData.changed';

export interface OrderDataChangedPayload {
  orderId: number;
  changedAt: string;
}

export function subscribeOrderDataChanged(listener: (payload: OrderDataChangedPayload) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onWindowEvent = (event: Event) => {
    const payload = readOrderDataChangedPayload((event as CustomEvent<unknown>).detail);
    if (payload) listener(payload);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== ORDER_DATA_CHANGED_STORAGE_KEY || !event.newValue) return;
    try {
      const payload = readOrderDataChangedPayload(JSON.parse(event.newValue));
      if (payload) listener(payload);
    } catch {
      // Same-window event and polling still work when storage contains invalid data.
    }
  };
  window.addEventListener(ORDER_DATA_CHANGED_EVENT, onWindowEvent);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(ORDER_DATA_CHANGED_EVENT, onWindowEvent);
    window.removeEventListener('storage', onStorage);
  };
}

function emitOrderDataChanged(orderId: number): void {
  if (typeof window === 'undefined') return;
  const payload: OrderDataChangedPayload = { orderId, changedAt: new Date().toISOString() };
  window.dispatchEvent(new CustomEvent(ORDER_DATA_CHANGED_EVENT, { detail: payload }));
  try {
    window.localStorage.setItem(ORDER_DATA_CHANGED_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Same-window event and polling remain available.
  }
}

function readOrderDataChangedPayload(value: unknown): OrderDataChangedPayload | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Partial<OrderDataChangedPayload>;
  return Number.isInteger(payload.orderId)
    && (payload.orderId ?? 0) > 0
    && typeof payload.changedAt === 'string'
    ? payload as OrderDataChangedPayload
    : null;
}

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
