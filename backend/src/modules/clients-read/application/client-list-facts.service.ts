import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { rolePolicyForUser } from '../../../permissions/policies/scope';
import type { ClientListFactsDto, ClientListFactsResponseDto, ClientOrdersScope } from './client-list-facts.types';

export interface ClientListFactsReadPort {
  facts(clientIds: readonly number[], scope: ClientOrdersScope): Promise<ClientListFactsDto[]>;
}

/**
 * Which orders of a client the user may be told about: nothing without `orders.view`, all orders for
 * the scope «all», only the user's own for «own». «assigned» (a worker) gets no order facts here.
 */
export function clientOrdersScope(user: CurrentUser): ClientOrdersScope {
  if (!user.permissions.includes('orders.view')) return { kind: 'none' };
  const scope = rolePolicyForUser(user).orders.view;
  if (scope === 'all') return { kind: 'all' };
  const userId = Number(user.id);
  if (scope === 'own' && Number.isInteger(userId) && userId > 0) return { kind: 'own', userId };
  return { kind: 'none' };
}

/**
 * Facts for the «Клиенты» list (phone, number of orders, last order). Needs `clients.view`; the order
 * facts follow the user's order visibility. The right is checked here so that a refusal is audited.
 */
export class ClientListFactsService {
  constructor(private readonly ports: { read: ClientListFactsReadPort; auditClient: DatabaseClient }) {}

  async facts(user: CurrentUser, clientIds: readonly number[], requestId: string): Promise<ClientListFactsResponseDto> {
    if (!user.permissions.includes('clients.view')) {
      await auditService.recordDenied(this.ports.auditClient, {
        event: 'clients.list_facts_denied',
        entityType: 'client',
        entityId: 0,
        actorUserId: user.id,
        actorUsername: user.username,
        actorRole: user.role,
        requestId,
        source: 'backend-clients-read',
        reason: 'missing_permission',
        requiredPermissions: ['clients.view'],
        metadata: { action: 'list_facts', clients: clientIds.length },
      });
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра клиентов', { requiredPermissions: ['clients.view'] });
    }
    return { data: await this.ports.read.facts(clientIds, clientOrdersScope(user)) };
  }
}
