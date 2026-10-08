import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser } from '../../permissions/current-user';
import {
  STOCK_SNAPSHOT_MAX_ROWS,
  type OnecStockSnapshotsPort, type StockSnapshotCapabilities, type StockSnapshotListFilter, type StockSnapshotRequest, type StockSnapshotRow, type StockSnapshotStatus,
  type StockSnapshotView, type StockSnapshotWarehouseSummary,
} from './onec-stock-snapshots.port';

const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

interface Stored {
  view: StockSnapshotView;
  idempotencyKey: string;
  generation: number;
  rows: StockSnapshotRow[];
}

/**
 * In-memory implementation of the port for tests of its consumers: the same contract (errors, dedup, deletion)
 * without 1C. A test moves a snapshot along with `complete` / `fail`, replaces the 1C base with `replaceBase`.
 * The offset of the local time is fixed (UTC+5 by default) — enough for a consumer's tests.
 */
export class InMemoryOnecStockSnapshots implements OnecStockSnapshotsPort {
  private readonly stored = new Map<number, Stored>();
  /** Every accepted request key → the snapshot it was answered with (for ever). */
  private readonly keys = new Map<string, number>();
  private nextId = 1;
  private generation = 1;
  /** `false` — switched off by the flag: no new requests; reading and deleting still work. */
  enabled = true;
  /** The agent of the source cannot read balances as of a moment. */
  agentTooOld = false;

  constructor(private readonly options: { sourceId?: number; timeZone?: string; utcOffsetHours?: number; now?: () => Date } = {}) {}

  private now(): Date { return this.options.now?.() ?? new Date(); }
  private baseRefOf(generation: number): string { return `00000000-0000-4000-8000-${String(generation).padStart(12, '0')}`; }
  private get sourceId(): number { return this.options.sourceId ?? 1; }

  async capabilities(sourceId?: number): Promise<StockSnapshotCapabilities> {
    if (sourceId !== undefined && sourceId !== this.sourceId) return { readAvailable: true, commandsAvailable: false, reason: 'SOURCE_NOT_CONFIGURED' };
    if (!this.enabled) return { readAvailable: true, commandsAvailable: false, reason: 'MODULE_DISABLED' };
    if (this.agentTooOld) return { readAvailable: true, commandsAvailable: false, reason: 'AGENT_TOO_OLD' };
    return { readAvailable: true, commandsAvailable: true, reason: null };
  }

  async request(input: StockSnapshotRequest, actor: CurrentUser, _requestId: string): Promise<StockSnapshotView> {
    const capabilities = await this.capabilities();
    if (!capabilities.commandsAvailable) {
      throw new ApiError(409, 'ONEC_STOCK_SNAPSHOTS_UNAVAILABLE', 'Запросить срез остатков 1С сейчас нельзя', { reason: capabilities.reason });
    }
    if (input.sourceId !== undefined && input.sourceId !== this.sourceId) throw new ApiError(422, 'VALIDATION_ERROR', 'Неизвестный источник 1С');
    if (!MOMENT.test(input.momentLocal)) throw new ApiError(422, 'VALIDATION_ERROR', 'Момент среза: ГГГГ-ММ-ДДTЧЧ:ММ:СС');
    if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) throw new ApiError(422, 'VALIDATION_ERROR', 'Ключ запроса: 8–200 символов');
    const momentUtc = new Date(Date.parse(`${input.momentLocal}Z`) - (this.options.utcOffsetHours ?? 5) * 3_600_000);
    if (Number.isNaN(momentUtc.getTime())) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный момент среза');
    if (momentUtc.getTime() > this.now().getTime()) throw new ApiError(422, 'VALIDATION_ERROR', 'Момент среза не может быть в будущем');
    const all = [...this.stored.values()];
    const repeated = this.keys.get(input.idempotencyKey);
    if (repeated !== undefined) return this.present(this.stored.get(repeated)!);
    if (!input.force) {
      const same = all.filter((item) => item.view.deletedAt === null && item.generation === this.generation && item.view.momentLocal === input.momentLocal
        && item.view.status !== 'failed').sort((a, b) => b.view.id - a.view.id)[0];
      if (same) {
        this.keys.set(input.idempotencyKey, same.view.id);
        return this.present(same);
      }
    }
    const at = this.now().toISOString();
    const item: Stored = {
      idempotencyKey: input.idempotencyKey, generation: this.generation, rows: [],
      view: {
        id: this.nextId++, sourceId: this.sourceId, currentSource: true, baseRef: this.baseRefOf(this.generation), momentLocal: input.momentLocal, momentUtc: momentUtc.toISOString(),
        timeZone: this.options.timeZone ?? 'Asia/Almaty', status: 'requested', waitReason: null, errorCode: null,
        requestedBy: { id: Number(actor.id), name: actor.username }, requestedAt: at, updatedAt: at, readAt: null, readyAt: null, rowsCount: null,
        queuePosition: null, activeAhead: false, deletedAt: null,
      },
    };
    this.stored.set(item.view.id, item);
    this.keys.set(input.idempotencyKey, item.view.id);
    return this.present(item);
  }

  async list(filter: StockSnapshotListFilter = {}): Promise<{ items: StockSnapshotView[]; total: number }> {
    const items = [...this.stored.values()].filter((item) => item.view.deletedAt === null)
      .filter((item) => filter.sourceId === undefined || item.view.sourceId === filter.sourceId)
      .filter((item) => filter.status === undefined || item.view.status === filter.status)
      .filter((item) => !filter.currentSourceOnly || item.generation === this.generation)
      .filter((item) => filter.baseRef === undefined || item.view.baseRef === filter.baseRef.toLowerCase())
      .filter((item) => filter.momentLocal === undefined || item.view.momentLocal === filter.momentLocal)
      .sort((a, b) => b.view.id - a.view.id).map((item) => this.present(item));
    const offset = filter.offset ?? 0;
    return { items: items.slice(offset, offset + (filter.limit ?? 50)), total: items.length };
  }

  async get(id: number, options: { includeDeleted?: boolean } = {}): Promise<StockSnapshotView> {
    return this.present(this.find(id, options.includeDeleted === true));
  }

  async rows(id: number, filter: { warehouseRefKeys?: readonly string[] } = {}): Promise<StockSnapshotRow[]> {
    const item = this.ready(id);
    if (!filter.warehouseRefKeys) return item.rows.map((row) => ({ ...row }));
    const keys = new Set(filter.warehouseRefKeys.map((key) => key.toLowerCase()));
    return item.rows.filter((row) => row.warehouseRefKey !== null && keys.has(row.warehouseRefKey)).map((row) => ({ ...row }));
  }

  async summary(id: number): Promise<StockSnapshotWarehouseSummary[]> {
    const totals = new Map<string | null, StockSnapshotWarehouseSummary>();
    for (const row of this.ready(id).rows) {
      const entry = totals.get(row.warehouseRefKey) ?? { warehouseRefKey: row.warehouseRefKey, rows: 0, quantityTotal: 0 };
      entry.rows += 1;
      entry.quantityTotal += row.quantity;
      totals.set(row.warehouseRefKey, entry);
    }
    return [...totals.values()].sort((a, b) => String(a.warehouseRefKey).localeCompare(String(b.warehouseRefKey)));
  }

  async delete(id: number, _actor: CurrentUser, _requestId: string): Promise<void> {
    const item = this.find(id, false);
    if (item.view.status === 'config_published' || item.view.status === 'syncing') {
      throw new ApiError(409, 'ONEC_STOCK_SNAPSHOT_IN_PROGRESS', 'Срез сейчас читается из 1С — удалить можно после завершения');
    }
    const at = this.now().toISOString();
    if (item.view.status === 'requested') this.move(item, 'failed', { errorCode: 'CANCELLED' });
    item.rows = [];
    item.view.deletedAt = at;
    item.view.updatedAt = at;
  }

  // ── test controls ─────────────────────────────────────────────────────────

  /** The agent started reading (`config_published` → `syncing` are one step here). */
  start(id: number): void { this.move(this.find(id, false), 'syncing'); }

  /** The snapshot is read: `rows` as 1C returned them (keys in any case). */
  complete(id: number, rows: readonly StockSnapshotRow[]): void {
    const item = this.find(id, false);
    if (rows.length > STOCK_SNAPSHOT_MAX_ROWS) { this.move(item, 'failed', { errorCode: 'TOO_MANY_ROWS' }); return; }
    const lower = (key: string | null) => (key === null ? null : key.toLowerCase());
    item.rows = rows.map((row) => ({
      organizationRefKey: lower(row.organizationRefKey), itemRefKey: row.itemRefKey.toLowerCase(), characteristicRefKey: lower(row.characteristicRefKey),
      batchRefKey: lower(row.batchRefKey), warehouseRefKey: lower(row.warehouseRefKey), cellRefKey: lower(row.cellRefKey), quantity: row.quantity,
    }));
    const at = this.now().toISOString();
    this.move(item, 'ready');
    item.view.readAt = at;
    item.view.readyAt = at;
    item.view.rowsCount = item.rows.length;
  }

  fail(id: number, errorCode: string): void { this.move(this.find(id, false), 'failed', { errorCode }); }

  /** A `requested` snapshot is waiting (the agent is offline, a window, …). */
  wait(id: number, waitReason: string | null): void {
    const item = this.find(id, false);
    item.view.waitReason = waitReason;
    item.view.updatedAt = this.now().toISOString();
  }

  /** The operator replaced the 1C base: existing snapshots become historical, active ones fail. */
  replaceBase(): void {
    for (const item of this.stored.values()) {
      if (item.view.deletedAt === null && item.view.status !== 'ready' && item.view.status !== 'failed') this.move(item, 'failed', { errorCode: 'SOURCE_GENERATION_CHANGED' });
    }
    this.generation += 1;
  }

  private move(item: Stored, status: StockSnapshotStatus, patch: { errorCode?: string } = {}): void {
    item.view.status = status;
    item.view.waitReason = null;
    item.view.errorCode = patch.errorCode ?? null;
    item.view.updatedAt = this.now().toISOString();
  }

  private find(id: number, includeDeleted: boolean): Stored {
    const item = this.stored.get(id);
    if (!item || (item.view.deletedAt !== null && !includeDeleted)) throw new ApiError(404, 'ONEC_STOCK_SNAPSHOT_NOT_FOUND', 'Срез не найден');
    return item;
  }

  private ready(id: number): Stored {
    const item = this.find(id, false);
    if (item.view.status !== 'ready') throw new ApiError(409, 'ONEC_STOCK_SNAPSHOT_NOT_READY', 'Срез ещё не готов');
    return item;
  }

  private present(item: Stored): StockSnapshotView {
    const final = item.view.status === 'ready' || item.view.status === 'failed';
    const reading = item.view.status === 'config_published' || item.view.status === 'syncing';
    const others = [...this.stored.values()].filter((other) => other !== item && other.view.deletedAt === null);
    // The waiting line: snapshots requested earlier that have not started yet; the one being read is not in it.
    const waitingAhead = others.filter((other) => other.view.status === 'requested' && other.view.id < item.view.id).length;
    const someoneReading = others.some((other) => other.view.status === 'config_published' || other.view.status === 'syncing');
    return {
      ...item.view, requestedBy: item.view.requestedBy ? { ...item.view.requestedBy } : null,
      currentSource: item.generation === this.generation,
      queuePosition: final ? null : reading ? 0 : waitingAhead + 1,
      activeAhead: !final && !reading && (waitingAhead > 0 || someoneReading),
    };
  }
}
