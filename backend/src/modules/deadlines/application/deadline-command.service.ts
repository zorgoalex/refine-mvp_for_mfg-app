import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import { getDeadlineOrderOverrideTarget } from '../dto/deadline-action-rule.dto';
import { isTerminalDeadlineStatus } from '../domain/deadline-status';
import { DeadlineInvalidStatusTransitionError, DeadlineNotFoundError } from '../errors/deadline.errors';
import type {
  CancelDeadlineCommand,
  CreateDeadlineCommand,
  CreateDeadlinePolicyCommand,
  DeadlineTransactionManagerPort,
  OverrideDeadlineCommand,
  PauseDeadlineCommand,
  ResumeDeadlineCommand,
  RetireDeadlineOrderOverrideCommand,
  UpdateDeadlinePolicyCommand,
  UpdateGlobalTransitionRuleCommand,
  UpdateDeadlineSettingsCommand,
  UpsertDeadlineOrderOverrideCommand,
} from './deadline.types';

export interface DeadlineCommandServicePorts {
  transactions: DeadlineTransactionManagerPort;
  permissions?: PermissionsService;
}

export class DeadlineCommandService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: DeadlineCommandServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async create(command: CreateDeadlineCommand) {
    this.requirePermission(command, 'deadlines.manage');
    return this.ports.transactions.runInTransaction((unitOfWork) =>
      unitOfWork.deadlines.createDeadlineInstance(command),
    );
  }

  async override(command: OverrideDeadlineCommand) {
    this.requirePermission(command, 'deadlines.override');

    return this.ports.transactions.runInTransaction(async (unitOfWork) => {
      const deadline = await unitOfWork.deadlines.getDeadlineByIdForUpdate(command.deadlineId);
      if (!deadline) {
        throw new DeadlineNotFoundError(command.deadlineId);
      }
      if (deadline.status === 'superseded' && command.requestId) {
        return unitOfWork.deadlines.overrideDeadline(command);
      }
      assertMutableDeadline(deadline.status, command.deadlineId);

      return unitOfWork.deadlines.overrideDeadline(command);
    });
  }

  async pause(command: PauseDeadlineCommand) {
    this.requirePermission(command, 'deadlines.pause');

    return this.ports.transactions.runInTransaction(async (unitOfWork) => {
      const deadline = await unitOfWork.deadlines.getDeadlineByIdForUpdate(command.deadlineId);
      if (!deadline) {
        throw new DeadlineNotFoundError(command.deadlineId);
      }
      if (deadline.status !== 'active') {
        throw new DeadlineInvalidStatusTransitionError({
          deadlineId: command.deadlineId,
          fromStatus: deadline.status,
          toStatus: 'paused',
        });
      }

      return unitOfWork.deadlines.pauseDeadline(command);
    });
  }

  async resume(command: ResumeDeadlineCommand) {
    this.requirePermission(command, 'deadlines.pause');

    return this.ports.transactions.runInTransaction(async (unitOfWork) => {
      const deadline = await unitOfWork.deadlines.getDeadlineByIdForUpdate(command.deadlineId);
      if (!deadline) {
        throw new DeadlineNotFoundError(command.deadlineId);
      }
      if (deadline.status !== 'paused') {
        throw new DeadlineInvalidStatusTransitionError({
          deadlineId: command.deadlineId,
          fromStatus: deadline.status,
          toStatus: 'active',
        });
      }

      return unitOfWork.deadlines.resumeDeadline(command);
    });
  }

  async cancel(command: CancelDeadlineCommand) {
    this.requirePermission(command, 'deadlines.cancel');

    return this.ports.transactions.runInTransaction(async (unitOfWork) => {
      const deadline = await unitOfWork.deadlines.getDeadlineByIdForUpdate(command.deadlineId);
      if (!deadline) {
        throw new DeadlineNotFoundError(command.deadlineId);
      }
      assertMutableDeadline(deadline.status, command.deadlineId);

      return unitOfWork.deadlines.cancelDeadline(command);
    });
  }

  async createPolicy(command: CreateDeadlinePolicyCommand) {
    this.requirePermission(command, 'deadlines.manage');
    return this.ports.transactions.runInTransaction((unitOfWork) =>
      unitOfWork.deadlines.createPolicy(command),
    );
  }

  async updatePolicy(command: UpdateDeadlinePolicyCommand) {
    this.requirePermission(command, 'deadlines.manage');
    return this.ports.transactions.runInTransaction((unitOfWork) =>
      unitOfWork.deadlines.updatePolicy(command),
    );
  }

  async updateSettings(command: UpdateDeadlineSettingsCommand) {
    this.requirePermission(command, 'settings.manage');
    return this.ports.transactions.runInTransaction((unitOfWork) =>
      unitOfWork.deadlines.updateSettings(command),
    );
  }

  async upsertOrderOverride(command: Omit<UpsertDeadlineOrderOverrideCommand, 'audit'>) {
    this.requirePermission(command, 'deadlines.manage_order_overrides');
    const target = getDeadlineOrderOverrideTarget(command.dto);

    return this.ports.transactions.runInTransaction(async (unitOfWork) => ({
      override: await unitOfWork.deadlines.upsertOrderOverride({
        ...command,
        audit: {
          event: 'deadline.order_override_updated',
          source: 'admin-ui',
          actorUserId: command.currentUser.id,
          requestId: command.requestId ?? null,
          timerRuleId: target.targetType === 'policy' ? target.targetId : null,
          actionRuleId: target.targetType === 'action_rule' ? target.targetId : null,
          orderId: command.dto.orderId,
          before: {},
          after: {
            targetType: target.targetType,
            targetId: target.targetId,
            isDisabled: command.dto.isDisabled ?? false,
            overrideConfig: command.dto.overrideConfig ?? {},
          },
          diff: {},
          reason: command.dto.reason,
          comment: null,
          executionEvidence: null,
        },
      }),
    }));
  }

  async retireOrderOverride(command: Omit<RetireDeadlineOrderOverrideCommand, 'audit'>) {
    this.requirePermission(command, 'deadlines.manage_order_overrides');

    return this.ports.transactions.runInTransaction(async (unitOfWork) => ({
      override: await unitOfWork.deadlines.retireOrderOverride({
        ...command,
        audit: {
          event: 'deadline.order_override_removed',
          source: 'admin-ui',
          actorUserId: command.currentUser.id,
          requestId: command.requestId ?? null,
          timerRuleId: null,
          actionRuleId: null,
          orderId: command.orderId,
          before: {},
          after: { retired: true },
          diff: { retiredAt: { from: null, to: 'now' } },
          reason: command.reason,
          comment: null,
          executionEvidence: null,
        },
      }),
    }));
  }

  async updateGlobalTransitionRule(command: Omit<UpdateGlobalTransitionRuleCommand, 'audit'>) {
    this.requirePermission(command, 'deadlines.actions.manage');

    return this.ports.transactions.runInTransaction(async (unitOfWork) => ({
      rule: await unitOfWork.deadlines.updateGlobalTransitionRule({
        ...command,
        audit: {
          event: 'deadline.action_rule_updated',
          source: 'admin-ui',
          actorUserId: command.currentUser.id,
          requestId: command.requestId ?? null,
          timerRuleId: null,
          actionRuleId: command.actionRuleId,
          orderId: null,
          before: {},
          after: command.dto as unknown as Record<string, unknown>,
          diff: {},
          reason: command.dto.reason,
          comment: command.dto.comment ?? null,
          executionEvidence: null,
        },
      }),
    }));
  }

  private requirePermission(command: { currentUser: CurrentUser }, permission: PermissionName): void {
    if (!this.permissions.canUser(command.currentUser, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }

  private requireAnyPermission(
    command: { currentUser: CurrentUser },
    permissions: PermissionName[],
  ): void {
    if (!permissions.some((permission) => this.permissions.canUser(command.currentUser, permission))) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: permissions,
      });
    }
  }
}

function assertMutableDeadline(status: string, deadlineId: string): void {
  if (isTerminalDeadlineStatus(status as Parameters<typeof isTerminalDeadlineStatus>[0])) {
    throw new DeadlineInvalidStatusTransitionError({
      deadlineId,
      fromStatus: status,
    });
  }
}
