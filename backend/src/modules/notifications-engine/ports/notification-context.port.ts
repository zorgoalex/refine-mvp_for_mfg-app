import type { DatabaseClient } from '../../../database/database.types';
import type { OutboxEventRecord } from '../domain/outbox-event.types';
import type { NotificationEventContext } from '../domain/notification-rule.types';

export interface NotificationContextBuilderPort {
  buildContext(client: DatabaseClient, event: OutboxEventRecord): Promise<NotificationEventContext>;
}
