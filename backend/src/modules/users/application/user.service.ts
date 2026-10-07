import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import { PermissionsService } from '../../../permissions/permissions.service';
import { UserAccessPolicy } from '../../../permissions/policies/user-access.policy';
import { ACCOUNT_ESCALATION_DENIED } from '../../../permissions/account-escalation';
import type { TargetUserSubject } from '../../../permissions/policies/user-access.policy';
import type {
  ChangePasswordResponseDto,
  UserDto,
  UserListResponseDto,
} from '../dto/user.dto';
import { UserNotFoundError } from '../errors/user.errors';
import type {
  ChangeUserPasswordCommand,
  CreateUserCommand,
  GetUserByIdCommand,
  ListUsersCommand,
  UpdateUserCommand,
  UserActivationCommand,
  UserRepositoryPort,
} from './user-command.types';
import { buildUserDeniedEvent } from './users-audit';

const DEFAULT_REQUEST_ID = 'users-adapter';

export interface UserServicePorts {
  users: UserRepositoryPort;
  database: DatabaseService;
  permissions?: PermissionsService;
  policy?: UserAccessPolicy;
}

export class UserService {
  private readonly permissions: PermissionsService;
  private readonly policy: UserAccessPolicy;

  constructor(private readonly ports: UserServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
    this.policy = ports.policy ?? new UserAccessPolicy();
  }

  async list(command: ListUsersCommand): Promise<UserListResponseDto> {
    this.requirePermission(command.currentUser, 'users.view');
    return this.ports.users.listUsers(command);
  }

  async getById(command: GetUserByIdCommand): Promise<UserDto> {
    this.requirePermission(command.currentUser, 'users.view');

    const user = await this.ports.users.getUserById(command);
    if (!user) {
      throw new UserNotFoundError(command.userId);
    }

    return user;
  }

  async create(command: CreateUserCommand): Promise<UserDto> {
    const reason = this.policy.canCreateUser(command.currentUser, command.dto.role);
    if (reason) {
      if (reason !== 'missing_permission') {
        try {
          await auditService.recordDenied(this.ports.database, buildUserDeniedEvent({
            actor: command.currentUser,
            requestId: command.requestId ?? DEFAULT_REQUEST_ID,
            action: 'create',
            targetUserId: null,
            reason,
          }));
        } catch { /* best-effort */ }
      }
      throw permissionDenied('users.create');
    }

    try {
      return await this.ports.users.createUser(command);
    } catch (error) {
      if (error instanceof ApiError && error.code === ACCOUNT_ESCALATION_DENIED) {
        try {
          await auditService.recordDenied(this.ports.database, buildUserDeniedEvent({
            actor: command.currentUser,
            requestId: command.requestId ?? DEFAULT_REQUEST_ID,
            action: 'create',
            targetUserId: null,
            reason: 'privilege_escalation_denied',
          }));
        } catch { /* best-effort */ }
      }
      throw error;
    }
  }

  async update(command: UpdateUserCommand): Promise<UserDto> {
    const targetUser = await this.getTargetUser(command);

    const reason = this.policy.canUpdateUser(command.currentUser, targetUser, command.dto.role);
    if (reason) {
      if (reason !== 'missing_permission') {
        try {
          await auditService.recordDenied(this.ports.database, buildUserDeniedEvent({
            actor: command.currentUser,
            requestId: command.requestId ?? DEFAULT_REQUEST_ID,
            action: 'update',
            targetUserId: targetUser.id,
            reason,
          }));
        } catch { /* best-effort */ }
      }
      throw permissionDenied('users.update');
    }

    return this.guardTargetRole('update', command, () =>
      this.ports.users.updateUser({ ...command, expectedTargetRole: targetUser.role }));
  }

  async changePassword(command: ChangeUserPasswordCommand): Promise<ChangePasswordResponseDto> {
    const targetUser = await this.getTargetUser(command);

    const reason = this.policy.canChangePassword(command.currentUser, targetUser);
    if (reason) {
      if (reason !== 'missing_permission') {
        try {
          await auditService.recordDenied(this.ports.database, buildUserDeniedEvent({
            actor: command.currentUser,
            requestId: command.requestId ?? DEFAULT_REQUEST_ID,
            action: 'change_password',
            targetUserId: targetUser.id,
            reason,
          }));
        } catch { /* best-effort */ }
      }
      throw permissionDenied('users.change_password');
    }

    return this.guardTargetRole('change_password', command, () =>
      this.ports.users.changePassword({ ...command, expectedTargetRole: targetUser.role }));
  }

  async deactivate(command: UserActivationCommand): Promise<UserDto> {
    const targetUser = await this.getTargetUser(command);

    const reason = this.policy.canDeactivate(command.currentUser, targetUser);
    if (reason) {
      if (reason !== 'missing_permission') {
        try {
          await auditService.recordDenied(this.ports.database, buildUserDeniedEvent({
            actor: command.currentUser,
            requestId: command.requestId ?? DEFAULT_REQUEST_ID,
            action: 'deactivate',
            targetUserId: targetUser.id,
            reason,
          }));
        } catch { /* best-effort */ }
      }
      throw permissionDenied('users.deactivate');
    }

    return this.guardTargetRole('deactivate', command, () =>
      this.ports.users.deactivateUser({ ...command, expectedTargetRole: targetUser.role }));
  }

  async activate(command: UserActivationCommand): Promise<UserDto> {
    const targetUser = await this.getTargetUser(command);

    const reason = this.policy.canActivate(command.currentUser, targetUser);
    if (reason) {
      if (reason !== 'missing_permission') {
        try {
          await auditService.recordDenied(this.ports.database, buildUserDeniedEvent({
            actor: command.currentUser,
            requestId: command.requestId ?? DEFAULT_REQUEST_ID,
            action: 'activate',
            targetUserId: targetUser.id,
            reason,
          }));
        } catch { /* best-effort */ }
      }
      throw permissionDenied('users.activate');
    }

    return this.guardTargetRole('activate', command, () =>
      this.ports.users.activateUser({ ...command, expectedTargetRole: targetUser.role }));
  }

  /**
   * The repository applies the mutation only while the target still has the role the policy decided on. A concurrent
   * role change (409 USER_ROLE_CHANGED) is recorded as a denied attempt: nothing was changed.
   */
  private async guardTargetRole<T>(
    action: 'update' | 'change_password' | 'deactivate' | 'activate',
    command: { currentUser: UpdateUserCommand['currentUser']; userId: number; requestId?: string },
    mutate: () => Promise<T>,
  ): Promise<T> {
    try {
      return await mutate();
    } catch (error) {
      const reason = error instanceof ApiError && error.code === 'USER_ROLE_CHANGED'
        ? 'target_role_changed' as const
        : error instanceof ApiError && error.code === ACCOUNT_ESCALATION_DENIED
          ? 'privilege_escalation_denied' as const
          : null;
      if (reason) {
        try {
          await auditService.recordDenied(this.ports.database, buildUserDeniedEvent({
            actor: command.currentUser,
            requestId: command.requestId ?? DEFAULT_REQUEST_ID,
            action,
            targetUserId: String(command.userId),
            reason,
          }));
        } catch { /* best-effort */ }
      }
      throw error;
    }
  }

  private async getTargetUser(
    command: Pick<GetUserByIdCommand, 'currentUser' | 'userId'>,
  ): Promise<TargetUserSubject> {
    const user = await this.ports.users.getUserById(command);
    if (!user) {
      throw new UserNotFoundError(command.userId);
    }

    return {
      id: String(user.id),
      role: user.role,
    };
  }

  private requirePermission(
    currentUser: ListUsersCommand['currentUser'],
    permission: Parameters<PermissionsService['canUser']>[1],
  ): void {
    if (!this.permissions.canUser(currentUser, permission)) {
      throw permissionDenied(permission);
    }
  }
}

function permissionDenied(permission: string): ApiError {
  return new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
    requiredPermissions: [permission],
  });
}
