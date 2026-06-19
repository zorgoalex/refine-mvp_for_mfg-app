import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  CreateSheetMaterialTypeCommand,
  DeactivateSheetMaterialTypeCommand,
  GetSheetMaterialTypeQuery,
  ListSheetMaterialTypesQuery,
  SheetMaterialsPort,
  SheetMaterialTypeDto,
  UpdateSheetMaterialTypeCommand,
} from './sheet-materials.types';

export interface SheetMaterialsServicePorts {
  repo: SheetMaterialsPort;
  permissions?: PermissionsService;
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

  constructor(ports: SheetMaterialsServicePorts) {
    this.repo = ports.repo;
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async list(query: ListSheetMaterialTypesQuery): Promise<SheetMaterialTypeDto[]> {
    await this.require(query.currentUser, VIEW, query.requestId);
    return this.repo.list(query);
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
