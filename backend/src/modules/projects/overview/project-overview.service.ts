import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { ProjectOverviewQuery, ProjectOverviewResponseDto } from './project-overview.dto';
import type { ProjectOverviewRepositoryPort } from './project-overview.repository';

const REQUIRED_OVERVIEW_PERMISSIONS = ['projects.view', 'orders.view'] as const satisfies readonly PermissionName[];

export interface GetProjectOverviewCommand {
  currentUser: CurrentUser;
  projectId: string;
  query: ProjectOverviewQuery;
  requestId?: string;
}

export interface ProjectOverviewPermissionsPort {
  canUser(user: CurrentUser | null | undefined, permission: PermissionName, requestId?: string): boolean;
}

export interface ProjectOverviewServicePorts {
  overviews: ProjectOverviewRepositoryPort;
  permissions?: ProjectOverviewPermissionsPort;
}

export class ProjectOverviewService {
  private readonly permissions: ProjectOverviewPermissionsPort;

  constructor(private readonly ports: ProjectOverviewServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async getOverview(command: GetProjectOverviewCommand): Promise<ProjectOverviewResponseDto> {
    this.requirePermissions(command.currentUser, REQUIRED_OVERVIEW_PERMISSIONS, command.requestId);

    return this.ports.overviews.getOverview({ projectId: command.projectId, query: command.query });
  }

  private requirePermissions(
    currentUser: CurrentUser,
    requiredPermissions: readonly PermissionName[],
    requestId?: string,
  ): void {
    const missingPermissions = requiredPermissions.filter(
      (permission) => !this.permissions.canUser(currentUser, permission, requestId),
    );

    if (missingPermissions.length > 0) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [...requiredPermissions],
        missingPermissions,
      });
    }
  }
}
