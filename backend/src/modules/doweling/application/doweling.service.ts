import { ApiError } from '../../../common/errors/api-error';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { CreateDowelingOrderCommand, DowelingRepositoryPort } from './doweling.types';

export interface DowelingServicePorts {
  doweling: DowelingRepositoryPort;
  permissions?: PermissionsService;
}

export class DowelingService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: DowelingServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async createDowelingOrder(command: CreateDowelingOrderCommand) {
    if (!this.permissions.canUser(command.currentUser, 'doweling.create')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для создания присадки', {
        requiredPermissions: ['doweling.create'],
      });
    }
    return this.ports.doweling.createDowelingOrder(command);
  }
}
