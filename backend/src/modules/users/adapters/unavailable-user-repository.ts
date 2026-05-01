import { ApiError } from '../../../common/errors/api-error';
import type {
  ChangeUserPasswordCommand,
  CreateUserCommand,
  GetUserByIdCommand,
  ListUsersCommand,
  UpdateUserCommand,
  UserActivationCommand,
  UserRepositoryPort,
} from '../application/user-command.types';
import type {
  ChangePasswordResponseDto,
  UserDto,
  UserListResponseDto,
} from '../dto/user.dto';

export class UnavailableUserRepository implements UserRepositoryPort {
  async listUsers(_command: ListUsersCommand): Promise<UserListResponseDto> {
    throw unavailableUsersAdapterError();
  }

  async getUserById(_command: GetUserByIdCommand): Promise<UserDto | null> {
    throw unavailableUsersAdapterError();
  }

  async createUser(_command: CreateUserCommand): Promise<UserDto> {
    throw unavailableUsersAdapterError();
  }

  async updateUser(_command: UpdateUserCommand): Promise<UserDto> {
    throw unavailableUsersAdapterError();
  }

  async changePassword(
    _command: ChangeUserPasswordCommand,
  ): Promise<ChangePasswordResponseDto> {
    throw unavailableUsersAdapterError();
  }

  async deactivateUser(_command: UserActivationCommand): Promise<UserDto> {
    throw unavailableUsersAdapterError();
  }

  async activateUser(_command: UserActivationCommand): Promise<UserDto> {
    throw unavailableUsersAdapterError();
  }
}

function unavailableUsersAdapterError(): ApiError {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'Users adapter is not configured', {
    feature: 'users',
    adapter: 'user_repository',
  });
}
