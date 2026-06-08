import type { DatabaseClient } from '../../../database/database.types';
import type { NotificationEventContext } from '../domain/notification-rule.types';
import type { RecipientResolverKind } from '../domain/notification-event-registry';

export interface RecipientSourcePort {
  resolveDynamic(client: DatabaseClient, kind: RecipientResolverKind, ctx: NotificationEventContext): Promise<number[]>;
  resolveRoleMembers(client: DatabaseClient, roleCodes: string[]): Promise<number[]>;
  filterActiveUsers(client: DatabaseClient, userIds: number[]): Promise<number[]>;
}
