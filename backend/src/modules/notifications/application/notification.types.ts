import type { CurrentUser } from '../../../permissions/current-user';

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

/**
 * Читатель уведомлений: владелец строк (`id`) и его ТЕКУЩИЕ права/scope — уведомления закупа фильтруются по ним
 * при каждом чтении (§5.7 R5-1), остальные — только по владельцу, как раньше.
 */
export type NotificationViewer = CurrentUser;

export interface NotificationRepositoryPort {
  listForUser(input: {
    viewer: NotificationViewer;
    unreadOnly: boolean;
    page: number;
    pageSize: number;
  }): Promise<NotificationListResult>;
  markReadForUser(input: {
    notificationId: string;
    viewer: NotificationViewer;
  }): Promise<NotificationDto | null>;
  markAllReadForUser(viewer: NotificationViewer): Promise<number>;
  deleteForUser(input: { notificationId: string; viewer: NotificationViewer }): Promise<boolean>;
}
