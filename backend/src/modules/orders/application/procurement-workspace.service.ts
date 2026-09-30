import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { OrderPermissionCheckerPort } from './order-transaction.types';
import type {
  ProcurementSavedViewDto,
  ProcurementSettingsDto,
  ProcurementWorklistQuery,
  ProcurementWorklistResponseDto,
  UpdateProcurementSettingsCommand,
} from './procurement-workspace.types';

export interface ProcurementWorkspaceRepositoryPort {
  getSettings(): Promise<ProcurementSettingsDto>;
  updateSettings(command: UpdateProcurementSettingsCommand): Promise<{ changed: boolean; settings: ProcurementSettingsDto }>;
  listWorklist(
    currentUser: CurrentUser,
    query: ProcurementWorklistQuery,
    options: { procurementEnabled: boolean; supplyWorkspaceEnabled: boolean; supplierRequestsEnabled?: boolean },
  ): Promise<ProcurementWorklistResponseDto>;
  getSavedViews(currentUser: CurrentUser): Promise<ProcurementSavedViewDto[]>;
  replaceSavedViews(currentUser: CurrentUser, views: ProcurementSavedViewDto[]): Promise<ProcurementSavedViewDto[]>;
}

export interface ProcurementWorkspaceServicePorts {
  repository: ProcurementWorkspaceRepositoryPort;
  permissions?: OrderPermissionCheckerPort;
  /** Пул БД для denied-аудита вне транзакции команды. */
  auditClient?: DatabaseClient;
}

const VIEW = 'procurement.view';
const SETTINGS_MANAGE = 'settings.manage';

export class ProcurementWorkspaceService {
  private readonly permissions: OrderPermissionCheckerPort;

  constructor(private readonly ports: ProcurementWorkspaceServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async getSettings(user: CurrentUser): Promise<ProcurementSettingsDto> {
    if (!this.permissions.canUser(user, VIEW) && !this.permissions.canUser(user, SETTINGS_MANAGE)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра настроек снабжения', {
        requiredPermissions: [VIEW, SETTINGS_MANAGE],
      });
    }
    return this.ports.repository.getSettings();
  }

  async updateSettings(command: UpdateProcurementSettingsCommand): Promise<{ changed: boolean; settings: ProcurementSettingsDto }> {
    if (!this.permissions.canUser(command.currentUser, SETTINGS_MANAGE)) {
      if (this.ports.auditClient) {
        await auditService.recordDenied(this.ports.auditClient, {
          event: 'procurement.settings_denied',
          entityType: 'procurement_settings',
          entityId: '1',
          actorUserId: command.currentUser.id,
          actorUsername: command.currentUser.username,
          actorRole: command.currentUser.role,
          requestId: command.requestId,
          source: 'backend-procurement-workspace',
          reason: 'missing_permission',
          requiredPermissions: [SETTINGS_MANAGE],
          relatedEntities: [],
        });
      }
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для настройки снабжения', {
        requiredPermissions: [SETTINGS_MANAGE],
      });
    }
    return this.ports.repository.updateSettings(command);
  }

  async listWorklist(
    user: CurrentUser,
    query: ProcurementWorklistQuery,
    options: { procurementEnabled: boolean; supplyWorkspaceEnabled: boolean; supplierRequestsEnabled?: boolean },
  ): Promise<ProcurementWorklistResponseDto> {
    this.requireView(user);
    return this.ports.repository.listWorklist(user, query, options);
  }

  async getSavedViews(user: CurrentUser): Promise<ProcurementSavedViewDto[]> {
    this.requireView(user);
    return this.ports.repository.getSavedViews(user);
  }

  async replaceSavedViews(user: CurrentUser, views: ProcurementSavedViewDto[]): Promise<ProcurementSavedViewDto[]> {
    this.requireView(user);
    return this.ports.repository.replaceSavedViews(user, views);
  }

  private requireView(user: CurrentUser): void {
    if (!this.permissions.canUser(user, VIEW)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для экрана снабжения', {
        requiredPermissions: [VIEW],
      });
    }
  }
}
