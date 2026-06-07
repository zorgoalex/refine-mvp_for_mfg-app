import type { NotificationRuleRecipients, NotificationEventContext } from '../domain/notification-rule.types';
import type { DatabaseClient } from '../../../database/database.types';
import type { RecipientSourcePort } from '../ports/recipient-source.port';
import type { VisibilityPort } from '../ports/visibility.port';

export class RecipientResolverService {
  constructor(private readonly sources: RecipientSourcePort, private readonly visibility: VisibilityPort) {}

  async resolve(client: DatabaseClient, recipients: NotificationRuleRecipients, ctx: NotificationEventContext): Promise<number[]> {
    const ids = new Set<number>();
    for (const kind of recipients.resolvers ?? []) {
      for (const id of await this.sources.resolveDynamic(client, kind, ctx)) ids.add(id);
    }
    if (recipients.roleCodes?.length) {
      for (const id of await this.sources.resolveRoleMembers(client, recipients.roleCodes)) ids.add(id);
    }
    for (const id of recipients.userIds ?? []) ids.add(id);
    if (ids.size === 0) return [];
    const active = await this.sources.filterActiveUsers(client, [...ids]);
    return this.visibility.filterByBaseVisibility(client, active, ctx);
  }
}
