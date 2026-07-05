import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import { GROUP_ENTITY_REGISTRY } from '../entity-links/group-entity-registry';
import type { GroupOverviewQuery, GroupOverviewResponseDto } from './group-overview.dto';
import type { GroupOverviewRepositoryPort } from './group-overview.repository';

const REQUIRED_OVERVIEW_PERMISSIONS = ['groups.view', 'orders.view'] as const satisfies readonly PermissionName[];

export interface GetGroupOverviewCommand {
  currentUser: CurrentUser;
  groupId: string;
  query: GroupOverviewQuery;
  requestId?: string;
}

export interface GroupOverviewPermissionsPort {
  canUser(user: CurrentUser | null | undefined, permission: PermissionName, requestId?: string): boolean;
}

export interface GroupOverviewServicePorts {
  overviews: GroupOverviewRepositoryPort;
  permissions?: GroupOverviewPermissionsPort;
}

export class GroupOverviewService {
  private readonly permissions: GroupOverviewPermissionsPort;

  constructor(private readonly ports: GroupOverviewServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async getOverview(command: GetGroupOverviewCommand): Promise<GroupOverviewResponseDto> {
    this.requirePermissions(command.currentUser, REQUIRED_OVERVIEW_PERMISSIONS, command.requestId);

    return this.ports.overviews.getOverview({
      groupId: command.groupId,
      query: command.query,
      visibleEntityTypes: Object.entries(GROUP_ENTITY_REGISTRY)
        .filter(([, entry]) => this.permissions.canUser(command.currentUser, entry.requiredPermission, command.requestId))
        .map(([code]) => code as keyof typeof GROUP_ENTITY_REGISTRY),
      canViewParticipants: this.permissions.canUser(
        command.currentUser,
        'groups.participants.view',
        command.requestId,
      ),
    });
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
