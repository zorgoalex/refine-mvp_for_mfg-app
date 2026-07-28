import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  CutConfigAdminPort,
  CutConfigContext,
  DeleteCatalogRowCommand,
  UpdateCutSettingCommand,
  UpsertCutPdfTemplateCommand,
  UpsertCutParamProfileCommand,
  UpsertCutRenderPresetCommand,
} from './cut-config-admin.types';
import { cutPdfFieldCatalog, validateCutPdfTemplateLayout } from './cut-pdf-template-layout';

export interface CutConfigAdminServicePorts {
  config: CutConfigAdminPort;
  permissions?: PermissionsService;
}

/**
 * RBAC for the cut-config admin surface (CLAUDE.md principle 8): reads require
 * cut.view, every write requires cut.manage. Frontend permission decisions are
 * never authoritative.
 */
export class CutConfigAdminService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: CutConfigAdminServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async getConfig(context: CutConfigContext) {
    this.require(context.currentUser, 'cut.view', context.requestId);
    return this.ports.config.getConfig(context);
  }

  async listPdfTemplateFields(context: CutConfigContext) {
    this.require(context.currentUser, 'cut.view', context.requestId);
    return cutPdfFieldCatalog();
  }

  async updateSetting(command: UpdateCutSettingCommand) {
    this.require(command.currentUser, 'cut.manage', command.requestId);
    return this.ports.config.updateSetting(command);
  }

  async upsertParamProfile(command: UpsertCutParamProfileCommand) {
    this.require(command.currentUser, 'cut.manage', command.requestId);
    return this.ports.config.upsertParamProfile(command);
  }

  async deleteParamProfile(command: DeleteCatalogRowCommand) {
    this.require(command.currentUser, 'cut.manage', command.requestId);
    return this.ports.config.deleteParamProfile(command);
  }

  async upsertRenderPreset(command: UpsertCutRenderPresetCommand) {
    this.require(command.currentUser, 'cut.manage', command.requestId);
    return this.ports.config.upsertRenderPreset(command);
  }

  async deleteRenderPreset(command: DeleteCatalogRowCommand) {
    this.require(command.currentUser, 'cut.manage', command.requestId);
    return this.ports.config.deleteRenderPreset(command);
  }

  async upsertPdfTemplate(command: UpsertCutPdfTemplateCommand) {
    this.require(command.currentUser, 'cut.manage', command.requestId);
    validateCutPdfTemplateLayout(command.input.layout);
    return this.ports.config.upsertPdfTemplate(command);
  }

  private require(
    currentUser: CurrentUser | null | undefined,
    permission: PermissionName,
    requestId?: string,
  ): void {
    if (this.permissions.canUser(currentUser, permission)) {
      return;
    }
    if (currentUser) {
      void this.ports.config
        .recordPermissionDenied({ currentUser, requiredPermissions: [permission], requestId })
        .catch(() => undefined);
    }
    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
      requiredPermissions: [permission],
    });
  }
}
