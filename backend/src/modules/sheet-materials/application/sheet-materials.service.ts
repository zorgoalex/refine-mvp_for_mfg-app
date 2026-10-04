import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  CreateSheetMaterialTypeCommand,
  DeactivateSheetMaterialTypeCommand,
  GetSheetMaterialTypeQuery,
  ListSheetMaterialTypesQuery,
  OnecItemOptionDto,
  OnecItemsSource,
  SheetMaterialsPort,
  SheetMaterialTypeDto,
  UpdateSheetMaterialTypeCommand,
} from './sheet-materials.types';

export interface SheetMaterialsServicePorts {
  repo: SheetMaterialsPort;
  permissions?: PermissionsService;
  /** Позиции номенклатуры 1С (копия данных); не задан — выбора нет, ключ вводится вручную. */
  onecItems?: OnecItemsSource;
}

const VIEW: PermissionName = 'sheet_materials.view';
const MANAGE: PermissionName = 'sheet_materials.manage';

/**
 * RBAC enforcement for sheet-material-type commands. Reads require
 * sheet_materials.view, writes require sheet_materials.manage. Permission-denied
 * attempts are audited best-effort via the port (recordPermissionDenied) — the
 * service never injects DatabaseService/AuditService directly.
 */
export class SheetMaterialsService {
  private readonly repo: SheetMaterialsPort;
  private readonly permissions: PermissionsService;
  private readonly onecItemsSource: OnecItemsSource | undefined;

  constructor(ports: SheetMaterialsServicePorts) {
    this.repo = ports.repo;
    this.permissions = ports.permissions ?? new PermissionsService();
    this.onecItemsSource = ports.onecItems;
  }

  async list(query: ListSheetMaterialTypesQuery): Promise<SheetMaterialTypeDto[]> {
    await this.require(query.currentUser, VIEW, query.requestId);
    return this.repo.list(query);
  }

  /** Что умеет этот backend (FE решает, показывать ли поля): тип/категория номенклатуры и примечание — с миграции 234. */
  async capabilities(query: ListSheetMaterialTypesQuery): Promise<{ nomenclatureFields: true; onecItemPicker: true }> {
    await this.require(query.currentUser, VIEW, query.requestId);
    return { nomenclatureFields: true, onecItemPicker: true };
  }

  /**
   * Позиции номенклатуры 1С для поля «Позиция 1С» формы (только тем, кто правит справочник): каждая — с листовым
   * материалом ERP, который уже к ней привязан. Одна позиция из нескольких источников 1С показывается один раз.
   */
  async onecItems(query: ListSheetMaterialTypesQuery): Promise<{ available: boolean; items: OnecItemOptionDto[] }> {
    await this.require(query.currentUser, MANAGE, query.requestId);
    const rows = this.onecItemsSource ? await this.onecItemsSource() : null;
    // Копии нет или номенклатура ещё не загружена: выбора нет — форма оставляет ручной ввод ключа.
    if (rows === null || rows.length === 0) return { available: false, items: [] };
    const linked = new Map<string, { id: number; name: string }>();
    for (const sheet of await this.repo.list({ ...query, includeInactive: true })) {
      const key = sheet.refKey1c?.toLowerCase();
      if (key && !linked.has(key)) linked.set(key, { id: sheet.sheetMaterialTypeId, name: sheet.name });
    }
    const seen = new Set<string>();
    const items: OnecItemOptionDto[] = [];
    for (const row of rows) {
      const refKey = row.refKey.toLowerCase();
      if (seen.has(refKey)) continue;
      seen.add(refKey);
      const link = linked.get(refKey);
      items.push({ ...row, refKey, linkedSheetMaterialTypeId: link?.id ?? null, linkedName: link?.name ?? null });
    }
    return { available: true, items };
  }

  async getById(query: GetSheetMaterialTypeQuery): Promise<SheetMaterialTypeDto> {
    await this.require(query.currentUser, VIEW, query.requestId, query.id);
    return this.repo.getById(query);
  }

  async create(command: CreateSheetMaterialTypeCommand): Promise<SheetMaterialTypeDto> {
    await this.require(command.currentUser, MANAGE, command.requestId);
    return this.repo.create(command);
  }

  async update(command: UpdateSheetMaterialTypeCommand): Promise<SheetMaterialTypeDto> {
    await this.require(command.currentUser, MANAGE, command.requestId, command.id);
    return this.repo.update(command);
  }

  async deactivate(command: DeactivateSheetMaterialTypeCommand): Promise<void> {
    await this.require(command.currentUser, MANAGE, command.requestId, command.id);
    return this.repo.deactivate(command);
  }

  private async require(
    currentUser: CurrentUser,
    permission: PermissionName,
    requestId: string,
    targetId?: number,
  ): Promise<void> {
    if (this.permissions.canUser(currentUser, permission)) {
      return;
    }
    void this.repo
      .recordPermissionDenied({ currentUser, requiredPermissions: [permission], requestId, targetId })
      .catch(() => undefined);
    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
      requiredPermissions: [permission],
    });
  }
}
