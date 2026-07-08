import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  ListProjectsQuery,
  MergeCommand,
  MoveOrderCommand,
  ProjectsRepositoryPort,
  UpdateProjectCommand,
} from './projects.types';

export interface ProjectsServicePorts {
  projects: ProjectsRepositoryPort;
  permissions?: PermissionsService;
}

export class ProjectsService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: ProjectsServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async list(command: { currentUser: CurrentUser; query: ListProjectsQuery }) {
    this.require(command.currentUser, 'projects.view');
    return this.ports.projects.list(command.query);
  }

  async getById(command: { currentUser: CurrentUser; projectId: number }) {
    this.require(command.currentUser, 'projects.view');
    return this.ports.projects.getById(command.projectId);
  }

  async update(command: UpdateProjectCommand) {
    this.require(command.currentUser, 'projects.manage');
    return this.ports.projects.update(command);
  }

  async moveOrder(command: MoveOrderCommand) {
    this.require(command.currentUser, 'projects.manage');
    // Move rewrites orders.project_id — same base permission as order edit;
    // per-order scope ('own') is enforced in the repository on locked rows.
    this.require(command.currentUser, 'orders.update');
    return this.ports.projects.moveOrder(command);
  }

  async merge(command: MergeCommand) {
    this.require(command.currentUser, 'projects.manage');
    this.require(command.currentUser, 'orders.update');
    return this.ports.projects.merge(command);
  }

  private require(currentUser: CurrentUser, permission: PermissionName): void {
    if (!this.permissions.canUser(currentUser, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав', {
        requiredPermissions: [permission],
      });
    }
  }
}
