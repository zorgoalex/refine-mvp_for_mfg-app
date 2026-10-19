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
  /**
   * Балун на момент записи (`balloonFor(rule)`); нет/NULL — без балуна. `mandatory` — обязательный балун оповещений
   * 1С (план 2026-10-19 §2.7): правила его не выбирают, его пишет только диспетчер оповещений 1С.
   */
  balloonMode?: BalloonMode | 'mandatory' | null;
}

export interface NotificationWritePort {
  insertIfAbsent(client: DatabaseClient, input: InsertNotificationInput): Promise<{ created: boolean; notificationId: string }>;
}
