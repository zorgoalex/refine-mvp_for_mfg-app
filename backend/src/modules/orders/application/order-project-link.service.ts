import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  GetOrderProjectsCommand,
  OrderProjectLinkRepositoryPort,
  ReplaceOrderProjectsCommand,
} from './order-project-link.types';

export interface OrderProjectLinkServicePorts {
  links: OrderProjectLinkRepositoryPort;
  permissions?: PermissionsService;
}

export class OrderProjectLinkService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: OrderProjectLinkServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  get(command: GetOrderProjectsCommand) {
    this.requireAny(command.currentUser, ['orders.view', 'projects.view']);
    return this.ports.links.getOrderProjects(command);
  }

  replace(command: ReplaceOrderProjectsCommand) {
    this.requirePermission(command.currentUser, 'projects.manage_links');
    return this.ports.links.replaceOrderProjects(command);
  }

  private requirePermission(currentUser: CurrentUser, permission: PermissionName): void {
    if (!this.permissions.canUser(currentUser, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }

  private requireAny(currentUser: CurrentUser, permissions: PermissionName[]): void {
    if (!this.permissions.canUserAny(currentUser, permissions)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: permissions,
      });
    }
  }
}
