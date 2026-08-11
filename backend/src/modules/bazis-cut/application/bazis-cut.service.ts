import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient } from '../../../database/database.types';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { PermissionName } from '../../../permissions/permissions';
import type { CurrentUser } from '../../../permissions/current-user';
import type { BazisCutRepositoryPort } from './bazis-cut.types';

export class BazisCutService {
  private readonly permissions: PermissionsService;

  constructor(
    private readonly repository: BazisCutRepositoryPort,
    permissions?: PermissionsService,
    private readonly auditDatabase?: DatabaseClient,
  ) {
    this.permissions = permissions ?? new PermissionsService();
  }

  async list(input: Parameters<BazisCutRepositoryPort['list']>[0]) {
    await this.require(input.currentUser, 'cut.view', 'list', input.requestId);
    return this.repository.list(input);
  }

  async get(input: Parameters<BazisCutRepositoryPort['get']>[0]) {
    await this.require(input.currentUser, 'cut.view', 'get', input.requestId, input.setId);
    return this.repository.get(input);
  }

  async create(input: Parameters<BazisCutRepositoryPort['create']>[0]) {
    await this.require(input.currentUser, 'cut.manage', 'create', input.requestId);
    return this.repository.create(input);
  }

  async pickerFacets(input: Parameters<BazisCutRepositoryPort['pickerFacets']>[0]) {
    await this.require(input.currentUser, 'cut.view', 'picker_facets', input.requestId);
    return this.repository.pickerFacets(input);
  }

  async pickerSearch(input: Parameters<BazisCutRepositoryPort['pickerSearch']>[0]) {
    await this.require(input.currentUser, 'cut.view', 'picker_search', input.requestId);
    return this.repository.pickerSearch(input);
  }

  async createFromPicker(input: Parameters<BazisCutRepositoryPort['createFromPicker']>[0]) {
    await this.require(input.currentUser, 'cut.manage', 'create_from_picker', input.requestId);
    return this.repository.createFromPicker(input);
  }

  async orderMemberships(input: Parameters<BazisCutRepositoryPort['orderMemberships']>[0]) {
    await this.require(input.currentUser, 'orders.view', 'order_memberships', input.requestId);
    return this.repository.orderMemberships(input);
  }

  async rename(input: Parameters<BazisCutRepositoryPort['rename']>[0]) {
    await this.require(input.currentUser, 'cut.manage', 'rename', input.requestId, input.setId);
    return this.repository.rename(input);
  }

  async addDetails(input: Parameters<BazisCutRepositoryPort['addDetails']>[0]) {
    await this.require(input.currentUser, 'cut.manage', 'add_details', input.requestId, input.setId);
    return this.repository.addDetails(input);
  }

  async updateDetail(input: Parameters<BazisCutRepositoryPort['updateDetail']>[0]) {
    await this.require(input.currentUser, 'cut.manage', 'update_detail', input.requestId, input.setId);
    return this.repository.updateDetail(input);
  }

  async deleteDetail(input: Parameters<BazisCutRepositoryPort['deleteDetail']>[0]) {
    await this.require(input.currentUser, 'cut.manage', 'remove_detail', input.requestId, input.setId);
    return this.repository.deleteDetail(input);
  }

  async deleteEmptySet(input: Parameters<BazisCutRepositoryPort['deleteEmptySet']>[0]) {
    await this.require(input.currentUser, 'cut.manage', 'delete_empty_set', input.requestId, input.setId);
    return this.repository.deleteEmptySet(input);
  }

  async export(input: Parameters<BazisCutRepositoryPort['export']>[0]) {
    await this.require(input.currentUser, 'cut.view', 'export', input.requestId, input.setId);
    return this.repository.export(input);
  }

  private async require(user: CurrentUser, permission: PermissionName,
    action: string, requestId?: string, setId?: number): Promise<void> {
    if (!this.permissions.canUser(user, permission)) {
      if (this.auditDatabase) {
        try {
          await auditService.recordDenied(this.auditDatabase, {
            event: 'bazis_cut_set.permission_denied', entityType: 'bazis_cut_set', entityId: setId ?? action,
            actorUserId: user.id, actorUsername: user.username, actorRole: user.role,
            requestId: requestId ?? `bazis-cut-${action}`, source: 'backend.bazis-cut',
            reason: 'PERMISSION_DENIED', requiredPermissions: [permission],
            relatedEntities: setId ? [{ entityType: 'bazis_cut_set', entityId: setId }] : [],
            metadata: { action },
          });
        } catch {
          /* denied audit is best-effort and must never mask the 403 */
        }
      }
      throw new ApiError(403, 'PERMISSION_DENIED', 'Insufficient permissions', {
        requiredPermissions: [permission],
      });
    }
  }
}
