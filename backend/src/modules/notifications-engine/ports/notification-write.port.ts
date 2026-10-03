import type { DatabaseClient } from '../../../database/database.types';
import type { BalloonMode } from '../domain/notification-rule.types';

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
  /** Балун на момент записи (`balloonFor(rule)`); нет/NULL — без балуна. */
  balloonMode?: BalloonMode | null;
}

export interface NotificationWritePort {
  insertIfAbsent(client: DatabaseClient, input: InsertNotificationInput): Promise<{ created: boolean; notificationId: string }>;
}
