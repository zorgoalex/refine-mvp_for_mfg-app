import { ApiError } from '../../../common/errors/api-error';

export function authRequired(): ApiError {
  return new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
}

export function invalidNotificationId(): ApiError {
  return new ApiError(400, 'INVALID_NOTIFICATION_ID', 'Invalid notificationId');
}

export function notificationNotFound(): ApiError {
  return new ApiError(404, 'NOTIFICATION_NOT_FOUND', 'Notification not found');
}
