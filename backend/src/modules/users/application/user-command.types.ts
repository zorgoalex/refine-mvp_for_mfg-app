import type { CurrentUser } from '../../../permissions/current-user';
import type { UserRole } from '../../../permissions/permissions';
import type { TargetUserSubject, UserDenialReason } from '../../../permissions/policies/user-access.policy';
import type {
  ChangePasswordRequestDto,
  ChangePasswordResponseDto,
  CreateUserRequestDto,
  UpdateUserRequestDto,
  UserDto,
  UserListResponseDto,
} from '../dto/user.dto';

export interface UserListQuery {
  page: number;
  pageSize: number;
  search?: string;
  role?: UserRole;
  isActive?: boolean;
}

export interface ListUsersCommand {
  currentUser: CurrentUser;
  query: UserListQuery;
  requestId?: string;
}

export interface GetUserByIdCommand {
  currentUser: CurrentUser;
  userId: number;
  requestId?: string;
}

/**
 * Re-run of the command's access policy on the actor read inside the command transaction, after the authorization
 * lock (access groups plan §5.1 step 3): an administrator who lost the right while waiting gets 403. `target` is the
 * locked target row (null for creation).
 */
export type UserCommandRecheck = (actor: CurrentUser, target: TargetUserSubject | null) => UserDenialReason | null;

/** Transitional command protocol (§5.3): both optional, old clients without them behave as before. */
export interface UserCommandProtocol {
  /** Idempotency-Key header: a repeat with the same payload returns the stored response without new effects. */
  idempotencyKey?: string;
  /** users.row_version the client's form was built on; a different current version answers 409. */
  expectedVersion?: number;
  recheck?: UserCommandRecheck;
}

export interface CreateUserCommand extends UserCommandProtocol {
  currentUser: CurrentUser;
  dto: CreateUserRequestDto;
  requestId?: string;
}

/**
 * `expectedTargetRole` — the role the access policy decided on. The mutation applies only while the target still has
 * it (atomic precondition): a concurrent role change answers 409 USER_ROLE_CHANGED instead of acting on a stale check.
 */
export interface UpdateUserCommand extends UserCommandProtocol {
  currentUser: CurrentUser;
  userId: number;
  dto: UpdateUserRequestDto;
  requestId?: string;
  expectedTargetRole?: UserRole;
}

export interface ChangeUserPasswordCommand extends UserCommandProtocol {
  currentUser: CurrentUser;
  userId: number;
  dto: ChangePasswordRequestDto;
  requestId?: string;
  expectedTargetRole?: UserRole;
}

export interface UserActivationCommand extends UserCommandProtocol {
  currentUser: CurrentUser;
  userId: number;
  requestId?: string;
  expectedTargetRole?: UserRole;
}

export type UserCommandName = 'users.create' | 'users.update' | 'users.change_password' | 'users.activate' | 'users.deactivate';

export interface UserRepositoryPort {
  /** Stored response of a completed command with the same Idempotency-Key, actor and payload (null otherwise). */
  findCompletedReplay<T>(
    name: UserCommandName,
    command: CreateUserCommand | UpdateUserCommand | ChangeUserPasswordCommand | UserActivationCommand,
  ): Promise<T | null>;
  listUsers(command: ListUsersCommand): Promise<UserListResponseDto>;
  getUserById(command: GetUserByIdCommand): Promise<UserDto | null>;
  createUser(command: CreateUserCommand): Promise<UserDto>;
  updateUser(command: UpdateUserCommand): Promise<UserDto>;
  changePassword(command: ChangeUserPasswordCommand): Promise<ChangePasswordResponseDto>;
  deactivateUser(command: UserActivationCommand): Promise<UserDto>;
  activateUser(command: UserActivationCommand): Promise<UserDto>;
}
