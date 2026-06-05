import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  ListProjectParticipantsCommand,
  ProjectParticipantRolesCommand,
  ProjectParticipantsRepositoryPort,
  ReplaceProjectParticipantsCommand,
} from './project-participants.repository';

export interface ProjectParticipantsPermissionsPort {
  canUser(user: CurrentUser | null | undefined, permission: PermissionName): boolean;
}

export interface ProjectParticipantsServicePorts {
  participants: ProjectParticipantsRepositoryPort;
  permissions?: ProjectParticipantsPermissionsPort;
}

export class ProjectParticipantsService {
  private readonly permissions: ProjectParticipantsPermissionsPort;

  constructor(private readonly ports: ProjectParticipantsServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async list(command: ListProjectParticipantsCommand) {
    this.requirePermission(command.currentUser, 'projects.participants.view');
    return this.ports.participants.list(command);
  }

  async replace(command: ReplaceProjectParticipantsCommand) {
    this.requirePermission(command.currentUser, 'projects.participants.manage');
    return this.ports.participants.replace(command);
  }

  async roles(command: ProjectParticipantRolesCommand) {
    this.requirePermission(command.currentUser, 'projects.view');
    return this.ports.participants.roles(command);
  }

  private requirePermission(currentUser: CurrentUser, permission: PermissionName): void {
    if (!this.permissions.canUser(currentUser, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }
}
