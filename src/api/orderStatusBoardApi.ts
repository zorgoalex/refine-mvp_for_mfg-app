import { apiRoutes } from './apiRoutes';
import { authSession } from './authSession';
import { httpClient, type RequestOptions } from './httpClient';
import type {
  MdfBoardManualMoveCardKind,
  MdfBoardManualMoveDeleteResponse,
  MdfBoardManualMovesResponse,
  MdfBoardManualMoveTargetColumn,
  MdfBoardManualMoveUpsertResponse,
  OrderStatusBoardQuery,
  OrderStatusBoardResponse,
} from './types/orderStatusBoardApi.types';
import { withQuery } from './ordersApi';

interface StatusBoardPrefetch {
  sessionGeneration: number;
  createdAt: number;
  promise: Promise<OrderStatusBoardResponse>;
}

const STATUS_BOARD_PREFETCH_MAX_AGE_MS = 20_000;
const statusBoardPrefetches = new Map<string, StatusBoardPrefetch>();

export interface MdfManualCommandHeaders {
  sourceToken: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}

function manualCommandOptions(command?: MdfManualCommandHeaders): RequestOptions | undefined {
  if (command===undefined) return undefined;
  if (typeof command.sourceToken!=='string' || !/^[a-f0-9]{64}$/.test(command.sourceToken)
    || typeof command.idempotencyKey!=='string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(command.idempotencyKey)) {
    throw new Error('Invalid MDF command proof or idempotency key');
  }
  // Active writes must never be replayed by auth refresh under another actor.
  // Session-bound orchestration owns explicit retries of this exact command.
  return { skipAuthRefresh: true,signal: command.signal,
    headers: { 'X-Mdf-Source-Token': command.sourceToken,'Idempotency-Key': command.idempotencyKey } };
}

function statusBoardQueryKey(query: OrderStatusBoardQuery): string {
  return withQuery(apiRoutes.orders.statusBoard, query);
}

function requestStatusBoard(
  query: OrderStatusBoardQuery,
  options?: RequestOptions,
): Promise<OrderStatusBoardResponse> {
  return httpClient.get<OrderStatusBoardResponse>(statusBoardQueryKey(query), options);
}

export const orderStatusBoardApi = {
  get(
    query: OrderStatusBoardQuery,
    options?: RequestOptions,
  ): Promise<OrderStatusBoardResponse> {
    return requestStatusBoard(query, options);
  },
  prefetchGet(query: OrderStatusBoardQuery): Promise<OrderStatusBoardResponse> {
    const key = statusBoardQueryKey(query);
    const sessionGeneration = authSession.getSessionGeneration();
    const existing = statusBoardPrefetches.get(key);
    if (
      existing
      && existing.sessionGeneration === sessionGeneration
      && Date.now() - existing.createdAt <= STATUS_BOARD_PREFETCH_MAX_AGE_MS
    ) {
      return existing.promise;
    }
    const promise = requestStatusBoard(query, { cache: 'no-store' });
    const entry: StatusBoardPrefetch = {
      sessionGeneration,
      createdAt: Date.now(),
      promise,
    };
    statusBoardPrefetches.set(key, entry);
    void promise.catch(() => {
      if (statusBoardPrefetches.get(key) === entry) statusBoardPrefetches.delete(key);
    });
    return promise;
  },
  hasPrefetchedGet(query: OrderStatusBoardQuery): boolean {
    const entry = statusBoardPrefetches.get(statusBoardQueryKey(query));
    return Boolean(
      entry
      && entry.sessionGeneration === authSession.getSessionGeneration()
      && Date.now() - entry.createdAt <= STATUS_BOARD_PREFETCH_MAX_AGE_MS,
    );
  },
  consumePrefetchedGet(
    query: OrderStatusBoardQuery,
    options?: RequestOptions,
  ): Promise<OrderStatusBoardResponse> {
    const key = statusBoardQueryKey(query);
    const entry = statusBoardPrefetches.get(key);
    const valid = entry
      && entry.sessionGeneration === authSession.getSessionGeneration()
      && Date.now() - entry.createdAt <= STATUS_BOARD_PREFETCH_MAX_AGE_MS;
    if (!valid) return requestStatusBoard(query, options);
    statusBoardPrefetches.delete(key);
    return entry.promise.catch(() => requestStatusBoard(query, options));
  },
  listMdfManualMoves(options?: RequestOptions): Promise<MdfBoardManualMovesResponse> {
    return httpClient.get<MdfBoardManualMovesResponse>(
      apiRoutes.orders.statusBoardMdfManualMoves,
      options,
    );
  },
  upsertMdfManualMove(
    cardKind: MdfBoardManualMoveCardKind,
    cardId: string,
    targetColumn: MdfBoardManualMoveTargetColumn,
    command?: MdfManualCommandHeaders,
  ): Promise<MdfBoardManualMoveUpsertResponse> {
    const normalizedCardId = assertMdfManualMoveIdentity(cardKind, cardId);
    return httpClient.put<MdfBoardManualMoveUpsertResponse>(
      apiRoutes.orders.statusBoardMdfManualMove(cardKind, normalizedCardId),
      { targetColumn },
      manualCommandOptions(command),
    );
  },
  deleteMdfManualMove(
    cardKind: MdfBoardManualMoveCardKind,
    cardId: string,
    command?: MdfManualCommandHeaders,
  ): Promise<MdfBoardManualMoveDeleteResponse> {
    const normalizedCardId = assertMdfManualMoveIdentity(cardKind, cardId);
    return httpClient.delete<MdfBoardManualMoveDeleteResponse>(
      apiRoutes.orders.statusBoardMdfManualMove(cardKind, normalizedCardId),
      manualCommandOptions(command),
    );
  },
};

function assertMdfManualMoveIdentity(
  cardKind: MdfBoardManualMoveCardKind,
  cardId: string,
): string {
  if (!['packet', 'bazisCutSet', 'bath', 'order'].includes(cardKind)) {
    throw new Error('Invalid cardKind');
  }
  const normalizedCardId = cardId.trim();
  if (!/^[A-Za-z0-9._:-]{1,240}$/.test(normalizedCardId)) {
    throw new Error('Invalid cardId');
  }
  return normalizedCardId;
}
