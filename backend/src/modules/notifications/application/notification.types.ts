import type { CurrentUser } from '../../../permissions/current-user';

/** Балун уведомления: `mandatory` — обязательный (только крестиком, без срока; выдаётся заявившим его клиентам). */
export type NotificationBalloonMode = 'auto' | 'persistent' | 'mandatory';

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
  /**
   * Балун на момент записи: NULL — без балуна, `auto` — исчезает через 15 с, `persistent` — только крестиком,
   * `mandatory` — обязательный (только крестиком, клик по телу не закрывает, без срока выдачи).
   */
  balloonMode: NotificationBalloonMode | null;
  /** Обязательный балун ещё не показан: строку нельзя удалить (409), колокольчик прячет удаление. */
  balloonPending: boolean;
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
  /** `balloon_pending` — обязательный балун строки ещё не показан, строка не удалена. */
  deleteForUser(input: { notificationId: string; viewer: NotificationViewer }): Promise<'deleted' | 'not_found' | 'balloon_pending'>;
  /**
   * Аренда непоказанных балунов вкладкой (план 2026-10-03 §3.2): свои незавершённые — первыми. Обязательные
   * (`mandatory`) — только клиенту, заявившему эту возможность (`mandatory: true`), без срока и независимо от прочтения.
   */
  claimBalloonsForUser(input: { viewer: NotificationViewer; token: string; limit: number; mandatory: boolean }): Promise<NotificationDto[]>;
  /** Подтверждение показа своих арендованных балунов; повтор — no-op. */
  ackBalloonsForUser(input: { viewer: NotificationViewer; token: string; notificationIds: string[] }): Promise<number>;
}
