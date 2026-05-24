import type {
  NotificationDto,
  NotificationListResponse,
} from '../application/notification.types';

export type BackendNotificationDto = NotificationDto;
export type NotificationListResponseDto = NotificationListResponse;

export interface NotificationResponseDto {
  notification: NotificationDto;
}

export interface MarkAllNotificationsReadResponseDto {
  updatedCount: number;
}

export interface DeleteNotificationResponseDto {
  notificationId: string;
  deleted: true;
}
