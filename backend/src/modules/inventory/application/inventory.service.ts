import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError } from '../../../common/errors/api-error';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { PgInventoryRepository } from '../adapters/pg-inventory-repository';
import { PgWarehouseRepository, type WarehouseSyncOptions } from '../adapters/pg-warehouse-repository';
import { OnecCatalogReader, type OnecWarehouse } from '../../onec-agent/onec-catalog-reader';
import type {
  BalancesFilter,
  CommandContext,
  CreateImportDocumentInput,
  CreateManualDocumentInput,
  CreateWarehouseInput,
  DocumentsFilter,
  OnecWarehouseOptionDto,
  UpdateLineInput,
  UpdateWarehouseInput,
  WarehouseDto,
} from './inventory.types';

/** Склад плёнки: флаг BACKEND_INVENTORY_ENABLED и буквальная проверка прав. */
@Injectable()
export class InventoryService {
  private readonly repository: PgInventoryRepository;
  private readonly warehouses: PgWarehouseRepository;

  constructor(
    @Inject(DatabaseService) database: DatabaseService,
    @Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>,
    @Inject(OnecCatalogReader) private readonly onec: OnecCatalogReader,
  ) {
    this.repository = new PgInventoryRepository(database);
    this.warehouses = new PgWarehouseRepository(database);
  }

  enabled(): boolean {
    return this.config.get('BACKEND_INVENTORY_ENABLED', { infer: true }) === true;
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

  listDocuments(user: CurrentUser, filter: DocumentsFilter) {
    this.require(user, 'inventory.view');
    return this.repository.listDocuments(user, filter);
  }

  getDocument(user: CurrentUser, documentId: number) {
    this.require(user, 'inventory.view');
    return this.repository.getDocument(user, documentId);
  }

  createManual(ctx: CommandContext, input: CreateManualDocumentInput) {
    this.require(ctx.currentUser, 'inventory.manage');
    return this.repository.createManual(ctx, input);
  }

  createImport(ctx: CommandContext, input: CreateImportDocumentInput) {
    this.require(ctx.currentUser, 'inventory.manage');
    return this.repository.createImport(ctx, input);
  }

  updateLine(ctx: CommandContext, input: UpdateLineInput) {
    this.require(ctx.currentUser, 'inventory.manage');
    return this.repository.updateLine(ctx, input);
  }

  post(ctx: CommandContext, documentId: number, version: number, allowNegative: boolean) {
    this.require(ctx.currentUser, 'inventory.manage');
    return this.repository.post(ctx, documentId, version, allowNegative);
  }

  cancel(ctx: CommandContext, documentId: number, version: number) {
    this.require(ctx.currentUser, 'inventory.manage');
    return this.repository.cancel(ctx, documentId, version);
  }

  orderFilmStock(user: CurrentUser, orderId: number) {
    this.require(user, 'inventory.view');
    return this.repository.orderFilmStock(user, orderId);
  }
}
