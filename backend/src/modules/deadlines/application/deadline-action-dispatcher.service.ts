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
