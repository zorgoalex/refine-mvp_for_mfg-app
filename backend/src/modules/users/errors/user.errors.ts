import { ApiError } from '../../../common/errors/api-error';

export class UserNotFoundError extends ApiError {
  constructor(userId: number) {
    super(404, 'USER_NOT_FOUND', 'User not found', { userId });
  }
}

export class UserAlreadyExistsError extends ApiError {
  constructor(field: 'username' | 'email') {
    super(409, 'USER_ALREADY_EXISTS', `User with this ${field} already exists`, { field });
  }
}
