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
  MdfBathDuplicatesOfBath,
  MdfBathDuplicatesResponse,
  ResolveMdfBathDuplicateRequest,
  ResolveMdfBathDuplicateResponse,
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
  /** Engine active: forward placement of a machine file of another material (no engine source, no token). The
   * column the operator saw guards against a stale board; the key makes an explicit retry the same command. */
  /** Forward move of a card outside the MDF engine: a non-MDF machine file or a BASIS set with no MDF detail. */
  upsertNonMdfMove(
    cardKind: 'packet' | 'bazisCutSet',
    cardId: string,
    targetColumn: 'completed' | 'completed_laminated',
    expectedColumn: 'parsed' | 'completed',
    idempotencyKey: string,
  ): Promise<MdfBoardManualMoveUpsertResponse> {
    const normalizedCardId = assertMdfManualMoveIdentity(cardKind, cardId);
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) throw new Error('Invalid MDF command idempotency key');
    return httpClient.put<MdfBoardManualMoveUpsertResponse>(
      apiRoutes.orders.statusBoardMdfManualMove(cardKind, normalizedCardId),
      { targetColumn, expectedColumn },
      { skipAuthRefresh: true, headers: { 'Idempotency-Key': idempotencyKey } },
    );
  },
  /** «Разобрать дубль» facts of hybrid-board engine baths outside the legacy read; ≤ 100 ids per request. */
  async listMdfBathDuplicates(bathCardIds: readonly string[], options?: RequestOptions): Promise<MdfBathDuplicatesOfBath[]> {
    const ids = [...new Set(bathCardIds)].filter(id => /^cut-result:[1-9][0-9]{0,15}$/.test(id)).sort();
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
    const responses = await Promise.all(chunks.map(chunk => httpClient.get<MdfBathDuplicatesResponse>(
      withQuery(apiRoutes.orders.statusBoardMdfBathDuplicates, { bathCardIds: chunk.join(',') }), options)));
    return responses.flatMap(response => response.baths);
  },
  /** «Разобрать дубль»: keep both baths or mark this bath's shared details as rework. The key makes an explicit
   * retry the same decision; never replayed by auth refresh under another actor. */
  resolveMdfBathDuplicate(
    request: ResolveMdfBathDuplicateRequest,
    idempotencyKey: string,
  ): Promise<ResolveMdfBathDuplicateResponse> {
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) throw new Error('Invalid MDF command idempotency key');
    if (!/^cut-result:[1-9][0-9]{0,15}$/.test(request.bathCardId)
      || !/^cut-result:[1-9][0-9]{0,15}$/.test(request.otherBathCardId)
      || !/^[a-f0-9]{64}$/.test(request.expectedDigest)) {
      throw new Error('Invalid MDF bath duplicate request');
    }
    return httpClient.post<ResolveMdfBathDuplicateResponse>(
      apiRoutes.orders.statusBoardMdfBathDuplicatesResolve,
      request,
      { skipAuthRefresh: true, headers: { 'Idempotency-Key': idempotencyKey } },
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
