import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { policyScopeSetsForUser } from '../../../permissions/policies/scope';
import type { ClientOrdersPage } from '../adapters/pg-client-orders-repository';
import { clientOrderReadScope } from './client-list-facts.service';
import type { ClientOrderReadScope } from './client-list-facts.types';
import type { ClientOrdersResponseDto } from './client-orders.types';
import { CLIENT_ORDER_MONEY_SORT_KEYS, DEFAULT_ORDER_SORT, type ClientOrderSortKey, type TabSort } from './client-tab-sort';

export interface ClientOrdersReadPort {
  clientExists(clientId: number): Promise<boolean>;
  list(
    clientId: number, scope: Exclude<ClientOrderReadScope, { kind: 'none' }>, page: number, pageSize: number,
    sort: TabSort<ClientOrderSortKey>,
  ): Promise<ClientOrdersPage>;
}

const money = (value: number) => Math.round(value * 100) / 100;

/**
 * «Заказы» of the client card: the orders of one client the user may see, with totals over all pages.
 * Needs `clients.view` and `orders.view`; the rows follow the shared order read visibility (all, or only his own —
 * the same rule as the orders list, the order card and the order facts of the clients list); money needs
 * `orders.view_financials`. Rights are
 * checked here by literal membership, so a refusal is audited.
 */
export class ClientOrdersService {
  constructor(private readonly ports: { read: ClientOrdersReadPort; auditClient: DatabaseClient }) {}

  async list(
    user: CurrentUser, clientId: number, page: number, pageSize: number, requestId: string,
    sort: TabSort<ClientOrderSortKey> = DEFAULT_ORDER_SORT,
  ): Promise<ClientOrdersResponseDto> {
    const scope = clientOrderReadScope(user);
    const missing = (['clients.view', 'orders.view'] as const).filter((permission) => !user.permissions.includes(permission));
    if (missing.length > 0 || scope.kind === 'none') {
      // Both rights present but the order read visibility grants nothing: the scope is what forbids it.
      const orderScope = policyScopeSetsForUser(user).orders.view.join(',') || 'none';
      await auditService.recordDenied(this.ports.auditClient, {
        event: 'clients.orders_denied', entityType: 'client', entityId: clientId, relatedClientId: clientId,
        actorUserId: user.id, actorUsername: user.username, actorRole: user.role, requestId,
        source: 'backend-clients-read', reason: missing.length > 0 ? 'missing_permission' : 'scope_not_allowed',
        requiredPermissions: ['clients.view', 'orders.view'],
        metadata: { action: 'client_orders', missingPermissions: missing, orderScope },
      });
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра заказов клиента', { requiredPermissions: ['clients.view', 'orders.view'] });
    }
    const financials = user.permissions.includes('orders.view_financials');
    // Ordering by a money column reveals the amounts: it needs the same right as the amounts themselves.
    if (!financials && CLIENT_ORDER_MONEY_SORT_KEYS.includes(sort.key)) {
      await auditService.recordDenied(this.ports.auditClient, {
        event: 'clients.orders_denied', entityType: 'client', entityId: clientId, relatedClientId: clientId,
        actorUserId: user.id, actorUsername: user.username, actorRole: user.role, requestId,
        source: 'backend-clients-read', reason: 'missing_permission', requiredPermissions: ['orders.view_financials'],
        metadata: { action: 'client_orders_sort', sort: sort.key, missingPermissions: ['orders.view_financials'] },
      });
      throw new ApiError(403, 'PERMISSION_DENIED', 'Сортировка по суммам доступна только с правом видеть финансы заказов', {
        requiredPermissions: ['orders.view_financials'],
      });
    }
    if (!(await this.ports.read.clientExists(clientId))) throw new ApiError(404, 'CLIENT_NOT_FOUND', 'Клиент не найден');
    const result = await this.ports.read.list(clientId, scope, page, pageSize, sort);
    return {
      data: result.rows.map((row) => {
        const finalAmount = money(Number(row.final_amount ?? 0));
        const paidAmount = money(Number(row.paid_amount ?? 0));
        return {
          orderId: Number(row.order_id), orderName: row.order_name, fullNumber: row.full_number, orderDate: row.order_date,
          orderStatusName: row.order_status_name, productionStatusName: row.production_status_name, paymentStatusName: row.payment_status_name,
          // Without the right the money is absent, not zero: a zero would read as «nothing is owed».
          ...(financials ? { finalAmount, paidAmount, debtAmount: money(finalAmount - paidAmount) } : {}),
        };
      }),
      pagination: { page, pageSize, total: result.total, totalPages: Math.max(1, Math.ceil(result.total / pageSize)) },
      scope: scope.kind,
      ...(financials ? { summary: { finalAmount: money(result.finalAmount), paidAmount: money(result.paidAmount),
        debtAmount: money(result.finalAmount - result.paidAmount) } } : {}),
    };
  }
}
