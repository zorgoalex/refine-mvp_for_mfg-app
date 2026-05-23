import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
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
  UpdateDeadlinePolicyCommand,
  UpdateDeadlineSettingsCommand,
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
      const deadline = await unitOfWork.deadlines.getDeadlineById(command.deadlineId);
      if (!deadline) {
        throw new DeadlineNotFoundError(command.deadlineId);
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
    this.requirePermission(command, 'deadlines.actions.manage');
    return this.ports.transactions.runInTransaction((unitOfWork) =>
      unitOfWork.deadlines.createPolicy(command),
    );
  }

  async updatePolicy(command: UpdateDeadlinePolicyCommand) {
    this.requirePermission(command, 'deadlines.actions.manage');
    return this.ports.transactions.runInTransaction((unitOfWork) =>
      unitOfWork.deadlines.updatePolicy(command),
    );
  }

  async updateSettings(command: UpdateDeadlineSettingsCommand) {
    this.requirePermission(command, 'deadlines.actions.manage');
    return this.ports.transactions.runInTransaction((unitOfWork) =>
      unitOfWork.deadlines.updateSettings(command),
    );
  }

  private requirePermission(command: { currentUser: CurrentUser }, permission: PermissionName): void {
    if (!this.permissions.canUser(command.currentUser, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
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
