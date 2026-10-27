import { BALLOON_CAPABILITIES, BALLOON_CAPABILITIES_HEADER } from '../notifications/balloons/balloonCenterModel';
import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';
import type {
  AckBalloonsResponse,
  ClaimBalloonsResponse,
  DeleteNotificationResponse,
  MarkAllNotificationsReadResponse,
  NotificationListQuery,
  NotificationListResponse,
  NotificationResponse,
} from './types/notificationApi.types';

export const notificationsApi = {
  list(params: NotificationListQuery = {}): Promise<NotificationListResponse> {
    return httpClient.get<NotificationListResponse>(withQuery(apiRoutes.notifications.list, params));
  },

  markRead(notificationId: string): Promise<NotificationResponse> {
    return httpClient.patch<NotificationResponse>(
      apiRoutes.notifications.read(validateNotificationId(notificationId)),
    );
  },

  /**
   * Аренда непоказанных балунов вкладкой (план 2026-10-03 §3.2). Заголовок заявляет поддержку обязательных балунов
   * (план 2026-10-19 §2.7): только такой вкладке backend их выдаёт; тело запроса прежнее — старый backend не ломается.
   */
  claimBalloons(body: { token: string; limit: number }): Promise<ClaimBalloonsResponse> {
    return httpClient.post<ClaimBalloonsResponse>(apiRoutes.notifications.balloonsClaim, body, {
      headers: { [BALLOON_CAPABILITIES_HEADER]: BALLOON_CAPABILITIES },
    });
  },

  /** Подтверждение показа арендованных балунов. */
  ackBalloons(body: { token: string; notificationIds: string[] }): Promise<AckBalloonsResponse> {
    return httpClient.post<AckBalloonsResponse>(apiRoutes.notifications.balloonsAck, body);
  },

  /** Только перечисленные уведомления — те, что пользователь видит в списке. */
  markAllRead(notificationIds: string[]): Promise<MarkAllNotificationsReadResponse> {
    return httpClient.patch<MarkAllNotificationsReadResponse>(apiRoutes.notifications.readAll, {
      notificationIds: notificationIds.map(validateNotificationId),
    });
  },

  delete(notificationId: string): Promise<DeleteNotificationResponse> {
    return httpClient.request<DeleteNotificationResponse>(
      apiRoutes.notifications.byId(validateNotificationId(notificationId)),
      { method: 'DELETE' },
    );
  },
};

export function validateNotificationId(notificationId: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      notificationId,
    )
  ) {
    throw new Error('Invalid notificationId');
  }

  return notificationId;
}
