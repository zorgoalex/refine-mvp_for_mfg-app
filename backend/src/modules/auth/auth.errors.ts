import { ApiError } from '../../common/errors/api-error';

export class InvalidCredentialsError extends ApiError {
  constructor() {
    super(401, 'INVALID_CREDENTIALS', 'Неверное имя пользователя или пароль');
  }
}

export class UserInactiveError extends ApiError {
  constructor() {
    super(403, 'USER_INACTIVE', 'Пользователь отключён');
  }
}

export class UnknownRoleError extends ApiError {
  constructor(roleId: number) {
    super(500, 'UNKNOWN_ROLE', 'User role is not supported by backend', { roleId });
  }
}
