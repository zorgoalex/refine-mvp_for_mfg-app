import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';
import type {
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

  markAllRead(): Promise<MarkAllNotificationsReadResponse> {
    return httpClient.patch<MarkAllNotificationsReadResponse>(apiRoutes.notifications.readAll);
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
