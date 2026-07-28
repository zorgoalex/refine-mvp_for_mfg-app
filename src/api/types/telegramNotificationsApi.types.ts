export interface TelegramNotificationChannelStatus {
  available: boolean;
  connected: boolean;
  botUsername?: string;
  displayName?: string;
  linkedAt?: string;
}

export interface TelegramNotificationLink {
  linkUrl: string;
  expiresAt: string;
}
