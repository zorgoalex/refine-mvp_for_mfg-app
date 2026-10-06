import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { rolePolicyForUser } from '../../../permissions/policies/scope';
import type { ClientAnalyticsCardDto, ClientsDashboardDto, ClientsDashboardQuery } from './clients-analytics.types';

/**
 * The clients analytics shows the orders, amounts and payments of every client, so all five are needed:
 * the analytics right, the clients, the orders, the money of orders and the payments.
 */
export const CLIENTS_ANALYTICS_PERMISSIONS = [
  'clients.analytics.view',
  'clients.view',
  'orders.view',
  'orders.view_financials',
  'payments.view',
] as const;

export interface ClientsAnalyticsReadPort {
  dashboard(query: ClientsDashboardQuery): Promise<ClientsDashboardDto>;
  card(clientId: number): Promise<ClientAnalyticsCardDto | null>;
}

/**
 * Clients analytics: the dashboard and the card of one client. Open only to a user who holds the
 * rights above and whose visibility of BOTH orders and payments is not limited («all»): the figures
 * and the lists cover the orders and the payments of all managers. The rights are checked here rather than by a decorator: a refusal is audited.
 */
export class ClientsAnalyticsService {
  constructor(private readonly ports: { read: ClientsAnalyticsReadPort; auditClient: DatabaseClient }) {}

  async dashboard(user: CurrentUser, query: ClientsDashboardQuery, requestId: string): Promise<ClientsDashboardDto> {
    await this.authorize(user, 'dashboard', null, requestId);
    return this.ports.read.dashboard(query);
  }

  async card(user: CurrentUser, clientId: number, requestId: string): Promise<ClientAnalyticsCardDto> {
    await this.authorize(user, 'card', clientId, requestId);
    const card = await this.ports.read.card(clientId);
    if (!card) throw new ApiError(404, 'CLIENT_NOT_FOUND', 'Клиент не найден');
    return card;
  }

  private async authorize(user: CurrentUser, action: 'dashboard' | 'card', clientId: number | null, requestId: string): Promise<void> {
    const missing = CLIENTS_ANALYTICS_PERMISSIONS.filter((permission) => !user.permissions.includes(permission));
    const policy = rolePolicyForUser(user);
    const limited = policy.orders.view !== 'all' ? 'orders_scope_not_all' : policy.payments.view !== 'all' ? 'payments_scope_not_all' : null;
    if (missing.length === 0 && limited === null) return;
    await auditService.recordDenied(this.ports.auditClient, {
      event: 'clients.analytics_denied',
      entityType: 'client',
      entityId: clientId ?? 0,
      actorUserId: user.id,
      actorUsername: user.username,
      actorRole: user.role,
      requestId,
      source: 'backend-clients-read',
      relatedClientId: clientId,
      reason: missing.length > 0 ? 'missing_permission' : (limited ?? 'scope_not_all'),
      requiredPermissions: [...CLIENTS_ANALYTICS_PERMISSIONS],
      metadata: { action },
    });
    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра аналитики клиентов', {
      requiredPermissions: [...CLIENTS_ANALYTICS_PERMISSIONS],
    });
  }
}
