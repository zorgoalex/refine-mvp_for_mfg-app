import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type { CutDetailLastReadyJobRef } from './types/cutApi.types';

export interface OrderDetailLiveStateItem {
  detailId: number;
  productionStatusId: number | null;
  cutJob?: CutDetailLastReadyJobRef | null;
  bathCutJob?: CutDetailLastReadyJobRef | null;
}

export interface OrderDetailLiveStateSnapshot {
  orderId: number;
  streamEnabled: boolean;
  streamCursor: string;
  cutRefsAccess: 'allowed' | 'denied';
  details: OrderDetailLiveStateItem[];
}

export interface OrderDetailLiveStateResponse {
  status: 200 | 304;
  etag: string | null;
  streamCursor: string;
  streamEnabled: boolean;
  snapshot: OrderDetailLiveStateSnapshot | null;
}

export class OrderRealtimeHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'OrderRealtimeHttpError';
  }
}

export const orderRealtimeApi = {
  async getDetailLiveState(
    orderId: number,
    options: { etag?: string | null; signal?: AbortSignal } = {},
  ): Promise<OrderDetailLiveStateResponse> {
    const headers = new Headers({ Accept: 'application/json' });
    if (options.etag) headers.set('If-None-Match', options.etag);

    const response = await httpClient.raw(apiRoutes.orders.detailLiveState(orderId), {
      method: 'GET',
      headers,
      signal: options.signal,
    });
    const streamCursor = response.headers.get('X-ERP-Stream-Cursor') ?? '';
    const streamEnabledHeader = response.headers.get('X-ERP-Realtime-Enabled');
    const streamEnabled = streamEnabledHeader === 'true';
    const etag = response.headers.get('ETag');

    if (response.status === 304) {
      return { status: 304, etag, streamCursor, streamEnabled, snapshot: null };
    }
    if (!response.ok) {
      throw new OrderRealtimeHttpError(response.status, response.statusText || 'Realtime snapshot failed');
    }

    const body = await response.json() as unknown;
    const snapshot = parseOrderDetailLiveStateSnapshot(body, orderId);
    return {
      status: 200,
      etag,
      streamCursor: streamCursor || snapshot.streamCursor,
      streamEnabled: streamEnabledHeader === null ? snapshot.streamEnabled : streamEnabled,
      snapshot,
    };
  },

  openLiveEvents(
    orderId: number,
    snapshotCursor: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const headers = new Headers({ Accept: 'text/event-stream' });
    if (snapshotCursor) headers.set('Last-Event-ID', snapshotCursor);
    return httpClient.raw(apiRoutes.orders.liveEvents(orderId), {
      method: 'GET',
      cache: 'no-store',
      headers,
      signal,
    });
  },
};

function parseOrderDetailLiveStateSnapshot(
  value: unknown,
  expectedOrderId: number,
): OrderDetailLiveStateSnapshot {
  if (!isRecord(value) || value.orderId !== expectedOrderId || !Array.isArray(value.details)) {
    throw new OrderRealtimeHttpError(200, 'Invalid realtime snapshot');
  }
  if (
    typeof value.streamCursor !== 'string'
    || typeof value.streamEnabled !== 'boolean'
    || (value.cutRefsAccess !== 'allowed' && value.cutRefsAccess !== 'denied')
  ) {
    throw new OrderRealtimeHttpError(200, 'Invalid realtime snapshot metadata');
  }

  return {
    orderId: expectedOrderId,
    streamEnabled: value.streamEnabled,
    streamCursor: value.streamCursor,
    cutRefsAccess: value.cutRefsAccess,
    details: value.details.map(parseDetailLiveState),
  };
}

function parseDetailLiveState(value: unknown): OrderDetailLiveStateItem {
  if (!isRecord(value) || !isPositiveInteger(value.detailId)) {
    throw new OrderRealtimeHttpError(200, 'Invalid realtime detail state');
  }
  const productionStatusId = value.productionStatusId;
  if (productionStatusId !== null && !isPositiveInteger(productionStatusId)) {
    throw new OrderRealtimeHttpError(200, 'Invalid realtime production status');
  }

  return {
    detailId: value.detailId,
    productionStatusId,
    ...(value.cutJob === undefined ? {} : { cutJob: parseCutJobRef(value.cutJob) }),
    ...(value.bathCutJob === undefined ? {} : { bathCutJob: parseCutJobRef(value.bathCutJob) }),
  };
}

function parseCutJobRef(value: unknown): CutDetailLastReadyJobRef | null {
  if (value === null) return null;
  if (
    !isRecord(value)
    || !isPositiveInteger(value.cutJobId)
    || !isPositiveInteger(value.resultNo)
    || typeof value.cutNumber !== 'string'
    || typeof value.name !== 'string'
  ) {
    throw new OrderRealtimeHttpError(200, 'Invalid realtime cut reference');
  }
  return {
    cutJobId: value.cutJobId,
    resultNo: value.resultNo,
    cutNumber: value.cutNumber,
    name: value.name,
    paramProfileId: nullableInteger(value.paramProfileId),
    profileName: nullableString(value.profileName),
    profileIsActive: nullableBoolean(value.profileIsActive),
  };
}

function nullableInteger(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value)) throw new OrderRealtimeHttpError(200, 'Invalid cut profile id');
  return value as number;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new OrderRealtimeHttpError(200, 'Invalid cut profile name');
  return value;
}

function nullableBoolean(value: unknown): boolean | null {
  if (value === null) return null;
  if (typeof value !== 'boolean') throw new OrderRealtimeHttpError(200, 'Invalid cut profile state');
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
