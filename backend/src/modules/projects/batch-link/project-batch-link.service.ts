import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName, UserRole } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import { PROJECT_ENTITY_REGISTRY } from '../entity-links/project-entity-registry';
import type {
  ProjectBatchLinkRequestDto,
  ProjectBatchLinkResponseDto,
} from './project-batch-link.dto';

export interface DryRunProjectBatchLinkCommand {
  currentUser: CurrentUser;
  projectId: string;
  dto: ProjectBatchLinkRequestDto;
  requestId?: string;
}

export interface ProjectBatchLinkRepositoryPort {
  dryRun(command: DryRunProjectBatchLinkCommand): Promise<ProjectBatchLinkResponseDto>;
}

export interface ProjectBatchLinkPermissionsPort {
  canUser(user: CurrentUser | null | undefined, permission: PermissionName): boolean;
}

export interface ProjectBatchLinkServicePorts {
  batchLinks: ProjectBatchLinkRepositoryPort;
  permissions?: ProjectBatchLinkPermissionsPort;
}

const ALLOWED_BATCH_LINK_ROLES = new Set<UserRole>(['admin', 'top_manager']);

export class ProjectBatchLinkService {
  private readonly permissions: ProjectBatchLinkPermissionsPort;

  constructor(private readonly ports: ProjectBatchLinkServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async dryRun(command: DryRunProjectBatchLinkCommand): Promise<ProjectBatchLinkResponseDto> {
    this.requirePermission(command.currentUser, 'projects.manage_links');
    if (!ALLOWED_BATCH_LINK_ROLES.has(command.currentUser.role)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        allowedRoles: [...ALLOWED_BATCH_LINK_ROLES],
      });
    }

    this.requirePermission(
      command.currentUser,
      PROJECT_ENTITY_REGISTRY[command.dto.entityType].requiredPermission as PermissionName,
    );

    return this.ports.batchLinks.dryRun(command);
  }

  private requirePermission(currentUser: CurrentUser, permission: PermissionName): void {
    if (!this.permissions.canUser(currentUser, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }
}
