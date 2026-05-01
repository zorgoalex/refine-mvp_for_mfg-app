import { ApiError } from '../../../common/errors/api-error';

export class UserNotFoundError extends ApiError {
  constructor(userId: number) {
    super(404, 'USER_NOT_FOUND', 'User not found', { userId });
  }
}
