import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { PermissionName } from '../../../permissions/permissions';
import {
  PgStatusAutomationRepository,
  type CreateStatusAutomationRuleDto,
  type UpdateStatusAutomationRuleDto,
} from '../adapters/pg-status-automation-repository';
import {
  listStatusAutomationEventTypes,
  type StatusAutomationEventTypeDto,
} from '../dto/status-automation.dto';
import type { StatusAutomationRule } from './status-automation.types';

const SOURCE = 'backend-status-automation';
const ENTITY_TYPE = 'status_automation_rule';
const VIEW_PERMISSION: PermissionName = 'status_automation.view';
const MANAGE_PERMISSION: PermissionName = 'status_automation.manage';

export class StatusAutomationRulesService {
  private readonly permissions = new PermissionsService();

  constructor(
    private readonly deps: {
      repository: PgStatusAutomationRepository;
      database: DatabaseService;
    },
  ) {}

  async list(currentUser: CurrentUser, requestId: string): Promise<StatusAutomationRule[]> {
    await this.requirePermission(currentUser, requestId, 0, VIEW_PERMISSION, 'rule_view_denied', 'list');
    return this.deps.repository.listRules();
  }

  async create(
    currentUser: CurrentUser,
    requestId: string,
    dto: CreateStatusAutomationRuleDto,
  ): Promise<StatusAutomationRule> {
    await this.requirePermission(currentUser, requestId, 0, MANAGE_PERMISSION, 'rule_change_denied', 'create');
    return this.deps.repository.createRule({ currentUser, requestId, dto });
  }

  async update(
    currentUser: CurrentUser,
    requestId: string,
    ruleId: number,
    dto: UpdateStatusAutomationRuleDto,
  ): Promise<StatusAutomationRule> {
    await this.requirePermission(
      currentUser,
      requestId,
      validEntityId(ruleId),
      MANAGE_PERMISSION,
      'rule_change_denied',
      'update',
    );
    assertPositiveIntegerRuleId(ruleId);
    return this.deps.repository.updateRule({ currentUser, requestId, ruleId, dto });
  }

  async delete(currentUser: CurrentUser, requestId: string, ruleId: number): Promise<{ deleted: true }> {
    await this.requirePermission(
      currentUser,
      requestId,
      validEntityId(ruleId),
      MANAGE_PERMISSION,
      'rule_change_denied',
      'delete',
    );
    assertPositiveIntegerRuleId(ruleId);
    return this.deps.repository.deleteRule({ currentUser, requestId, ruleId });
  }

  async listEventTypes(currentUser: CurrentUser, requestId = 'status-automation-event-types'): Promise<StatusAutomationEventTypeDto[]> {
    await this.requirePermission(currentUser, requestId, 0, VIEW_PERMISSION, 'rule_view_denied', 'listEventTypes');
    return listStatusAutomationEventTypes();
  }

  private async requirePermission(
    currentUser: CurrentUser,
    requestId: string,
    entityId: number,
    permission: PermissionName,
    deniedAction: 'rule_change_denied' | 'rule_view_denied',
    attemptedAction: string,
  ): Promise<void> {
    if (this.permissions.canUser(currentUser, permission)) {
      return;
    }

    try {
      await auditService.recordDenied(this.deps.database, {
        event: `status_automation.${deniedAction}`,
        entityType: ENTITY_TYPE,
        entityId,
        actorUserId: currentUser.id,
        actorUsername: currentUser.username,
        actorRole: currentUser.role,
        requestId,
        source: SOURCE,
        reason: 'PERMISSION_DENIED',
        requiredPermissions: [permission],
        metadata: { attemptedAction },
      });
    } catch {
      // Denied-audit is best effort and must never replace the permission error.
    }

    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
      requiredPermissions: [permission],
    });
  }
}

function assertPositiveIntegerRuleId(ruleId: number): void {
  if (!Number.isInteger(ruleId) || ruleId <= 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'ruleId must be a positive integer', { field: 'ruleId' });
  }
}

function validEntityId(ruleId: number): number {
  return Number.isInteger(ruleId) && ruleId > 0 ? ruleId : 0;
}
