import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { GroupEntityTypeCode } from './group-entity-links.dto';
import type {
  AppendGroupEntityLinksCommand,
  AppendIdempotentGroupEntityLinksCommand,
  ListGroupEntityLinksCommand,
  GroupEntityLinksRepositoryPort,
  ReplaceGroupEntityLinksCommand,
} from './group-entity-links.repository';
import { GROUP_ENTITY_REGISTRY } from './group-entity-registry';

export interface GroupEntityLinksPermissionsPort {
  canUser(user: CurrentUser | null | undefined, permission: PermissionName): boolean;
}

export interface GroupEntityLinksServicePorts {
  links: GroupEntityLinksRepositoryPort;
  permissions?: GroupEntityLinksPermissionsPort;
}

export class GroupEntityLinksService {
  private readonly permissions: GroupEntityLinksPermissionsPort;

  constructor(private readonly ports: GroupEntityLinksServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async list(command: ListGroupEntityLinksCommand) {
    this.requirePermission(command.currentUser, 'groups.view');
    if (command.entityType) {
      this.requireEntityPermission(command.currentUser, command.entityType);
    }
    return this.ports.links.list(command);
  }

  async replace(command: ReplaceGroupEntityLinksCommand) {
    this.requirePermission(command.currentUser, 'groups.manage_links');
    this.requireSubmittedEntityPermissions(command.currentUser, command.dto.links.map((link) => link.entityType));
    return this.ports.links.replace(command);
  }

  async append(command: AppendGroupEntityLinksCommand) {
    this.requirePermission(command.currentUser, 'groups.manage_links');
    this.requireSubmittedEntityPermissions(command.currentUser, command.dto.links.map((link) => link.entityType));
    return this.ports.links.append(command);
  }

  async appendIdempotent(command: AppendIdempotentGroupEntityLinksCommand) {
    this.requirePermission(command.currentUser, 'groups.manage_links');
    this.requireSubmittedEntityPermissions(command.currentUser, command.dto.links.map((link) => link.entityType));
    if (!this.ports.links.appendIdempotent) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Group entity links adapter is not configured');
    }
    return this.ports.links.appendIdempotent(command);
  }

  visibleEntityTypes(currentUser: CurrentUser): GroupEntityTypeCode[] {
    return Object.entries(GROUP_ENTITY_REGISTRY)
      .filter(([, entry]) => this.permissions.canUser(currentUser, entry.requiredPermission as PermissionName))
      .map(([code]) => code as GroupEntityTypeCode);
  }

  private requireSubmittedEntityPermissions(currentUser: CurrentUser, entityTypes: GroupEntityTypeCode[]): void {
    for (const entityType of [...new Set(entityTypes)]) {
      this.requireEntityPermission(currentUser, entityType);
    }
  }

  private requireEntityPermission(currentUser: CurrentUser, entityType: GroupEntityTypeCode): void {
    const permission = GROUP_ENTITY_REGISTRY[entityType].requiredPermission as PermissionName;
    this.requirePermission(currentUser, permission);
  }

  private requirePermission(currentUser: CurrentUser, permission: string): void {
    const typedPermission = permission as PermissionName;
    if (!this.permissions.canUser(currentUser, typedPermission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }
}
