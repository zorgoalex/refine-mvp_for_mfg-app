import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { ProjectEntityTypeCode } from './project-entity-links.dto';
import type {
  AppendProjectEntityLinksCommand,
  AppendIdempotentProjectEntityLinksCommand,
  ListProjectEntityLinksCommand,
  ProjectEntityLinksRepositoryPort,
  ReplaceProjectEntityLinksCommand,
} from './project-entity-links.repository';
import { PROJECT_ENTITY_REGISTRY } from './project-entity-registry';

export interface ProjectEntityLinksPermissionsPort {
  canUser(user: CurrentUser | null | undefined, permission: PermissionName): boolean;
}

export interface ProjectEntityLinksServicePorts {
  links: ProjectEntityLinksRepositoryPort;
  permissions?: ProjectEntityLinksPermissionsPort;
}

export class ProjectEntityLinksService {
  private readonly permissions: ProjectEntityLinksPermissionsPort;

  constructor(private readonly ports: ProjectEntityLinksServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async list(command: ListProjectEntityLinksCommand) {
    this.requirePermission(command.currentUser, 'projects.view');
    if (command.entityType) {
      this.requireEntityPermission(command.currentUser, command.entityType);
    }
    return this.ports.links.list(command);
  }

  async replace(command: ReplaceProjectEntityLinksCommand) {
    this.requirePermission(command.currentUser, 'projects.manage_links');
    this.requireSubmittedEntityPermissions(command.currentUser, command.dto.links.map((link) => link.entityType));
    return this.ports.links.replace(command);
  }

  async append(command: AppendProjectEntityLinksCommand) {
    this.requirePermission(command.currentUser, 'projects.manage_links');
    this.requireSubmittedEntityPermissions(command.currentUser, command.dto.links.map((link) => link.entityType));
    return this.ports.links.append(command);
  }

  async appendIdempotent(command: AppendIdempotentProjectEntityLinksCommand) {
    this.requirePermission(command.currentUser, 'projects.manage_links');
    this.requireSubmittedEntityPermissions(command.currentUser, command.dto.links.map((link) => link.entityType));
    if (!this.ports.links.appendIdempotent) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Project entity links adapter is not configured');
    }
    return this.ports.links.appendIdempotent(command);
  }

  visibleEntityTypes(currentUser: CurrentUser): ProjectEntityTypeCode[] {
    return Object.entries(PROJECT_ENTITY_REGISTRY)
      .filter(([, entry]) => this.permissions.canUser(currentUser, entry.requiredPermission as PermissionName))
      .map(([code]) => code as ProjectEntityTypeCode);
  }

  private requireSubmittedEntityPermissions(currentUser: CurrentUser, entityTypes: ProjectEntityTypeCode[]): void {
    for (const entityType of [...new Set(entityTypes)]) {
      this.requireEntityPermission(currentUser, entityType);
    }
  }

  private requireEntityPermission(currentUser: CurrentUser, entityType: ProjectEntityTypeCode): void {
    const permission = PROJECT_ENTITY_REGISTRY[entityType].requiredPermission as PermissionName;
    this.requirePermission(currentUser, permission);
  }

  private requirePermission(currentUser: CurrentUser, permission: PermissionName): void {
    if (!this.permissions.canUser(currentUser, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }
}
