import type { DatabaseClient } from '../../database/database.types';
import type { CurrentUser } from '../../permissions/current-user';

/**
 * Stock balances of 1C as of a moment («срез остатков на дату»): requested by a user, read from 1C by the
 * agent, kept in ERP until deleted. The port is consumed by the inventory module, which owns the screens, the
 * permissions (`inventory.view` to read, `inventory.manage` to request and delete — checked by the CALLER, the
 * port checks none) and the mapping of 1C keys to ERP warehouses and items. The port writes the audit of
 * `request` and `delete` itself and needs the actor for it.
 *
 * A snapshot holds the whole register for the moment (all warehouses); a warehouse is a filter of reading.
 * There is no «ready» signal: poll `get` / `list` (`updatedAt` moves on every transition).
 */
export const ONEC_STOCK_SNAPSHOTS = Symbol('ONEC_STOCK_SNAPSHOTS');

/** `requested` — in the queue; `config_published` / `syncing` — being read; `ready` / `failed` — final. */
export type StockSnapshotStatus = 'requested' | 'config_published' | 'syncing' | 'ready' | 'failed';
export const STOCK_SNAPSHOT_ACTIVE_STATUSES: readonly StockSnapshotStatus[] = ['requested', 'config_published', 'syncing'];

/** More rows than this in one snapshot is refused (`failed`, `TOO_MANY_ROWS`); `rows` returns the whole array. */
export const STOCK_SNAPSHOT_MAX_ROWS = 20_000;

export interface StockSnapshotView {
  id: number;
  sourceId: number;
  /**
   * The snapshot belongs to the 1C base the source is bound to now. `false` — the base was replaced after the
   * snapshot was read (a historical snapshot): show it as such, never build current documents from it.
   */
  currentSource: boolean;
  /** The moment the snapshot describes, local time of the 1C base: `YYYY-MM-DDTHH:MM:SS`. Movements at exactly this moment are not included. */
  momentLocal: string;
  /** The same moment as an instant (ISO, UTC). */
  momentUtc: string;
  /** IANA zone of the 1C base the local time is in. */
  timeZone: string;
  status: StockSnapshotStatus;
  /** Why a `requested` snapshot has not started yet (a window of the agent, the agent is offline or too old, …); not an error. */
  waitReason: string | null;
  /** Machine code of the failure of a `failed` snapshot. */
  errorCode: string | null;
  requestedBy: { id: number; name: string | null } | null;
  requestedAt: string;
  /** The last transition or change of `waitReason`. */
  updatedAt: string;
  /** When the agent read the register in 1C (`ready` only). */
  readAt: string | null;
  readyAt: string | null;
  /** Rows of the whole register (`ready` only). */
  rowsCount: number | null;
  /** 0 — being read now; n ≥ 1 — n-th in the waiting line of the source (1 — next to start); null — final. */
  queuePosition: number | null;
  /** A waiting snapshot has another one of the source ahead: being read or requested earlier. */
  activeAhead: boolean;
  /** Only with `includeDeleted`. */
  deletedAt: string | null;
}

/** One row of the register: 1C keys (lower case uuid, null — not set in 1C) and the quantity in the unit of the item. */
export interface StockSnapshotRow {
  organizationRefKey: string | null;
  itemRefKey: string;
  characteristicRefKey: string | null;
  batchRefKey: string | null;
  warehouseRefKey: string | null;
  cellRefKey: string | null;
  quantity: number;
}

export interface StockSnapshotWarehouseSummary {
  warehouseRefKey: string | null;
  rows: number;
  quantityTotal: number;
}

export interface StockSnapshotRequest {
  /** Omitted — the only source; several sources and none given → 422. */
  sourceId?: number;
  /** `YYYY-MM-DDTHH:MM:SS`, local time of the 1C base, not in the future. */
  momentLocal: string;
  /**
   * `false` (default): a `ready` or active snapshot of the same moment and of the current base is returned
   * instead of a new one. `true`: always a new snapshot (e.g. documents were posted back-dated).
   */
  force?: boolean;
  /** 8–200 characters; the same key returns the same snapshot. */
  idempotencyKey: string;
}

export interface StockSnapshotListFilter {
  sourceId?: number;
  status?: StockSnapshotStatus;
  /** Leave out historical snapshots (of a replaced 1C base). */
  currentSourceOnly?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Errors are `ApiError`s:
 * - 409 `ONEC_STOCK_SNAPSHOTS_UNAVAILABLE` — the module is switched off (reading of existing snapshots still works);
 * - 404 `ONEC_STOCK_SNAPSHOT_NOT_FOUND` — no such snapshot, or it is deleted (`get` with `includeDeleted` still returns it);
 * - 409 `ONEC_STOCK_SNAPSHOT_NOT_READY` — `rows` / `summary` of a snapshot that is not `ready`;
 * - 409 `ONEC_STOCK_SNAPSHOT_IN_PROGRESS` — `delete` of a snapshot that is being read (`config_published`, `syncing`);
 * - 422 `VALIDATION_ERROR` — a malformed or future moment, a bad key, an unknown source.
 */
export interface OnecStockSnapshotsPort {
  /** Queues a snapshot (or returns the existing one, see `force`). `tx` — the caller's transaction, if any. */
  request(input: StockSnapshotRequest, actor: CurrentUser, requestId: string, tx?: DatabaseClient): Promise<StockSnapshotView>;
  /** Newest first; deleted snapshots are never listed. */
  list(filter?: StockSnapshotListFilter, tx?: DatabaseClient): Promise<{ items: StockSnapshotView[]; total: number }>;
  get(id: number, options?: { includeDeleted?: boolean }, tx?: DatabaseClient): Promise<StockSnapshotView>;
  /** The whole array (at most `STOCK_SNAPSHOT_MAX_ROWS`), optionally of the given warehouses only. */
  rows(id: number, filter?: { warehouseRefKeys?: readonly string[] }, tx?: DatabaseClient): Promise<StockSnapshotRow[]>;
  summary(id: number, tx?: DatabaseClient): Promise<StockSnapshotWarehouseSummary[]>;
  /** `ready` / `failed` — the rows are removed; `requested` — the request is cancelled; being read — 409. */
  delete(id: number, actor: CurrentUser, requestId: string, tx?: DatabaseClient): Promise<void>;
}
