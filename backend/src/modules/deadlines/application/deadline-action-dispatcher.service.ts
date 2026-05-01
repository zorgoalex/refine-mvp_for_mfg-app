import type { DeadlineActionRuleDto } from '../dto/deadline-action-rule.dto';
import type { DeadlineEventDto } from '../dto/deadline-instance.dto';
import { isNotificationAction } from '../domain/deadline-actions';
import { buildDeadlineActionIdempotencyKey } from '../domain/deadline-idempotency';
import type {
  CreateActionExecutionInput,
  DeadlineNotificationPort,
  DeadlineRepositoryPort,
  DeadlineTargetResolverPort,
} from './deadline.types';

export interface DeadlineActionDispatcherConfig {
  actionsEnabled: boolean;
  notificationsEnabled: boolean;
}

export interface DispatchDeadlineActionsCommand {
  event: DeadlineEventDto;
  repository: DeadlineRepositoryPort;
  targetResolver: DeadlineTargetResolverPort;
  notificationPort: DeadlineNotificationPort;
  config: DeadlineActionDispatcherConfig;
}

export class DeadlineActionDispatcherService {
  async dispatch(command: DispatchDeadlineActionsCommand) {
    const rules = await command.repository.listActionRules({
      scopeType: command.event.entityType,
      eventType: command.event.eventType,
    });

    const executions = [];
    for (const rule of rules) {
      executions.push(await this.dispatchRule(command, rule));
    }

    return executions;
  }

  private async dispatchRule(
    command: DispatchDeadlineActionsCommand,
    rule: DeadlineActionRuleDto,
  ) {
    const baseExecution = createExecutionInput(command.event, rule);

    if (!rule.isEnabled) {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: 'action_disabled',
      });
    }

    if (!command.config.actionsEnabled) {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: 'global_actions_disabled',
      });
    }

    if (isNotificationAction(rule.actionType) && !command.config.notificationsEnabled) {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: 'notifications_disabled',
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

    return command.repository.createActionExecution({
      ...baseExecution,
      status: 'skipped',
      skipReason: 'action_handler_unavailable',
    });
  }

  private async dispatchNotification(
    command: DispatchDeadlineActionsCommand,
    rule: DeadlineActionRuleDto,
    baseExecution: CreateActionExecutionInput,
  ) {
    const responsibleUsers = await command.targetResolver.resolveTargetState({
      entityType: command.event.entityType,
      entityId: command.event.entityId,
      orderId: command.event.orderId,
      orderWorkshopId: command.event.orderWorkshopId,
      clientId: command.event.clientId,
    });
    const userId = responsibleUsers.responsibleUserIds[0];

    if (!userId) {
      return command.repository.createActionExecution({
        ...baseExecution,
        status: 'skipped',
        skipReason: 'notification_target_missing',
      });
    }

    try {
      await command.notificationPort.createNotification({
        userId,
        level: command.event.severity === 'critical' ? 'error' : 'warning',
        title: 'Deadline event',
        message: command.event.eventType,
        entityType: command.event.entityType,
        entityId: command.event.entityId,
        sourceType: 'deadline',
        sourceId: command.event.deadlineEventId,
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
      result: { notificationUserId: userId, actionType: rule.actionType },
    });
  }
}

function createExecutionInput(
  event: DeadlineEventDto,
  rule: DeadlineActionRuleDto,
): CreateActionExecutionInput {
  const targetType = event.entityType;
  const targetId = event.entityId;

  return {
    deadlineEventId: event.deadlineEventId,
    actionRuleId: rule.actionRuleId,
    actionType: rule.actionType,
    targetType,
    targetId,
    idempotencyKey: buildDeadlineActionIdempotencyKey({
      deadlineEventId: event.deadlineEventId,
      actionType: rule.actionType,
      targetType,
      targetId,
    }),
    status: 'skipped',
  };
}
