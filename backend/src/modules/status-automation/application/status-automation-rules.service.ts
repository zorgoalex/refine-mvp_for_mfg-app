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
  type StatusAutomationRecentOrdersRefreshResponseDto,
  type StatusAutomationEventTypeDto,
} from '../dto/status-automation.dto';
import type { StatusAutomationRule } from './status-automation.types';
import {
  evaluateAllStatusAutomationRulesForOrder,
  type StatusAutomationOrderRefreshSummary,
} from './status-automation-runtime';

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

  async refreshRecentOrders(
    currentUser: CurrentUser,
    requestId: string,
  ): Promise<StatusAutomationRecentOrdersRefreshResponseDto> {
    await this.requirePermission(
      currentUser,
      requestId,
      0,
      MANAGE_PERMISSION,
      'rule_change_denied',
      'refreshRecentOrders',
    );

    const cutoffDate = dateOnlyMonthsAgo(new Date(), 2);
    const orderIds = await this.deps.repository.listRecentOrderIdsForAutomation(cutoffDate);
    const totals = emptyRefreshTotals();
    const failures: StatusAutomationRecentOrdersRefreshResponseDto['failures'] = [];
    let processedOrderCount = 0;

    for (const orderId of orderIds) {
      try {
        const summary = await this.deps.database.transaction(async (tx) => {
          await tx.query('SELECT set_session_user($1)', [currentUser.id]);
          return evaluateAllStatusAutomationRulesForOrder(tx, {
            orderId,
            actor: currentUser,
            requestId,
            sourceIdempotencyKey: `status-automation-refresh-recent:${requestId}:order-${orderId}`,
          });
        });
        processedOrderCount += 1;
        addRefreshTotals(totals, summary);
      } catch (error: unknown) {
        failures.push(refreshFailure(orderId, error));
      }
    }

    return {
      cutoffDate,
      orderCount: orderIds.length,
      processedOrderCount,
      failedOrderCount: failures.length,
      failures: failures.slice(0, 20),
      totals,
      refreshedAt: new Date().toISOString(),
      requestId,
    };
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

function emptyRefreshTotals(): StatusAutomationRecentOrdersRefreshResponseDto['totals'] {
  return {
    evaluatedRuleCount: 0,
    matchedRuleCount: 0,
    executedActionCount: 0,
    skippedRuleCount: 0,
    skippedActionCount: 0,
  };
}

function addRefreshTotals(
  totals: StatusAutomationRecentOrdersRefreshResponseDto['totals'],
  summary: StatusAutomationOrderRefreshSummary,
): void {
  totals.evaluatedRuleCount += summary.evaluatedRuleCount;
  totals.matchedRuleCount += summary.matchedRuleCount;
  totals.executedActionCount += summary.executedActionCount;
  totals.skippedRuleCount += summary.skippedRuleCount;
  totals.skippedActionCount += summary.skippedActionCount;
}

function refreshFailure(
  orderId: number,
  error: unknown,
): StatusAutomationRecentOrdersRefreshResponseDto['failures'][number] {
  const maybeApiError = error as Partial<ApiError>;
  return {
    orderId,
    code: typeof maybeApiError.code === 'string' ? maybeApiError.code : 'REFRESH_FAILED',
    message: error instanceof Error ? error.message : 'Не удалось проверить заказ автостатусами',
  };
}

function dateOnlyMonthsAgo(now: Date, months: number): string {
  const targetMonth = now.getUTCMonth() - months;
  const firstOfTarget = new Date(Date.UTC(now.getUTCFullYear(), targetMonth, 1));
  const lastDayOfTarget = new Date(Date.UTC(
    firstOfTarget.getUTCFullYear(),
    firstOfTarget.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  firstOfTarget.setUTCDate(Math.min(now.getUTCDate(), lastDayOfTarget));
  return firstOfTarget.toISOString().slice(0, 10);
}
