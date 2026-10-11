import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { appendOrderReadVisibilitySql, orderReadVisibilityIsRestricted } from '../../../permissions/policies/order-read-scope-sql';
import { rolePolicyForUser } from '../../../permissions/policies/scope';
import type { ClientListFactsDto, ClientListFactsResponseDto, ClientOrderReadScope, ClientOrdersScope } from './client-list-facts.types';

export interface ClientListFactsReadPort {
  facts(clientIds: readonly number[], scope: ClientOrderReadScope): Promise<ClientListFactsDto[]>;
}

/**
 * Strict scope kept for the 1C documents of a client (party-contacts): all for «all», the user's own for «own»,
 * nothing for any other scope («assigned» is refused there — those documents are not behind the orders list).
 * ERP order reads use `clientOrderReadScope`.
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
 * Which ERP orders of a client the user may be told about: nothing without `orders.view`; otherwise the shared order
 * read visibility (the same rule as the orders list and the order card) — only the user's own orders when the
 * visibility is restricted to «own», all orders when it is not restricted, nothing without any grant.
 */
export function clientOrderReadScope(user: CurrentUser): ClientOrderReadScope {
  if (!user.permissions.includes('orders.view')) return { kind: 'none' };
  if (!orderReadVisibilityIsRestricted(user)) return { kind: 'all', viewer: user };
  // Restricted: either the «own» predicate or no grant at all (`FALSE`).
  return appendOrderReadVisibilitySql([], user) === 'FALSE' ? { kind: 'none' } : { kind: 'own', viewer: user };
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
    return { data: await this.ports.read.facts(clientIds, clientOrderReadScope(user)) };
  }
}
