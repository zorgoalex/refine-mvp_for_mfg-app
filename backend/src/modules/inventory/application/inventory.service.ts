import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError } from '../../../common/errors/api-error';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { PgInventoryRepository } from '../adapters/pg-inventory-repository';
import { PgWarehouseRepository } from '../adapters/pg-warehouse-repository';
import type {
  BalancesFilter,
  CommandContext,
  CreateImportDocumentInput,
  CreateManualDocumentInput,
  CreateWarehouseInput,
  DocumentsFilter,
  UpdateLineInput,
  UpdateWarehouseInput,
} from './inventory.types';

/** Склад плёнки: флаг BACKEND_INVENTORY_ENABLED и буквальная проверка прав. */
@Injectable()
export class InventoryService {
  private readonly repository: PgInventoryRepository;
  private readonly warehouses: PgWarehouseRepository;

  constructor(
    @Inject(DatabaseService) database: DatabaseService,
    @Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>,
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

  listWarehouses(user: CurrentUser, includeInactive = false) {
    this.require(user, 'inventory.view');
    return this.warehouses.list(includeInactive);
  }

  createWarehouse(ctx: CommandContext, input: CreateWarehouseInput) {
    this.require(ctx.currentUser, 'inventory.manage');
    return this.warehouses.create(ctx, input);
  }

  updateWarehouse(ctx: CommandContext, input: UpdateWarehouseInput) {
    this.require(ctx.currentUser, 'inventory.manage');
    return this.warehouses.update(ctx, input);
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
