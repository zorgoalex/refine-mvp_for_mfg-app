import type { DeadlineActionRuleDto } from '../dto/deadline-action-rule.dto';
import type { DeadlineRuleConfigSnapshotDto } from '../dto/deadline-action-rule.dto';
import type { DeadlineEventDto } from '../dto/deadline-instance.dto';
import { isNotificationAction } from '../domain/deadline-actions';
import { buildDeadlineActionIdempotencyKey } from '../domain/deadline-idempotency';
import { withOwnerOverride } from '../../notifications-engine/domain/notification-event-registry';

function isEngineOwnedEventType(
  eventType: string,
  engineOwnsDeadline: boolean,
): boolean {
  return withOwnerOverride(eventType, engineOwnsDeadline ? 'engine' : undefined)?.owner === 'engine';
}
import {
  buildRuleConfigSnapshot,
  evaluateDeadlineActionRules,
  filterActionRulesForFixture,
  type DeadlineActionRuleEvaluationCandidate,
} from './deadline-action-evaluator';
import type {
  CreateActionExecutionInput,
  DeadlineNotificationPort,
  DeadlineOrderStatusActionPort,
  DeadlineProductionStatusActionPort,
  DeadlineRepositoryPort,
  DeadlineTargetResolverPort,
  DeadlineTargetState,
} from './deadline.types';

export interface DeadlineActionDispatcherConfig {
  actionsEnabled: boolean;
  notificationsEnabled: boolean;
  /**
   * When `true`, the global notification engine owns the `DEADLINE_EXPIRED`
   * event and the inline `notify_*` / `escalate` paths must record a
   * `skipReason='owned_by_notification_engine'` skipped execution instead
   * of writing a notification. This is the convergence cutover switch
   * (mirrors `BACKEND_NOTIFICATION_ENGINE_OWNS_DEADLINE`). Defaults to
   * `false` for legacy-mode callers (the worker, the controller) which
   * always set it explicitly; the field is optional so pre-existing test
   * fixtures remain source-compatible.
   */
  engineOwnsDeadline?: boolean;
}

export interface DispatchDeadlineActionsCommand {
  event: DeadlineEventDto;
  repository: DeadlineRepositoryPort;
  targetResolver: DeadlineTargetResolverPort;
  notificationPort: DeadlineNotificationPort;
  config: DeadlineActionDispatcherConfig;
}

export interface DeadlineActionDispatcherPorts {
  statusActionPort?: DeadlineOrderStatusActionPort;
  productionStatusActionPort?: DeadlineProductionStatusActionPort;
}

export class DeadlineActionDispatcherService {
  constructor(private readonly ports: DeadlineActionDispatcherPorts = {}) {}

  async dispatch(command: DispatchDeadlineActionsCommand) {
    const listedRules = await command.repository.listActionRules({
      scopeType: command.event.entityType,
      eventType: command.event.eventType,
      deadlineId: command.event.deadlineId,
      orderId: command.event.orderId,
    });
    const rules = filterActionRulesForFixture(listedRules, getEventFixtureKey(command.event));

    const evaluation = await this.evaluateRules(command, rules);
    const executions = [];
    for (const candidate of evaluation.candidates) {
      executions.push(await this.dispatchCandidate(command, candidate, evaluation.selectedActionRuleId));
    }

    return executions;
  }

  private async evaluateRules(command: DispatchDeadlineActionsCommand, rules: DeadlineActionRuleDto[]) {
    const orderId = command.event.orderId ?? null;
    const orderContextCandidateRules = rules.filter((rule) =>
      rule.actionType === 'change_order_status'
      || ((rule.actionType === 'set_overdue_flag' || rule.actionType === 'change_production_status')
          && hasGatingConditions(rule)),
    );
    const actionRuleIds = rules.map((rule) => rule.actionRuleId);
    const overrides =
      orderId && actionRuleIds.length > 0
        ? await command.repository.listOrderActionRuleOverrides(orderId, actionRuleIds)
        : [];
    // Status transitions are action rules in the current contract; policy-level overrides apply to
    // deadline timer policies, while transition suppression is keyed by action_rule_id.
    const actionRuleIdSet = new Set(actionRuleIds);
    const relevantOverrides = overrides.filter(
      (override) => override.actionRuleId && actionRuleIdSet.has(override.actionRuleId),
    );
    const orderContext =
      orderId && orderContextCandidateRules.length > 0
        ? await command.repository.getOrderDeadlineEvaluationContext(orderId)
        : null;
    const isCurrentDeadlineEvent =
      orderId && orderContextCandidateRules.length > 0
        ? await command.repository.isDeadlineEventCurrentForOrder({
            orderId,
            deadlineId: command.event.deadlineId,
            deadlineEventId: command.event.deadlineEventId,
          })
        : true;

    return evaluateDeadlineActionRules({
      eventType: command.event.eventType,
      deadlineEventId: command.event.deadlineEventId,
      deadlineId: command.event.deadlineId,
      targetType: command.event.entityType,
      targetId: command.event.entityId,
      orderContext,
      orderContextUnavailable: Boolean(orderId && orderContextCandidateRules.length > 0 && !orderContext),
      isCurrentDeadlineEvent,
      actionsEnabled: command.config.actionsEnabled,
      rules,
      overrides: relevantOverrides,
    });
  }

  private async dispatchCandidate(
    command: DispatchDeadlineActionsCommand,
    candidate: DeadlineActionRuleEvaluationCandidate,
    selectedActionRuleId: string | null,
  ) {
    const baseExecution = createExecutionInput(
      command.event,
      candidate.rule,
      candidate.ruleSnapshot,
      candidate.orderContext?.orderStatusId ?? null,
    );

    if (candidate.rule.actionType === 'change_order_status') {
      if (candidate.actionRuleId === selectedActionRuleId && candidate.skipReason === null) {
        return this.dispatchChangeOrderStatus(command, candidate, baseExecution);
      }

      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: candidate.skipReason ?? 'lower_priority_rule_not_selected',
      });
    }

    if (candidate.skipReason) {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: candidate.skipReason,
      });
    }

    return this.dispatchRule(command, candidate.rule, baseExecution);
  }

  private async dispatchChangeOrderStatus(
    command: DispatchDeadlineActionsCommand,
    candidate: DeadlineActionRuleEvaluationCandidate,
    baseExecution: CreateActionExecutionInput,
  ) {
    const orderId = command.event.orderId ?? null;
    const targetOrderStatusId = candidate.targetStatusId;

    if (!this.ports.statusActionPort) {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: 'action_handler_unavailable',
      });
    }
    if (!orderId) {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: 'missing_order_id',
      });
    }
    if (!targetOrderStatusId) {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: 'missing_target_status',
      });
    }

    try {
      const result = await this.ports.statusActionPort.changeOrderStatusFromDeadline({
        source: 'deadline-engine',
        systemActor: {
          type: 'system',
          actorUserId: null,
          actorLabel: 'deadline-engine',
        },
        orderId,
        expectedSourceOrderStatusId: candidate.orderContext?.orderStatusId as number,
        targetOrderStatusId,
        deadlineId: command.event.deadlineId,
        deadlineEventId: command.event.deadlineEventId,
        actionRuleId: candidate.actionRuleId,
        ruleVersionId: baseExecution.ruleVersionId ?? null,
        ruleConfigSnapshot: candidate.ruleSnapshot,
        idempotencyKey: baseExecution.idempotencyKey,
        occurredAt: command.event.eventAt,
        requestId: getEventRequestId(command.event),
      });

      return command.repository.createActionExecution({
        ...baseExecution,
        status: result.status,
        skipReason: result.status === 'skipped' ? result.skipReason ?? 'same_status' : null,
        result: result.result ?? null,
        executedAt: result.status === 'executed' ? command.event.eventAt : null,
      });
    } catch (error) {
      const mapped = mapStatusActionError(error);
      return command.repository.createActionExecution({
        ...baseExecution,
        status: mapped.status,
        skipReason: mapped.skipReason,
        errorCode: mapped.errorCode,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async dispatchRule(
    command: DispatchDeadlineActionsCommand,
    rule: DeadlineActionRuleDto,
    baseExecution: CreateActionExecutionInput,
  ) {
    if (isNotificationAction(rule.actionType) && !command.config.notificationsEnabled) {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: 'notifications_disabled',
      });
    }

    if (
      isNotificationAction(rule.actionType)
      && command.config.engineOwnsDeadline
      && isEngineOwnedEventType(command.event.eventType, command.config.engineOwnsDeadline)
    ) {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: 'owned_by_notification_engine',
      });
    }

    if (isNotificationAction(rule.actionType)) {
      return this.dispatchNotification(command, rule, baseExecution);
    }

    if (rule.actionType === 'write_audit') {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'executed',
        result: { auditEventQueued: true },
        executedAt: command.event.eventAt,
      });
    }

    if (rule.actionType === 'set_overdue_flag' && command.event.eventType !== 'DEADLINE_EXPIRED') {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: 'unsupported_event_type',
      });
    }

    const canApplyAction = await command.targetResolver.canApplyAction({
      actionType: rule.actionType,
      target: {
        entityType: command.event.entityType,
        entityId: command.event.entityId,
        orderId: command.event.orderId,
        orderWorkshopId: command.event.orderWorkshopId,
        clientId: command.event.clientId,
      },
    });

    if (!canApplyAction) {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: 'target_rejected_action',
      });
    }

    if (rule.actionType === 'set_overdue_flag') {
      return this.dispatchSetOverdueFlag(command, baseExecution);
    }

    if (rule.actionType === 'change_production_status') {
      return this.dispatchChangeProductionStatus(command, rule, baseExecution);
    }

    if (rule.actionType === 'escalate') {
      return this.dispatchEscalate(command, baseExecution);
    }

    return command.repository.createActionExecution({
      ...baseExecution,
      status: 'skipped',
      skipReason: 'action_handler_unavailable',
    });
  }

  private async dispatchEscalate(
    command: DispatchDeadlineActionsCommand,
    baseExecution: CreateActionExecutionInput,
  ) {
    if (!command.config.notificationsEnabled) {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: 'notifications_disabled',
      });
    }

    if (
      command.config.engineOwnsDeadline
      && isEngineOwnedEventType(command.event.eventType, command.config.engineOwnsDeadline)
    ) {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: 'owned_by_notification_engine',
      });
    }

    if (command.event.eventType !== 'DEADLINE_EXPIRED') {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: 'unsupported_event_type',
      });
    }

    const targetState = await command.targetResolver.resolveTargetState({
      entityType: command.event.entityType,
      entityId: command.event.entityId,
      orderId: command.event.orderId,
      orderWorkshopId: command.event.orderWorkshopId,
      clientId: command.event.clientId,
    });
    const userId = targetState.notificationRecipients?.managerUserId ?? null;

    if (!userId) {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: 'escalation_target_missing',
      });
    }

    const notificationText = buildEscalationNotificationText(command.event);
    const notificationIdempotencyKey = buildNotificationIdempotencyKey({
      deadlineEventId: command.event.deadlineEventId,
      actionType: 'escalate',
      userId,
    });

    let notification;
    try {
      notification = await command.notificationPort.createNotification({
        userId,
        level: notificationText.level,
        title: notificationText.title,
        message: notificationText.message,
        entityType: command.event.entityType,
        entityId: command.event.entityId,
        sourceType: 'deadline',
        sourceId: command.event.deadlineEventId,
        idempotencyKey: notificationIdempotencyKey,
      });
    } catch (error) {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: 'notification_port_unavailable',
        errorCode: error instanceof Error ? error.name : 'notification_error',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }

    return command.repository.createActionExecution({
      ...baseExecution,
      status: 'executed',
      skipReason: null,
      executedAt: command.event.eventAt,
      result: {
        escalatedUserId: userId,
        notificationId: notification.notificationId,
        notificationCreated: notification.created,
        notificationIdempotencyKey,
      },
    });
  }

  private async dispatchSetOverdueFlag(
    command: DispatchDeadlineActionsCommand,
    baseExecution: CreateActionExecutionInput,
  ) {
    const deadline = await command.repository.markDeadlineExpired({
      deadlineId: command.event.deadlineId,
      expiredAt: command.event.eventAt,
    });

    return command.repository.createActionExecution({
      ...baseExecution,
      status: 'executed',
      executedAt: command.event.eventAt,
      result: {
        overdueFlagSet: deadline.status === 'expired',
        deadlineId: command.event.deadlineId,
        targetType: baseExecution.targetType ?? null,
        targetId: baseExecution.targetId ?? null,
        expiredAt: deadline.expiredAt ?? command.event.eventAt,
      },
    });
  }

  private async dispatchChangeProductionStatus(
    command: DispatchDeadlineActionsCommand,
    rule: DeadlineActionRuleDto,
    baseExecution: CreateActionExecutionInput,
  ) {
    if (!this.ports.productionStatusActionPort) {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: 'action_handler_unavailable',
      });
    }
    if (command.event.eventType !== 'DEADLINE_EXPIRED') {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: 'unsupported_event_type',
      });
    }

    const orderId = resolveEventOrderId(command.event);
    if (!orderId) {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: 'missing_order_id',
      });
    }

    const targetProductionStatusId = rule.config?.actionConfig?.targetProductionStatusId ?? null;
    if (!targetProductionStatusId) {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: 'missing_target_production_status',
      });
    }

    const productionStatusScope = rule.config?.actionConfig?.productionStatusScope;
    if (productionStatusScope !== 'order') {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: 'unsupported_production_status_scope',
      });
    }

    try {
      const result = await this.ports.productionStatusActionPort.changeProductionStatusFromDeadline({
        source: 'deadline-engine',
        systemActor: {
          type: 'system',
          actorUserId: null,
          actorLabel: 'deadline-engine',
        },
        orderId,
        targetProductionStatusId,
        productionStatusScope,
        deadlineId: command.event.deadlineId,
        deadlineEventId: command.event.deadlineEventId,
        actionRuleId: rule.actionRuleId,
        ruleVersionId: baseExecution.ruleVersionId ?? null,
        ruleConfigSnapshot: baseExecution.ruleConfigSnapshot ?? buildRuleConfigSnapshot(rule),
        idempotencyKey: baseExecution.idempotencyKey,
        occurredAt: command.event.eventAt,
        requestId: getEventRequestId(command.event),
      });

      return command.repository.createActionExecution({
        ...baseExecution,
        status: result.status,
        skipReason: result.status === 'skipped' ? result.skipReason ?? 'same_production_status' : null,
        result: result.result ?? null,
        executedAt: result.status === 'executed' ? command.event.eventAt : null,
      });
    } catch (error) {
      const mapped = mapProductionStatusActionError(error);
      return command.repository.createActionExecution({
        ...baseExecution,
        status: mapped.status,
        skipReason: mapped.skipReason,
        errorCode: mapped.errorCode,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async dispatchNotification(
    command: DispatchDeadlineActionsCommand,
    rule: DeadlineActionRuleDto,
    baseExecution: CreateActionExecutionInput,
  ) {
    const targetState = await command.targetResolver.resolveTargetState({
      entityType: command.event.entityType,
      entityId: command.event.entityId,
      orderId: command.event.orderId,
      orderWorkshopId: command.event.orderWorkshopId,
      clientId: command.event.clientId,
    });
    const userId = selectNotificationRecipientUserId(rule.actionType, targetState);

    if (!userId) {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: 'notification_target_missing',
      });
    }

    const notificationText = buildNotificationText(command.event);
    const notificationIdempotencyKey = buildNotificationIdempotencyKey({
      deadlineEventId: command.event.deadlineEventId,
      actionType: rule.actionType,
      userId,
    });

    let notification;
    try {
      notification = await command.notificationPort.createNotification({
        userId,
        level: notificationText.level,
        title: notificationText.title,
        message: notificationText.message,
        entityType: command.event.entityType,
        entityId: command.event.entityId,
        sourceType: 'deadline',
        sourceId: command.event.deadlineEventId,
        idempotencyKey: notificationIdempotencyKey,
      });
    } catch (error) {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: 'notification_port_unavailable',
        errorCode: error instanceof Error ? error.name : 'notification_error',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }

    return command.repository.createActionExecution({
      ...baseExecution,
      status: 'executed',
      executedAt: command.event.eventAt,
      result: {
        notificationUserId: userId,
        notificationId: notification.notificationId,
        notificationCreated: notification.created,
        notificationIdempotencyKey,
        actionType: rule.actionType,
      },
    });
  }
}

function selectNotificationRecipientUserId(
  actionType: string,
  targetState: DeadlineTargetState,
): number | undefined {
  if (targetState.notificationRecipients !== undefined) {
    if (actionType === 'notify_assignee') {
      return targetState.notificationRecipients.assigneeUserId ?? undefined;
    }

    if (actionType === 'notify_manager') {
      return targetState.notificationRecipients.managerUserId ?? undefined;
    }

    if (actionType === 'notify_department_head') {
      return targetState.notificationRecipients.departmentHeadUserId ?? undefined;
    }
  }

  if (actionType === 'notify_manager') {
    return targetState.responsibleUserIds[0];
  }

  return targetState.responsibleUserIds[0];
}

function buildNotificationIdempotencyKey(input: {
  deadlineEventId: string;
  actionType: string;
  userId: number;
}): string {
  return `deadline-notification:${input.deadlineEventId}:${input.actionType}:${input.userId}`;
}

function buildNotificationText(event: DeadlineEventDto): {
  title: string;
  message: string;
  level: 'info' | 'warning' | 'error';
} {
  const entityLabel = event.orderId ? `Order ${event.orderId}` : `${event.entityType} ${event.entityId}`;
  const deadlineAt = event.deadlineAt ?? 'unknown deadline time';

  if (event.eventType === 'DEADLINE_EXPIRED') {
    return {
      title: 'Deadline expired',
      message: `${entityLabel} deadline expired at ${deadlineAt}`,
      level: event.severity === 'critical' ? 'error' : 'warning',
    };
  }

  return {
    title: 'Deadline event',
    message: `${entityLabel} deadline event ${event.eventType} at ${deadlineAt}`,
    level: event.severity === 'critical' ? 'error' : event.severity === 'warning' ? 'warning' : 'info',
  };
}

function buildEscalationNotificationText(event: DeadlineEventDto): {
  title: string;
  message: string;
  level: 'info' | 'warning' | 'error';
} {
  const entityLabel = event.orderId ? `Order ${event.orderId}` : `${event.entityType} ${event.entityId}`;
  const deadlineAt = event.deadlineAt ?? 'unknown deadline time';

  return {
    title: 'Deadline escalation',
    message: `${entityLabel} deadline escalated after missing ${deadlineAt}`,
    level: event.severity === 'critical' ? 'error' : 'warning',
  };
}

function createExecutionInput(
  event: DeadlineEventDto,
  rule: DeadlineActionRuleDto,
  ruleConfigSnapshot: DeadlineRuleConfigSnapshotDto = buildRuleConfigSnapshot(rule),
  sourceOrderStatusId: number | null = null,
): CreateActionExecutionInput {
  const targetType = event.entityType;
  const targetId = event.entityId;
  const targetStatusId = getActionTargetStatusId(rule);

  return {
    deadlineEventId: event.deadlineEventId,
    actionRuleId: rule.actionRuleId,
    actionType: rule.actionType,
    targetType,
    targetId,
    ruleConfigSnapshot,
    orderId: event.orderId ?? null,
    targetStatusId,
    idempotencyKey: buildDeadlineActionIdempotencyKey({
      deadlineEventId: event.deadlineEventId,
      actionType: rule.actionType,
      targetType,
      targetId,
      orderId: event.orderId ?? null,
      sourceOrderStatusId,
      actionRuleId: rule.actionRuleId,
      targetStatusId,
      snapshotHash: ruleConfigSnapshot.snapshotHash,
    }),
    status: 'skipped',
  };
}

function getActionTargetStatusId(rule: DeadlineActionRuleDto): number | null {
  if (rule.actionType === 'change_production_status') {
    return rule.config?.actionConfig?.targetProductionStatusId ?? null;
  }

  return rule.config?.actionConfig?.targetOrderStatusId ?? null;
}

function resolveEventOrderId(event: DeadlineEventDto): number | null {
  if (event.orderId) {
    return event.orderId;
  }

  if (event.entityType !== 'order') {
    return null;
  }

  const parsed = Number(event.entityId);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getEventFixtureKey(event: DeadlineEventDto): string | null {
  const fixtureKey = event.payload?.fixtureKey;

  return typeof fixtureKey === 'string' && fixtureKey.trim() !== '' ? fixtureKey : null;
}

/**
 * `true` only if `rule.config.conditions` has at least one key that actually
 * narrows execution — used as a fetch-cost gate for set_overdue_flag /
 * change_production_status (change_order_status always needs orderContext
 * regardless, see the caller). MUST stay in sync with the `hasConditions`
 * check inside `getMutatingActionConditionSkipReason`
 * (deadline-action-evaluator.ts, Task 3) — both treat
 * `requireCurrentDeadlineEvent: false` as NOT a gating condition (a rule with
 * only that key configured is equivalent to a rule with empty `conditions`).
 */
function hasGatingConditions(rule: DeadlineActionRuleDto): boolean {
  const conditions = rule.config?.conditions;
  if (!conditions) return false;
  return Boolean(
    conditions.excludeCompletedOrders === true
    || (conditions.allowedFromOrderStatusIds?.length ?? 0) > 0
    || (conditions.excludeOrderStatusIds?.length ?? 0) > 0
    || conditions.requireCurrentDeadlineEvent === true,
  );
}

function getEventRequestId(event: DeadlineEventDto): string | undefined {
  const requestId = event.payload?.requestId;

  return typeof requestId === 'string' && requestId.trim() !== '' ? requestId : undefined;
}

function mapStatusActionError(error: unknown): {
  status: 'skipped' | 'failed';
  skipReason?: string | null;
  errorCode?: string | null;
} {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'VALIDATION_ERROR'
  ) {
    return {
      status: 'skipped',
      skipReason: 'invalid_target_status',
      errorCode: 'invalid_target_status',
    };
  }

  return {
    status: 'failed',
    skipReason: null,
    errorCode: error instanceof Error ? error.name : 'unexpected_error',
  };
}

function mapProductionStatusActionError(error: unknown): {
  status: 'skipped' | 'failed';
  skipReason?: string | null;
  errorCode?: string | null;
} {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'VALIDATION_ERROR'
  ) {
    return {
      status: 'skipped',
      skipReason: 'invalid_target_production_status',
      errorCode: 'invalid_target_production_status',
    };
  }

  return {
    status: 'failed',
    skipReason: null,
    errorCode: error instanceof Error ? error.name : 'unexpected_error',
  };
}
