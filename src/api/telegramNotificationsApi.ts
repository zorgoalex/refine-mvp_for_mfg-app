import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  TelegramNotificationChannelStatus,
  TelegramNotificationLink,
} from './types/telegramNotificationsApi.types';

export const telegramNotificationsApi = {
  getStatus(): Promise<TelegramNotificationChannelStatus> {
    return httpClient.get<TelegramNotificationChannelStatus>(
      apiRoutes.profile.telegramNotifications,
    );
  },

  startLink(): Promise<TelegramNotificationLink> {
    return httpClient.post<TelegramNotificationLink>(
      apiRoutes.profile.telegramNotificationsLink,
      undefined,
    );
  },

  unlink(): Promise<{ disconnected: boolean }> {
    return httpClient.delete<{ disconnected: boolean }>(
      apiRoutes.profile.telegramNotifications,
    );
  },
};
