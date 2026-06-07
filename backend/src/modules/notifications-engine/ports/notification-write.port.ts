import type { DatabaseClient } from '../../../database/database.types';

export interface InsertNotificationInput {
  userId: number;
  level: 'info' | 'warning' | 'error';
  title: string;
  message: string;
  entityType: string | null;
  entityId: string | null;
  sourceType: string;
  sourceId: string | null;
  idempotencyKey: string;
}

export interface NotificationWritePort {
  insertIfAbsent(client: DatabaseClient, input: InsertNotificationInput): Promise<{ created: boolean; notificationId: string }>;
}
