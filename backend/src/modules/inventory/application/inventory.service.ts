import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError } from '../../../common/errors/api-error';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { PgInventoryRepository } from '../adapters/pg-inventory-repository';
import { PgWarehouseRepository, type WarehouseSyncOptions } from '../adapters/pg-warehouse-repository';
import { PgWarehouseStockRepository } from '../adapters/pg-warehouse-stock-repository';
import { buildWarehouseStockView } from '../domain/warehouse-stock-view';
import { OnecCatalogReader, type OnecStockBalance, type OnecStockState, type OnecWarehouse } from '../../onec-agent/onec-catalog-reader';
import type {
  BalancesFilter,
  CommandContext,
  CreateImportDocumentInput,
  CreateManualDocumentInput,
  CreateWarehouseInput,
  DocumentsFilter,
  OnecWarehouseOptionDto,
  UpdateLineInput,
  OnecStockUnavailableReason,
  OrderSheetStockDto,
  UpdateWarehouseInput,
  WarehouseDto,
  WarehouseStockDto,
  WarehouseStockFilter,
} from './inventory.types';
import { aggregateSheetReadings, buildOrderSheetStock, type WarehouseStockReading } from '../domain/order-sheet-stock';

/** Склад плёнки: флаг BACKEND_INVENTORY_ENABLED и буквальная проверка прав. */
@Injectable()
export class InventoryService {
  private readonly repository: PgInventoryRepository;
  private readonly warehouses: PgWarehouseRepository;
  private readonly stock = new PgWarehouseStockRepository();

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>,
    @Inject(OnecCatalogReader) private readonly onec: OnecCatalogReader,
  ) {
    this.repository = new PgInventoryRepository(database);
    this.warehouses = new PgWarehouseRepository(database);
  }

  enabled(): boolean {
    return this.config.get('BACKEND_INVENTORY_ENABLED', { infer: true }) === true;
  }

  /** Сигнал проекции расхода 1С: изменились входы (дата начала склада, проведённая инвентаризация). */
  private readonly projectionListeners = new Set<(reason: string) => void>();

  onProjectionInputsChanged(listener: (reason: string) => void): () => void {
    this.projectionListeners.add(listener);
    return () => this.projectionListeners.delete(listener);
  }

  private notifyProjection(reason: string): void {
    for (const listener of this.projectionListeners) {
      try { listener(reason); } catch { /* сигнал не должен ломать команду */ }
    }
  }

  private require(user: CurrentUser, permission: 'inventory.view' | 'inventory.manage'): void {
    if (!this.enabled()) throw new ApiError(404, 'NOT_FOUND', 'Склад выключен');
    if (!user.permissions.includes(permission)) {
      throw new ApiError(403, 'FORBIDDEN', 'Недостаточно прав', { requiredPermissions: [permission] });
    }
  }

  /** Склады 1С из зеркала; null — зеркало недоступно или складов в нём нет (ручной режим ключей). */
  private async onecWarehouses(client?: DatabaseClient): Promise<OnecWarehouse[] | null> {
    try {
      const rows = await this.onec.listWarehouses(client);
      return rows.length > 0 ? rows : null;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ONEC_MIRROR_UNAVAILABLE') return null;
      throw error;
    }
  }

  /**
   * Склады 1С для синхронизации: под `entity_state FOR SHARE` источников (до commit
   * синхронизации выгрузка, отзыв и rebaseline не меняют прочитанную копию). null — как у onecWarehouses.
   */
  async lockedOnecWarehouses(tx: DatabaseClient, sourceIds?: readonly number[]): Promise<OnecWarehouse[] | null> {
    try {
      const rows = await this.onec.lockAndListWarehouses(tx, sourceIds);
      return rows.length > 0 ? rows : null;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ONEC_MIRROR_UNAVAILABLE') return null;
      throw error;
    }
  }

  /** Для автозапуска: та же синхронизация без проверки прав пользователя (исполнитель — служебный). */
  syncWarehousesAsService(ctx: CommandContext, sourceId: number, options: WarehouseSyncOptions) {
    return this.warehouses.syncFromOnec(
      ctx,
      async (tx) => ((await this.lockedOnecWarehouses(tx, [sourceId])) ?? []).map((row) => ({ refKey: row.refKey, name: row.name })),
      options,
    );
  }

  private withOnec(dto: WarehouseDto, onec: OnecWarehouse[] | null): WarehouseDto {
    if (!dto.refKey1c) return { ...dto, onecStatus: 'unlinked', onecName: null, onecCode: null };
    if (onec === null) return { ...dto, onecStatus: 'unknown', onecName: null, onecCode: null };
    const match = onec.find((row) => row.refKey === dto.refKey1c!.toLowerCase());
    return match
      ? { ...dto, onecStatus: 'linked', onecName: match.name, onecCode: match.code }
      : { ...dto, onecStatus: 'missing', onecName: null, onecCode: null };
  }

  /** Ключ 1С обязан быть складом из зеркала (если зеркало доступно); без зеркала — только формат и уникальность. */
  private async assertOnecWarehouse(refKey: string, onec: OnecWarehouse[] | null): Promise<void> {
    if (onec !== null && !onec.some((row) => row.refKey === refKey)) {
      throw new ApiError(422, 'WAREHOUSE_1C_NOT_FOUND', 'Склад 1С с таким ключом не найден в данных 1С');
    }
  }

  async listWarehouses(user: CurrentUser, includeInactive = false) {
    this.require(user, 'inventory.view');
    const [rows, onec] = await Promise.all([this.warehouses.list(includeInactive), this.onecWarehouses()]);
    return rows.map((row) => this.withOnec(row, onec));
  }

  /** Склады 1С для выбора: к какому складу ERP уже привязан каждый. */
  async listOnecWarehouses(user: CurrentUser): Promise<{ available: boolean; items: OnecWarehouseOptionDto[] }> {
    this.require(user, 'inventory.manage');
    const [onec, rows] = await Promise.all([this.onecWarehouses(), this.warehouses.list(true)]);
    if (onec === null) return { available: false, items: [] };
    const linked = new Map(rows.flatMap((row) => (row.refKey1c ? [[row.refKey1c.toLowerCase(), row] as const] : [])));
    return {
      available: true,
      items: onec.map((row) => ({
        refKey: row.refKey, code: row.code, name: row.name,
        linkedWarehouseId: linked.get(row.refKey)?.warehouseId ?? null,
        linkedWarehouseName: linked.get(row.refKey)?.name ?? null,
      })),
    };
  }

  /**
   * Зеркало 1С читается один раз на команду и только при необходимости; внутри транзакции —
   * через её клиент (второе соединение пула при занятом пуле = ожидание до таймаута).
   */
  private onecLoader() {
    let cached: Promise<OnecWarehouse[] | null> | undefined;
    return (client?: DatabaseClient) => (cached ??= this.onecWarehouses(client));
  }

  async createWarehouse(ctx: CommandContext, input: CreateWarehouseInput) {
    this.require(ctx.currentUser, 'inventory.manage');
    const refKey1c = input.refKey1c.toLowerCase();
    const onec = this.onecLoader();
    const created = await this.warehouses.create(ctx, { ...input, refKey1c }, async (tx, key) => this.assertOnecWarehouse(key, await onec(tx)));
    return this.withOnec(created, await onec());
  }

  async updateWarehouse(ctx: CommandContext, input: UpdateWarehouseInput) {
    this.require(ctx.currentUser, 'inventory.manage');
    const refKey1c = input.refKey1c?.toLowerCase();
    const onec = this.onecLoader();
    const updated = await this.warehouses.update(
      ctx,
      { ...input, ...(refKey1c !== undefined ? { refKey1c } : {}) },
      async (tx, key) => this.assertOnecWarehouse(key, await onec(tx)),
    );
    if (input.onecConsumptionSince !== undefined) this.notifyProjection('since');
    return this.withOnec(updated, await onec());
  }

  /** Создать/привязать склады ERP по всем складам 1С (зеркало обязательно для нового выполнения). */
  async syncWarehousesFromOnec(ctx: CommandContext) {
    this.require(ctx.currentUser, 'inventory.manage');
    const result = await this.warehouses.syncFromOnec(ctx, async (tx) => {
      const rows = await this.lockedOnecWarehouses(tx);
      if (rows === null) throw new ApiError(409, 'ONEC_MIRROR_UNAVAILABLE', 'Данные 1С о складах недоступны');
      return rows.map((row) => ({ refKey: row.refKey, name: row.name }));
    });
    const current = await this.onecWarehouses();
    return {
      ...result,
      created: result.created.map((row) => this.withOnec(row, current)),
      linked: result.linked.map((row) => this.withOnec(row, current)),
    };
  }

  listBalances(user: CurrentUser, filter: BalancesFilter) {
    this.require(user, 'inventory.view');
    return this.repository.listBalances(filter);
  }

  /**
   * «Остатки на складах»: плёнка — учёт ERP, прочие материалы — остатки 1С (только чтение).
   * Склад, учёт ERP, источник 1С, состояние снимка и строки зеркала — одна транзакция
   * REPEATABLE READ READ ONLY (снимок остатков 1С применяется одной транзакцией: строки + состояние).
   */
  async warehouseStock(user: CurrentUser, filter: WarehouseStockFilter): Promise<WarehouseStockDto> {
    this.require(user, 'inventory.view');
    return this.database.transaction(async (tx) => {
      await tx.query('SET TRANSACTION READ ONLY');
      const warehouse = await this.stock.warehouse(tx, filter.warehouseId);
      if (!warehouse) throw new ApiError(404, 'WAREHOUSE_NOT_FOUND', 'Склад не найден');
      const filmRows = await this.stock.filmBalances(tx, warehouse.warehouseId);
      const onec = await this.onecStock(tx, warehouse.refKey1c);
      const { links, materialTypeNames } = onec.sourceId === null
        ? { links: { filmKeys: new Set<string>(), sheetByKey: new Map(), hiddenMaterialTypeIds: new Set<number>(), filmCatalogItemKeys: new Set<string>() }, materialTypeNames: new Map<number, string>() }
        : await this.stock.links(tx, onec.sourceId, onec.rows.map((row) => row.itemRefKey));
      const view = buildWarehouseStockView({ filmRows, onecRows: onec.rows, links, materialTypeNames, filter });
      return {
        warehouseId: warehouse.warehouseId,
        warehouseName: warehouse.name,
        onec: {
          available: onec.reason === null,
          reason: onec.reason,
          onecWarehouseName: onec.warehouseName,
          snapshotVersion: onec.state?.snapshotVersion ?? null,
          rejectedReason: onec.state?.rejectedReason ?? null,
          completeness: onec.state?.completeness ?? null,
          directoriesRevoked: Boolean(onec.state && (onec.state.revoked.items || onec.state.revoked.units || onec.state.revoked.itemCategories)),
        },
        ...view,
      };
    }, { isolation: 'repeatable read' });
  }

  /** Остатки 1С склада из единственного источника с этим ключом; причина, если недоступны. */
  async onecStock(tx: DatabaseClient, refKey1c: string | null): Promise<{
    reason: OnecStockUnavailableReason | null; sourceId: number | null; warehouseName: string | null;
    state: OnecStockState | null; rows: OnecStockBalance[];
  }> {
    const none = (reason: OnecStockUnavailableReason, extra: Partial<{ sourceId: number; warehouseName: string; state: OnecStockState }> = {}) =>
      ({ reason, sourceId: null, warehouseName: extra.warehouseName ?? null, state: extra.state ?? null, rows: [] });
    if (!refKey1c) return none('warehouse_unlinked');
    try {
      const matches = (await this.onec.listWarehouses(tx)).filter((row) => row.refKey === refKey1c);
      if (matches.length === 0) return none('warehouse_not_in_onec');
      if (new Set(matches.map((row) => row.sourceId)).size > 1) return none('ambiguous_source');
      const [{ sourceId, name }] = matches;
      const state = await this.onec.stockState(sourceId, tx);
      if (state.revoked.stockBalances) return none('revoked', { warehouseName: name, state });
      if (!state.loaded) return none('not_loaded', { warehouseName: name, state });
      const rows = await this.onec.stockBalances(sourceId, refKey1c, state.revoked, tx);
      return { reason: null, sourceId, warehouseName: name, state, rows };
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ONEC_MIRROR_UNAVAILABLE') return none('onec_disabled');
      throw error;
    }
  }

  listDocuments(user: CurrentUser, filter: DocumentsFilter) {
    this.require(user, 'inventory.view');
    return this.repository.listDocuments(user, filter);
  }

  getDocument(user: CurrentUser, documentId: number) {
    this.require(user, 'inventory.view');
    return this.repository.getDocument(user, documentId);
  }

  async createManual(ctx: CommandContext, input: CreateManualDocumentInput) {
    this.require(ctx.currentUser, 'inventory.manage');
    const document = await this.repository.createManual(ctx, input);
    if (document.docType === 'inventory' && document.status === 'posted') this.notifyProjection('inventory');
    return document;
  }

  createImport(ctx: CommandContext, input: CreateImportDocumentInput) {
    this.require(ctx.currentUser, 'inventory.manage');
    return this.repository.createImport(ctx, input);
  }

  updateLine(ctx: CommandContext, input: UpdateLineInput) {
    this.require(ctx.currentUser, 'inventory.manage');
    return this.repository.updateLine(ctx, input);
  }

  async post(ctx: CommandContext, documentId: number, version: number, allowNegative: boolean) {
    this.require(ctx.currentUser, 'inventory.manage');
    const document = await this.repository.post(ctx, documentId, version, allowNegative);
    if (document.docType === 'inventory' && document.status === 'posted') this.notifyProjection('inventory');
    return document;
  }

  cancel(ctx: CommandContext, documentId: number, version: number) {
    this.require(ctx.currentUser, 'inventory.manage');
    return this.repository.cancel(ctx, documentId, version);
  }

  /**
   * Остатки листовых материалов заказа по данным 1С: остаток позиции 1С, к которой привязан материал, по всем активным
   * складам ERP с ключом 1С (каждый — из своего единственного источника, как «Остатки на складах»), против потребности
   * заказа в м². Одна транзакция REPEATABLE READ READ ONLY (снимок 1С согласован).
   */
  async orderSheetStock(user: CurrentUser, orderId: number): Promise<OrderSheetStockDto> {
    this.require(user, 'inventory.view');
    return this.database.transaction(async (tx) => {
      await tx.query('SET TRANSACTION READ ONLY');
      const sheets = await this.repository.orderSheetDemand(user, orderId, tx);
      const keys = new Set(sheets.map((sheet) => sheet.refKey1c).filter((key): key is string => key !== null));
      const readings: WarehouseStockReading[] = [];
      if (keys.size > 0) {
        const warehouses = (await tx.query<{ warehouse_id: number; warehouse_name: string; ref_key_1c: string }>(
          `SELECT warehouse_id, warehouse_name, lower(ref_key_1c::text) AS ref_key_1c FROM warehouses
            WHERE is_active AND ref_key_1c IS NOT NULL ORDER BY warehouse_id`,
        )).rows;
        for (const warehouse of warehouses) {
          const onec = await this.onecStock(tx, warehouse.ref_key_1c);
          readings.push({
            warehouseId: Number(warehouse.warehouse_id), name: warehouse.warehouse_name, reason: onec.reason,
            snapshotVersion: onec.state?.snapshotVersion ?? null, rows: onec.rows,
          });
        }
      }
      // Неполные данные (часть складов без остатков 1С) не выдаются за итог: покрытие — `incomplete`, склады — в ответе.
      const { balances, available, incomplete, snapshotVersion } = aggregateSheetReadings(readings, keys);
      return {
        items: buildOrderSheetStock({ sheets, onecAvailable: available, incomplete: available && incomplete.length > 0, balances }),
        incompleteWarehouses: incomplete,
        snapshotVersion,
      };
    }, { isolation: 'repeatable read' });
  }

  orderFilmStock(user: CurrentUser, orderId: number) {
    this.require(user, 'inventory.view');
    return this.repository.orderFilmStock(user, orderId);
  }
}
