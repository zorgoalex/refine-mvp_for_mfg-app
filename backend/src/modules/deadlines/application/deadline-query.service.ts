import { ApiError } from '../../../common/errors/api-error';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { PermissionName } from '../../../permissions/permissions';
import { calculateDeadlineTiming } from '../domain/deadline-calculator';
import type {
  EffectiveDeadlineActionRuleDto,
  EffectiveDeadlinePolicyRuleDto,
} from '../dto/deadline-action-rule.dto';
import type { DeadlineInstanceDto, OrderDeadlineSummaryDto } from '../dto/deadline-instance.dto';
import { DeadlineNotFoundError } from '../errors/deadline.errors';
import type {
  DeadlineRepositoryPort,
  GetDeadlineByIdCommand,
  GetDeadlineSettingsCommand,
  ListGlobalTransitionRulesCommand,
  ListOrderEffectiveDeadlineRulesCommand,
  ListDeadlinePoliciesCommand,
  ListDeadlinesCommand,
  ListOrderDeadlineEventsCommand,
  ListOrderDeadlinesCommand,
  PreviewOrderDeadlineActionRulesCommand,
} from './deadline.types';
import {
  evaluateDeadlineActionRules,
  filterActionRulesForFixture,
} from './deadline-action-evaluator';

export interface DeadlineQueryServicePorts {
  repository: DeadlineRepositoryPort;
  permissions?: PermissionsService;
}

export class DeadlineQueryService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: DeadlineQueryServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async list(command: ListDeadlinesCommand) {
    this.requirePermission(command, 'deadlines.view');
    const result = await this.ports.repository.listDeadlines(command);

    return {
      data: result.data,
      pagination: {
        page: command.query.page,
        pageSize: command.query.pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / command.query.pageSize),
      },
    };
  }

  async getById(command: GetDeadlineByIdCommand): Promise<DeadlineInstanceDto> {
    this.requirePermission(command, 'deadlines.view');

    const deadline = await this.ports.repository.getDeadlineById(command.deadlineId);
    if (!deadline) {
      throw new DeadlineNotFoundError(command.deadlineId);
    }

    return deadline;
  }

  async listOrderDeadlines(command: ListOrderDeadlinesCommand) {
    this.requirePermission(command, 'deadlines.view');
    return { data: await this.ports.repository.listOrderDeadlines(command.orderId) };
  }

  async listOrderDeadlineEvents(command: ListOrderDeadlineEventsCommand) {
    this.requirePermission(command, 'deadlines.audit.view');
    return { data: await this.ports.repository.listOrderDeadlineEvents(command.orderId) };
  }

  async getOrderDeadlineSummary(
    command: ListOrderDeadlinesCommand,
    now: string = new Date().toISOString(),
  ): Promise<OrderDeadlineSummaryDto> {
    this.requirePermission(command, 'deadlines.view');
    const deadlines = await this.ports.repository.listOrderDeadlines(command.orderId);

    return buildOrderDeadlineSummary(command.orderId, deadlines, now);
  }

  async listPolicies(command: ListDeadlinePoliciesCommand) {
    this.requirePermission(command, 'deadlines.actions.manage');
    return { data: await this.ports.repository.listPolicies() };
  }

  async getSettings(command: GetDeadlineSettingsCommand) {
    this.requirePermission(command, 'deadlines.actions.manage');
    return { settings: await this.ports.repository.getSettings() };
  }

  async listOrderEffectiveRules(command: ListOrderEffectiveDeadlineRulesCommand) {
    this.requireAnyPermission(command, ['deadlines.actions.manage', 'deadlines.manage_order_overrides']);

    const [policies, actionRules, overrides] = await Promise.all([
      this.ports.repository.listPolicies(),
      this.ports.repository.listGlobalTransitionRules(),
      this.ports.repository.listOrderOverrides(command.orderId),
    ]);

    const overrideByPolicyId = new Map(
      overrides
        .filter((override) => override.policyId)
        .map((override) => [override.policyId as string, override]),
    );
    const overrideByActionRuleId = new Map(
      overrides
        .filter((override) => override.actionRuleId)
        .map((override) => [override.actionRuleId as string, override]),
    );

    const effectivePolicies: EffectiveDeadlinePolicyRuleDto[] = policies.map((policy) => ({
      ...policy,
      override: overrideByPolicyId.get(policy.policyId) ?? null,
    }));
    const effectiveActionRules: EffectiveDeadlineActionRuleDto[] = actionRules.map((rule) => ({
      ...rule,
      override: overrideByActionRuleId.get(rule.actionRuleId) ?? null,
    }));

    return {
      orderId: command.orderId,
      policies: effectivePolicies,
      actionRules: effectiveActionRules,
      overrides,
    };
  }

  async previewOrderActionRules(command: PreviewOrderDeadlineActionRulesCommand) {
    this.requirePermission(command, 'deadlines.view');

    const [deadline, overrides, orderContext] = await Promise.all([
      command.dto.deadlineId
        ? this.ports.repository.getDeadlineById(command.dto.deadlineId)
        : Promise.resolve(null),
      this.ports.repository.listOrderOverrides(command.orderId),
      this.ports.repository.getOrderDeadlineEvaluationContext(command.orderId),
    ]);
    if (
      command.dto.deadlineId
      && (!deadline || deadline.orderId !== command.orderId)
    ) {
      throw new ApiError(
        422,
        'DEADLINE_PREVIEW_SCOPE_MISMATCH',
        'Deadline does not belong to the previewed order',
        { orderId: command.orderId, deadlineId: command.dto.deadlineId },
      );
    }
    const listedRules = await this.ports.repository.listActionRules({
      scopeType: deadline?.entityType ?? 'order',
      eventType: command.dto.eventType,
      deadlineId: command.dto.deadlineId ?? null,
      orderId: command.orderId,
    });
    const rules = filterActionRulesForFixture(listedRules, command.dto.fixtureKey ?? null);
    const hasStatusTransitionRules = rules.some((rule) => rule.actionType === 'change_order_status');
    const isCurrentDeadlineEvent = hasStatusTransitionRules
      ? await this.ports.repository.isDeadlineEventCurrentForOrder({
          orderId: command.orderId,
          deadlineId: command.dto.deadlineId ?? null,
          deadlineEventId: command.dto.deadlineEventId ?? null,
        })
      : true;

    const evaluation = evaluateDeadlineActionRules({
      eventType: command.dto.eventType,
      deadlineEventId: command.dto.deadlineEventId ?? 'preview-deadline-event',
      deadlineId: command.dto.deadlineId ?? null,
      targetType: 'order',
      targetId: String(command.orderId),
      orderContext,
      orderContextUnavailable: orderContext === null,
      isCurrentDeadlineEvent,
      rules,
      overrides,
    });

    return {
      orderId: command.orderId,
      eventType: command.dto.eventType,
      deadlineId: command.dto.deadlineId ?? null,
      deadlineEventId: command.dto.deadlineEventId ?? null,
      candidateActionRules: evaluation.candidates.map((candidate) => ({
        actionRuleId: candidate.actionRuleId,
        priority: candidate.priority,
        actionType: candidate.actionType,
        wouldRun: candidate.wouldRun,
        wouldSkipReason: candidate.skipReason,
        targetOrderStatusId: candidate.targetStatusId,
        overrideId: candidate.overrideId,
      })),
      selectedActionRuleId: evaluation.selectedActionRuleId,
      selectionReason: evaluation.selectionReason,
    };
  }

  async listGlobalTransitionRules(command: ListGlobalTransitionRulesCommand) {
    this.requirePermission(command, 'deadlines.actions.manage');

    return { data: await this.ports.repository.listGlobalTransitionRules() };
  }

  private requirePermission(
    command: { currentUser: Parameters<PermissionsService['canUser']>[0] },
    permission: PermissionName,
  ): void {
    if (!this.permissions.canUser(command.currentUser, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }

  private requireAnyPermission(
    command: { currentUser: Parameters<PermissionsService['canUser']>[0] },
    permissions: PermissionName[],
  ): void {
    if (!permissions.some((permission) => this.permissions.canUser(command.currentUser, permission))) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: permissions,
      });
    }
  }
}

export function buildOrderDeadlineSummary(
  orderId: number,
  deadlines: DeadlineInstanceDto[],
  now: string,
): OrderDeadlineSummaryDto {
  const orderDeadlines = deadlines.filter((deadline) => deadline.orderId === orderId);
  const finalDeadline = orderDeadlines
    .filter((deadline) => deadline.entityType === 'order')
    .sort(byDeadlineAtAsc)[0];
  const currentStageDeadline = orderDeadlines
    .filter((deadline) => deadline.entityType === 'order_stage')
    .sort(byCurrentStagePriority)[0];

  return {
    orderId,
    finalDeadline: finalDeadline ? toSummaryItem(finalDeadline, now) : null,
    currentStageDeadline: currentStageDeadline
      ? {
          ...toSummaryItem(currentStageDeadline, now),
          orderWorkshopId: currentStageDeadline.orderWorkshopId ?? null,
          stageName:
            typeof currentStageDeadline.metadata?.stageName === 'string'
              ? currentStageDeadline.metadata.stageName
              : null,
        }
      : null,
    counts: {
      active: orderDeadlines.filter((deadline) => deadline.status === 'active').length,
      expired: orderDeadlines.filter((deadline) => deadline.status === 'expired').length,
      completedLate: orderDeadlines.filter((deadline) => deadline.status === 'completed_late')
        .length,
      completedOnTime: orderDeadlines.filter(
        (deadline) => deadline.status === 'completed_on_time',
      ).length,
    },
  };
}

function toSummaryItem(deadline: DeadlineInstanceDto, now: string) {
  const timing = calculateDeadlineTiming({
    deadlineAt: deadline.deadlineAt,
    status: deadline.status,
    now,
  });

  return {
    deadlineId: deadline.deadlineId,
    deadlineAt: deadline.deadlineAt,
    status: deadline.status,
    remainingMinutes: timing.remainingMinutes,
    delayMinutes: timing.delayMinutes,
    severity: timing.severity,
  };
}

function byDeadlineAtAsc(left: DeadlineInstanceDto, right: DeadlineInstanceDto): number {
  return Date.parse(left.deadlineAt) - Date.parse(right.deadlineAt);
}

function byCurrentStagePriority(left: DeadlineInstanceDto, right: DeadlineInstanceDto): number {
  return statusPriority(left) - statusPriority(right) || byDeadlineAtAsc(left, right);
}

function statusPriority(deadline: DeadlineInstanceDto): number {
  if (deadline.status === 'expired') return 0;
  if (deadline.status === 'active') return 1;
  if (deadline.status === 'paused') return 2;

  return 3;
}
