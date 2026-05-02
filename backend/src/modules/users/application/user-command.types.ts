import type { CurrentUser } from '../../../permissions/current-user';
import type { UserRole } from '../../../permissions/permissions';
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

export interface CreateUserCommand {
  currentUser: CurrentUser;
  dto: CreateUserRequestDto;
  requestId?: string;
}

export interface UpdateUserCommand {
  currentUser: CurrentUser;
  userId: number;
  dto: UpdateUserRequestDto;
  requestId?: string;
}

export interface ChangeUserPasswordCommand {
  currentUser: CurrentUser;
  userId: number;
  dto: ChangePasswordRequestDto;
  requestId?: string;
}

export interface UserActivationCommand {
  currentUser: CurrentUser;
  userId: number;
  requestId?: string;
}

export interface UserRepositoryPort {
  listUsers(command: ListUsersCommand): Promise<UserListResponseDto>;
  getUserById(command: GetUserByIdCommand): Promise<UserDto | null>;
  createUser(command: CreateUserCommand): Promise<UserDto>;
  updateUser(command: UpdateUserCommand): Promise<UserDto>;
  changePassword(command: ChangeUserPasswordCommand): Promise<ChangePasswordResponseDto>;
  deactivateUser(command: UserActivationCommand): Promise<UserDto>;
  activateUser(command: UserActivationCommand): Promise<UserDto>;
}
