export type NotificationLevel = 'info' | 'warning' | 'error';

export interface NotificationDto {
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
  page: number;
  pageSize: number;
  unreadOnly: boolean;
}

export interface NotificationListResult {
  data: NotificationDto[];
  total: number;
  unreadCount: number;
}

export interface NotificationListResponse {
  data: NotificationDto[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  unreadCount: number;
}

export interface NotificationRepositoryPort {
  listForUser(input: {
    userId: string;
    unreadOnly: boolean;
    page: number;
    pageSize: number;
  }): Promise<NotificationListResult>;
  markReadForUser(input: {
    notificationId: string;
    userId: string;
  }): Promise<NotificationDto | null>;
  markAllReadForUser(userId: string): Promise<number>;
  deleteForUser(input: { notificationId: string; userId: string }): Promise<boolean>;
}
