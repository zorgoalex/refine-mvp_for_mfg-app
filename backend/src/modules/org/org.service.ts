import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser } from '../../permissions/current-user';
import type { PermissionName } from '../../permissions/permissions';
import { PermissionsService } from '../../permissions/permissions.service';
import type { OrgRepositoryPort } from './org.repository';

interface OrgPermissionsPort {
  canUser(u: CurrentUser | null | undefined, p: PermissionName): boolean;
}

export interface OrgServicePorts {
  repository: OrgRepositoryPort;
  permissions?: OrgPermissionsPort;
}

export class OrgService {
  private readonly permissions: OrgPermissionsPort;

  constructor(private readonly ports: OrgServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  // reads require org.view
  async listDirections(c: Parameters<OrgRepositoryPort['listDirections']>[0]) {
    this.require(c.currentUser, 'org.view');
    return this.ports.repository.listDirections(c);
  }
  async getDirection(c: Parameters<OrgRepositoryPort['getDirection']>[0]) {
    this.require(c.currentUser, 'org.view');
    return this.ports.repository.getDirection(c);
  }
  async listWorkshopHeads(c: Parameters<OrgRepositoryPort['listWorkshopHeads']>[0]) {
    this.require(c.currentUser, 'org.view');
    return this.ports.repository.listWorkshopHeads(c);
  }
  async assignableUsers(c: Parameters<OrgRepositoryPort['assignableUsers']>[0]) {
    this.require(c.currentUser, 'org.view');
    return this.ports.repository.assignableUsers(c);
  }
  async lookupWorkshops(c: Parameters<OrgRepositoryPort['lookupWorkshops']>[0]) {
    this.require(c.currentUser, 'org.view');
    return this.ports.repository.lookupWorkshops(c);
  }
  async lookupWorkCenters(c: Parameters<OrgRepositoryPort['lookupWorkCenters']>[0]) {
    this.require(c.currentUser, 'org.view');
    return this.ports.repository.lookupWorkCenters(c);
  }

  // writes require org.manage
  async createDirection(c: Parameters<OrgRepositoryPort['createDirection']>[0]) {
    this.require(c.currentUser, 'org.manage');
    return this.ports.repository.createDirection(c);
  }
  async updateDirection(c: Parameters<OrgRepositoryPort['updateDirection']>[0]) {
    this.require(c.currentUser, 'org.manage');
    return this.ports.repository.updateDirection(c);
  }
  async deleteDirection(c: Parameters<OrgRepositoryPort['deleteDirection']>[0]) {
    this.require(c.currentUser, 'org.manage');
    return this.ports.repository.deleteDirection(c);
  }
  async replaceDirectionWorkshops(c: Parameters<OrgRepositoryPort['replaceDirectionWorkshops']>[0]) {
    this.require(c.currentUser, 'org.manage');
    return this.ports.repository.replaceDirectionWorkshops(c);
  }
  async replaceDirectionWorkCenters(c: Parameters<OrgRepositoryPort['replaceDirectionWorkCenters']>[0]) {
    this.require(c.currentUser, 'org.manage');
    return this.ports.repository.replaceDirectionWorkCenters(c);
  }
  async replaceDirectionHeads(c: Parameters<OrgRepositoryPort['replaceDirectionHeads']>[0]) {
    this.require(c.currentUser, 'org.manage');
    return this.ports.repository.replaceDirectionHeads(c);
  }
  async replaceWorkshopHeads(c: Parameters<OrgRepositoryPort['replaceWorkshopHeads']>[0]) {
    this.require(c.currentUser, 'org.manage');
    return this.ports.repository.replaceWorkshopHeads(c);
  }

  private require(user: CurrentUser, permission: PermissionName): void {
    if (!this.permissions.canUser(user, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }
}
