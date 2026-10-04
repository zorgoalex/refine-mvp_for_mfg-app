import type { DatabaseClient } from '../../../database/database.types';
import { PgNotificationWriteAdapter } from '../../notifications-engine/adapters/pg-notification-write';
import type {
  DeadlineNotificationInput,
  DeadlineNotificationPort,
  DeadlineNotificationResult,
} from '../application/deadline.types';


/**
 * Старый путь уведомлений дедлайнов (владелец `legacy_inline`): пишет через единый адаптер записи уведомлений (план
 * 2026-10-03 §2.1). Балуна нет — эти уведомления создают действия дедлайнов, а не правила экрана уведомлений
 * (балуны дедлайнов — в правилах `DEADLINE_EXPIRED`, когда уведомлениями дедлайнов владеет движок).
 */
export class PgDeadlineNotificationPort implements DeadlineNotificationPort {
  private readonly write = new PgNotificationWriteAdapter();

  constructor(private readonly database: DatabaseClient) {}

  async createNotification(input: DeadlineNotificationInput): Promise<DeadlineNotificationResult> {
    const result = await this.write.insertIfAbsent(this.database, {
      userId: input.userId,
      level: input.level,
      title: input.title,
      message: input.message,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      idempotencyKey: input.idempotencyKey,
      balloonMode: null,
    });
    return { created: result.created, notificationId: result.notificationId };
  }
}
