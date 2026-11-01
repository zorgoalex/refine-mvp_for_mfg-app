import { ApiError } from '../../../common/errors/api-error';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { CreateDowelingOrderCommand, DowelingRepositoryPort, UpdateDowelingOrderCommand } from './doweling.types';

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
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для создания Базис-проекта', {
        requiredPermissions: ['doweling.create'],
      });
    }
    // Order scope of a quick-create from an order and the money right are checked by the repository.
    return this.ports.doweling.createDowelingOrder(command);
  }

  async updateDowelingOrder(command: UpdateDowelingOrderCommand) {
    if (!this.permissions.canUser(command.currentUser, 'doweling.update')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для изменения Базис-проекта', {
        requiredPermissions: ['doweling.update'],
      });
    }
    // Scope over the linked orders (current and new) and the money right (orders.view_financials, audited refusal) are
    // checked by the repository.
    return this.ports.doweling.updateDowelingOrder(command);
  }
}
