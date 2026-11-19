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
  /** Балун на момент записи; нет (старый backend) или null — без балуна; `mandatory` — обязательный (только крестиком). */
  balloonMode?: 'auto' | 'persistent' | 'mandatory' | null;
  /** Обязательный балун ещё не показан — удалить строку нельзя (backend ответит 409). Нет у старого backend. */
  balloonPending?: boolean;
  /** Слот балуна: открытый балун того же слота закрывается при показе этого (свежего). Нет у старого backend. */
  balloonSlot?: string | null;
}

export interface ClaimBalloonsResponse {
  items: BackendNotificationDto[];
  /** Из переданных openNotificationIds — заменённые свежим балуном того же слота. Нет у старого backend. */
  superseded?: string[];
}

export interface AckBalloonsResponse {
  acknowledged: number;
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
