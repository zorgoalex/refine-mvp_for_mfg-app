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
}

export interface GetUserByIdCommand {
  currentUser: CurrentUser;
  userId: number;
}

export interface CreateUserCommand {
  currentUser: CurrentUser;
  dto: CreateUserRequestDto;
}

export interface UpdateUserCommand {
  currentUser: CurrentUser;
  userId: number;
  dto: UpdateUserRequestDto;
}

export interface ChangeUserPasswordCommand {
  currentUser: CurrentUser;
  userId: number;
  dto: ChangePasswordRequestDto;
}

export interface UserActivationCommand {
  currentUser: CurrentUser;
  userId: number;
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
