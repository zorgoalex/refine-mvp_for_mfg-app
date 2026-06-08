import type { DatabaseClient } from '../../../database/database.types';
import type { NotificationEventContext } from '../domain/notification-rule.types';

export interface VisibilityPort {
  filterByBaseVisibility(client: DatabaseClient, userIds: number[], ctx: NotificationEventContext): Promise<number[]>;
}
