export type NotificationLevel = 'info' | 'warning' | 'error';

export interface BackendNotificationDto {
  notificationId: string;
  userId: string;
  level: NotificationLevel;
  title: string | null;
  message: string;
  entityType: string | null;
  entityId: string | null;
  sourceType: string | null;
  sourceId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationListQuery {
  page?: number;
  pageSize?: number;
  unreadOnly?: boolean;
}

export interface NotificationListResponse {
  data: BackendNotificationDto[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  unreadCount: number;
}

export interface NotificationResponse {
  notification: BackendNotificationDto;
}

export interface MarkAllNotificationsReadResponse {
  updatedCount: number;
}

export interface DeleteNotificationResponse {
  notificationId: string;
  deleted: true;
}
