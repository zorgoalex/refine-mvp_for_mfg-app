import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { ITEMS_INFO_MAX_KEYS, OnecCatalogReader } from '../../onec-agent/onec-catalog-reader';
import { PgWarehouseStockRepository } from '../adapters/pg-warehouse-stock-repository';
import {
  aggregateSnapshotRows, buildSnapshotStockView, type SnapshotItemInfo, type SnapshotStockView, type SnapshotViewFilter,
} from '../domain/onec-snapshot-view';
import { InventoryService } from './inventory.service';
import type { OnecStockUnavailableReason } from './inventory.types';
import {
  ONEC_STOCK_SNAPSHOTS,
  type OnecStockSnapshotsPort, type StockSnapshotCapabilities, type StockSnapshotStatus, type StockSnapshotView,
} from './onec-snapshots.port';

export type SnapshotDto = Omit<StockSnapshotView, 'deletedAt'>;

export interface SnapshotWarehouseDto {
  /** Ключ склада 1С (нижний регистр); null — строки регистра без склада. */
  warehouseRefKey: string | null;
  /** Склад ERP с этим ключом; null — склад 1С не заведён в ERP. */
  warehouseId: number | null;
  name: string | null;
  rows: number;
  quantityTotal: number;
}

export interface SnapshotStockFilter extends SnapshotViewFilter {
  /** Склады ERP; пусто — все склады среза (включая склады 1С без пары в ERP). */
  warehouseIds: readonly number[];
}

export interface SnapshotStockDto extends SnapshotStockView {
  snapshot: SnapshotDto;
  warehouses: Array<{ warehouseId: number; name: string }>;
  /** Сравнение: вторая сторона; без сравнения — null. */
  other: { kind: 'current'; asOf: string | null } | { kind: 'snapshot'; snapshot: SnapshotDto } | null;
}

export interface SnapshotCommandContext { currentUser: CurrentUser; requestId: string; idempotencyKey: string }

const plain = (rows: ReadonlyArray<{ warehouseId: number; name: string }> | null): Array<{ warehouseId: number; name: string }> =>
  (rows ?? []).map((row) => ({ warehouseId: row.warehouseId, name: row.name }));

/** Размер страницы при переборе срезов порта. */
const PORT_PAGE = 200;
/** `2026-09-26T10:14:00` → `26.09.2026 10:14` — как момент показан на экране (для поиска). */
const momentLabel = (momentLocal: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(momentLocal);
  return match ? `${match[3]}.${match[2]}.${match[1]} ${match[4]}:${match[5]}` : momentLocal;
};

const dto = (view: StockSnapshotView): SnapshotDto => {
  const { deletedAt: _deletedAt, ...rest } = view;
  return rest;
};

/**
 * Срезы остатков 1С на дату — часть склада (план 2026-10-08-onec-stock-snapshots-inventory-plan.md, этап 1): права,
 * сопоставление складов и позиций, просмотр и сравнение. Только чтение складских данных; запрос и удаление среза
 * выполняет и аудирует порт-владелец (onec-agent). Каждое чтение — одна транзакция REPEATABLE READ READ ONLY.
 */
@Injectable()
export class InventoryOnecSnapshotsService {
  private readonly stock = new PgWarehouseStockRepository();

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(OnecCatalogReader) private readonly onec: OnecCatalogReader,
    @Inject(ONEC_STOCK_SNAPSHOTS) private readonly port: OnecStockSnapshotsPort,
  ) {}

  /** Склад выключен → 404 раньше любой проверки запроса (контроллер вызывает до разбора параметров). */
  assertEnabled(): void { this.requireEnabled(); }

  private requireEnabled(): void {
    if (this.config.get('BACKEND_INVENTORY_ENABLED', { infer: true }) !== true) throw new ApiError(404, 'NOT_FOUND', 'Склад выключен');
  }

  private requireView(user: CurrentUser): void {
    this.requireEnabled();
    if (!user.permissions.includes('inventory.view')) {
      throw new ApiError(403, 'FORBIDDEN', 'Недостаточно прав', { requiredPermissions: ['inventory.view'] });
    }
  }

  /** Право на команду; отказ записывается в аудит ДО ответа, порт при отказе не вызывается. */
  private async requireManage(ctx: SnapshotCommandContext, action: 'request' | 'delete', target: { snapshotId?: number; momentLocal?: string }): Promise<void> {
    this.requireEnabled();
    if (ctx.currentUser.permissions.includes('inventory.manage')) return;
    await this.database.transaction((tx) => auditService.record(tx, {
      event: 'inventory.onec_snapshot_command_denied',
      // Отказ в запросе нового среза: среза ещё нет — сущность «запрос», идентификатор — requestId.
      entityType: target.snapshotId === undefined ? 'onec_stock_snapshot_request' : 'onec_stock_snapshot',
      entityId: target.snapshotId ?? ctx.requestId,
      actorUserId: ctx.currentUser.id,
      actorUsername: ctx.currentUser.username ?? null,
      actorRole: ctx.currentUser.role ?? null,
      requestId: ctx.requestId,
      source: 'inventory',
      statusField: 'status',
      statusCode: 'denied',
      stageCode: 'onec_snapshot',
      metadata: { action, requiredPermission: 'inventory.manage', momentLocal: target.momentLocal ?? null, correlationId: ctx.requestId },
      relatedEntities: target.snapshotId === undefined ? [] : [{ entityType: 'onec_stock_snapshot', entityId: target.snapshotId }],
    }));
    throw new ApiError(403, 'FORBIDDEN', 'Недостаточно прав', { requiredPermissions: ['inventory.manage'] });
  }

  private read<T>(run: (tx: DatabaseClient) => Promise<T>): Promise<T> {
    return this.database.transaction(async (tx) => {
      await tx.query('SET TRANSACTION READ ONLY');
      return run(tx);
    }, { isolation: 'repeatable read' });
  }

  async list(user: CurrentUser, filter: { status: StockSnapshotStatus | null; offset: number; limit: number }): Promise<StockSnapshotCapabilities & { items: SnapshotDto[]; total: number }> {
    this.requireView(user);
    return this.read(async (tx) => {
      const capabilities = await this.port.capabilities(undefined, tx);
      if (!capabilities.readAvailable) return { ...capabilities, items: [], total: 0 };
      const page = await this.port.list({ status: filter.status ?? undefined, offset: filter.offset, limit: filter.limit }, tx);
      return { ...capabilities, items: page.items.map(dto), total: page.total };
    });
  }

  async request(ctx: SnapshotCommandContext, input: { momentLocal: string; force: boolean }): Promise<SnapshotDto> {
    await this.requireManage(ctx, 'request', { momentLocal: input.momentLocal });
    return dto(await this.port.request({ momentLocal: input.momentLocal, force: input.force, idempotencyKey: ctx.idempotencyKey }, ctx.currentUser, ctx.requestId));
  }

  async remove(ctx: SnapshotCommandContext, snapshotId: number): Promise<void> {
    await this.requireManage(ctx, 'delete', { snapshotId });
    await this.port.delete(snapshotId, ctx.currentUser, ctx.requestId);
  }

  /** Карточка среза: заголовок и сводка по складам, сопоставленная со складами ERP по ключу 1С. */
  async card(user: CurrentUser, snapshotId: number): Promise<{ snapshot: SnapshotDto; warehouses: SnapshotWarehouseDto[] }> {
    this.requireView(user);
    return this.read(async (tx) => {
      const view = await this.port.get(snapshotId, {}, tx);
      if (view.status !== 'ready') return { snapshot: dto(view), warehouses: [] };
      const summary = await this.port.summary(snapshotId, tx);
      const erp = new Map((await this.stock.warehousesWithOnecKey(tx)).map((row) => [row.refKey1c, row]));
      const onecNames = await this.onecWarehouseNames(tx, view.sourceId);
      const warehouses = summary.map((row) => {
        const key = row.warehouseRefKey?.toLowerCase() ?? null;
        const own = key ? erp.get(key) : undefined;
        return {
          warehouseRefKey: key, warehouseId: own?.warehouseId ?? null, name: own?.name ?? (key ? onecNames.get(key) ?? null : null),
          rows: row.rows, quantityTotal: row.quantityTotal,
        };
      }).sort((a, b) => Number(a.warehouseId === null) - Number(b.warehouseId === null) || (a.name ?? '').localeCompare(b.name ?? '', 'ru'));
      return { snapshot: dto(view), warehouses };
    });
  }

  /**
   * Срезы, с которыми можно сравнить данный: готовые, той же базы 1С (`sourceId` + `baseRef`), кроме него самого.
   * Базу фильтрует порт (`baseRef`) до пагинации: исторические срезы находятся и тогда, когда новее их накопились
   * сотни срезов другой базы. Без поиска страница берётся у порта напрямую; `search` — по номеру или дате
   * (`ДД.ММ.ГГГГ ЧЧ:ММ`) — перебором срезов этой базы в той же транзакции.
   */
  async comparable(user: CurrentUser, snapshotId: number, filter: { search: string | null; offset: number; limit: number }): Promise<{ items: SnapshotDto[]; total: number }> {
    this.requireView(user);
    return this.read(async (tx) => {
      const base = await this.port.get(snapshotId, {}, tx);
      const needle = filter.search?.toLocaleLowerCase('ru') ?? '';
      const matched: StockSnapshotView[] = [];
      // Сам срез входит в выборку порта (он той же базы и готов) — исключается здесь; порядок — от новых.
      for (let offset = 0; ; offset += PORT_PAGE) {
        const page = await this.port.list({ sourceId: base.sourceId, baseRef: base.baseRef, status: 'ready', offset, limit: PORT_PAGE }, tx);
        for (const item of page.items) {
          if (item.id === base.id || item.baseRef !== base.baseRef) continue;
          if (needle && !`№ ${item.id} ${momentLabel(item.momentLocal)}`.toLocaleLowerCase('ru').includes(needle)) continue;
          matched.push(item);
        }
        // Без поиска достаточно срезов до конца запрошенной страницы; число всех — из ответа порта.
        if (!needle && matched.length >= filter.offset + filter.limit) {
          return { items: matched.slice(filter.offset, filter.offset + filter.limit).map(dto), total: page.total - (base.status === 'ready' ? 1 : 0) };
        }
        if (page.items.length === 0 || offset + page.items.length >= page.total) break;
      }
      return { items: matched.slice(filter.offset, filter.offset + filter.limit).map(dto), total: matched.length };
    });
  }

  /** Остатки среза по складу/складам — те же вкладки материалов, что у текущих остатков 1С. */
  async stockOf(user: CurrentUser, snapshotId: number, filter: SnapshotStockFilter): Promise<SnapshotStockDto> {
    this.requireView(user);
    return this.read(async (tx) => {
      const view = await this.readySnapshot(tx, snapshotId);
      const selected = await this.selectedWarehouses(tx, filter.warehouseIds);
      const rows = await this.port.rows(snapshotId, selected ? { warehouseRefKeys: selected.map((row) => row.refKey1c) } : undefined, tx);
      const quantities = aggregateSnapshotRows(rows);
      return { ...(await this.present(tx, view.sourceId, quantities, null, filter)), snapshot: dto(view), warehouses: plain(selected), other: null };
    });
  }

  /**
   * Сравнение среза A с текущими остатками 1С или со срезом B. Разница — B − A. С текущими остатками сравнивается
   * только срез текущей базы 1С; два среза — только одной базы (`baseRef`), в том числе оба исторические.
   * Недоступные текущие остатки — отказ с причинами, а не нули.
   */
  async compare(user: CurrentUser, snapshotId: number, other: 'current' | number, filter: SnapshotStockFilter): Promise<SnapshotStockDto> {
    this.requireView(user);
    return this.read(async (tx) => {
      const a = await this.readySnapshot(tx, snapshotId);
      if (other === 'current') {
        if (!a.currentSource) throw historical();
        // Текущие остатки читаются по складам ERP: без выбора — все активные склады ERP с ключом 1С.
        const selected = await this.selectedWarehouses(tx, filter.warehouseIds)
          ?? (await this.stock.warehousesWithOnecKey(tx)).filter((row) => row.isActive);
        if (selected.length === 0) throw new ApiError(409, 'ONEC_SNAPSHOT_COMPARE_UNAVAILABLE', 'Нет складов ERP, связанных с 1С', { warehouses: [] });
        const failures: Array<{ warehouseId: number; name: string; reason: OnecStockUnavailableReason | 'other_source' }> = [];
        const current: Array<{ itemRefKey: string; quantity: number }> = [];
        let asOf: string | null = null;
        for (const warehouse of selected) {
          const stock = await this.inventory.onecStock(tx, warehouse.refKey1c);
          if (stock.reason !== null) failures.push({ warehouseId: warehouse.warehouseId, name: warehouse.name, reason: stock.reason });
          else if (stock.sourceId !== a.sourceId) failures.push({ warehouseId: warehouse.warehouseId, name: warehouse.name, reason: 'other_source' });
          else {
            current.push(...stock.rows);
            asOf = stock.state?.snapshotVersion ?? asOf;
          }
        }
        if (failures.length > 0) {
          throw new ApiError(409, 'ONEC_SNAPSHOT_COMPARE_UNAVAILABLE', 'Текущие остатки 1С доступны не по всем выбранным складам', { warehouses: failures });
        }
        const rows = await this.port.rows(snapshotId, { warehouseRefKeys: selected.map((row) => row.refKey1c) }, tx);
        const presented = await this.present(tx, a.sourceId, aggregateSnapshotRows(rows), aggregateSnapshotRows(current), filter);
        return { ...presented, snapshot: dto(a), warehouses: plain(selected), other: { kind: 'current', asOf } };
      }
      if (other === snapshotId) throw new ApiError(400, 'VALIDATION_FAILED', 'Срез сравнивается сам с собой', { field: 'with' });
      const b = await this.readySnapshot(tx, other);
      if (b.sourceId !== a.sourceId || b.baseRef !== a.baseRef) throw new ApiError(409, 'ONEC_SNAPSHOT_SOURCE_MISMATCH', 'Срезы разных баз 1С не сравниваются');
      const selected = await this.selectedWarehouses(tx, filter.warehouseIds);
      const keys = selected ? { warehouseRefKeys: selected.map((row) => row.refKey1c) } : undefined;
      const presented = await this.present(tx, a.sourceId,
        aggregateSnapshotRows(await this.port.rows(snapshotId, keys, tx)), aggregateSnapshotRows(await this.port.rows(other, keys, tx)), filter);
      return { ...presented, snapshot: dto(a), warehouses: plain(selected), other: { kind: 'snapshot', snapshot: dto(b) } };
    });
  }

  private async readySnapshot(tx: DatabaseClient, snapshotId: number): Promise<StockSnapshotView> {
    const view = await this.port.get(snapshotId, {}, tx);
    if (view.status !== 'ready') throw new ApiError(409, 'ONEC_STOCK_SNAPSHOT_NOT_READY', 'Срез ещё не готов');
    return view;
  }

  /** Выбранные склады ERP → ключи 1С; null — без выбора (все склады среза). */
  private async selectedWarehouses(tx: DatabaseClient, warehouseIds: readonly number[]): Promise<Array<{ warehouseId: number; name: string; refKey1c: string }> | null> {
    if (warehouseIds.length === 0) return null;
    const result: Array<{ warehouseId: number; name: string; refKey1c: string }> = [];
    for (const warehouseId of [...new Set(warehouseIds)].sort((x, y) => x - y)) {
      const warehouse = await this.stock.warehouse(tx, warehouseId);
      if (!warehouse) throw new ApiError(404, 'WAREHOUSE_NOT_FOUND', 'Склад не найден', { warehouseId });
      if (!warehouse.refKey1c) throw new ApiError(409, 'WAREHOUSE_UNLINKED', 'Склад не связан со складом 1С', { warehouseId });
      result.push({ warehouseId: warehouse.warehouseId, name: warehouse.name, refKey1c: warehouse.refKey1c });
    }
    return result;
  }

  private async present(
    tx: DatabaseClient, sourceId: number, quantities: Map<string, number>, other: Map<string, number> | null, filter: SnapshotViewFilter,
  ): Promise<SnapshotStockView> {
    const keys = [...new Set([...quantities.keys(), ...(other?.keys() ?? [])])].filter((key) => /^[0-9a-f-]{36}$/.test(key));
    const { links, materialTypeNames } = await this.stock.links(tx, sourceId, keys);
    const info = await this.itemsInfo(tx, sourceId, keys);
    return buildSnapshotStockView({ quantities, other, info, links, materialTypeNames, filter });
  }

  /** Код, название, единица и категория позиций из текущего зеркала номенклатуры; зеркало недоступно — без названий. */
  private async itemsInfo(tx: DatabaseClient, sourceId: number, keys: readonly string[]): Promise<Map<string, SnapshotItemInfo>> {
    try {
      const state = await this.onec.stockState(sourceId, tx);
      const info = new Map<string, SnapshotItemInfo>();
      // Сравнение объединяет позиции двух сторон (до двух лимитов среза) — reader принимает ограниченную порцию ключей.
      for (let offset = 0; offset < keys.length; offset += ITEMS_INFO_MAX_KEYS) {
        for (const item of await this.onec.itemsInfo(sourceId, keys.slice(offset, offset + ITEMS_INFO_MAX_KEYS), state.revoked, tx)) {
          info.set(item.itemRefKey, { code: item.code, name: item.name, unitName: item.unitName, categoryKey: item.categoryKey, categoryName: item.categoryName });
        }
      }
      return info;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ONEC_MIRROR_UNAVAILABLE') return new Map();
      throw error;
    }
  }

  private async onecWarehouseNames(tx: DatabaseClient, sourceId: number): Promise<Map<string, string>> {
    try {
      return new Map((await this.onec.listWarehouses(tx)).filter((row) => row.sourceId === sourceId).map((row) => [row.refKey.toLowerCase(), row.name]));
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ONEC_MIRROR_UNAVAILABLE') return new Map();
      throw error;
    }
  }
}

const historical = (): ApiError => new ApiError(409, 'ONEC_SNAPSHOT_HISTORICAL',
  'Срез снят с прежней базы 1С — с текущими остатками он не сравнивается');
