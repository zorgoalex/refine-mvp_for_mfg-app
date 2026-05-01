import { ApiError } from '../../../common/errors/api-error';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  AnalyzeVlmImageCommand,
  GetVlmHealthCommand,
  UploadVlmImageCommand,
  VlmProviderPort,
} from './vlm.types';

export interface VlmServicePorts {
  provider: VlmProviderPort;
  permissions?: PermissionsService;
}

export class VlmService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: VlmServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async getHealth(command: Omit<GetVlmHealthCommand, 'detailsVisible'>) {
    this.requirePermission(command, 'vlm.health.view');

    return this.ports.provider.getHealth({
      ...command,
      detailsVisible: this.permissions.canUserAny(command.currentUser, [
        'vlm.configure',
        'settings.manage',
      ]),
    });
  }

  async uploadImage(command: UploadVlmImageCommand) {
    this.requirePermission(command, 'vlm.use');
    return this.ports.provider.uploadImage(command);
  }

  async analyzeImage(command: AnalyzeVlmImageCommand) {
    this.requirePermission(command, 'vlm.use');
    return this.ports.provider.analyzeImage(command);
  }

  private requirePermission(
    command: Pick<UploadVlmImageCommand, 'currentUser'>,
    permission: Parameters<PermissionsService['canUser']>[1],
  ): void {
    if (!this.permissions.canUser(command.currentUser, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }
}
