import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { policyScopeSetsForUser } from '../../../permissions/policies/scope';
import type { ClientPaymentsPage } from '../adapters/pg-client-payments-repository';
import { clientOrderReadScope } from './client-list-facts.service';
import type { ClientPaymentsResponseDto } from './client-payments.types';

export interface ClientPaymentsReadPort {
  clientExists(clientId: number): Promise<boolean>;
  list(clientId: number, viewer: CurrentUser, page: number, pageSize: number): Promise<ClientPaymentsPage>;
}

const REQUIRED = ['clients.view', 'orders.view', 'payments.view', 'orders.view_financials'] as const;
const money = (value: number) => Math.round(value * 100) / 100;

/**
 * What the answer covers: `all` — every payment of the client; `own` — only payments of the user's own orders (creator or
 * manager); `restricted` — another narrowing (orders the user works on: `payments.view` assigned).
 */
function answerScope(orderKind: 'all' | 'own', paymentSet: readonly string[]): ClientPaymentsResponseDto['scope'] {
  const paymentAll = paymentSet.includes('all');
  if (orderKind === 'all' && paymentAll) return 'all';
  if (!paymentAll && paymentSet.includes('assigned')) return 'restricted';
  return 'own';
}

/**
 * «Платежи» of the client card: the payments of the orders of one client the user may see, with their sum over all
 * pages. Needs `clients.view`, `orders.view`, `payments.view` and `orders.view_financials` (payment amounts are money
 * of orders: the Hasura payment rows need the same right); a payment is shown when its order is visible to the user
 * (the shared order read visibility) AND the payment visibility allows that order (`payments.view` all / own / assigned,
 * as for one payment). Rights are checked here by literal membership, so a refusal is audited.
 */
export class ClientPaymentsService {
  constructor(private readonly ports: { read: ClientPaymentsReadPort; auditClient: DatabaseClient }) {}

  async list(user: CurrentUser, clientId: number, page: number, pageSize: number, requestId: string): Promise<ClientPaymentsResponseDto> {
    const missing = REQUIRED.filter((permission) => !user.permissions.includes(permission));
    const orderScope = clientOrderReadScope(user);
    const paymentSet = policyScopeSetsForUser(user).payments.view;
    const paymentGrants = paymentSet.filter((grant) => grant === 'all' || grant === 'own' || grant === 'assigned');
    if (missing.length > 0 || orderScope.kind === 'none' || paymentGrants.length === 0) {
      await auditService.recordDenied(this.ports.auditClient, {
        event: 'clients.payments_denied', entityType: 'client', entityId: clientId, relatedClientId: clientId,
        actorUserId: user.id, actorUsername: user.username, actorRole: user.role, requestId,
        source: 'backend-clients-read', reason: missing.length > 0 ? 'missing_permission' : 'scope_not_allowed',
        requiredPermissions: [...REQUIRED],
        metadata: {
          action: 'client_payments', missingPermissions: missing,
          orderScope: policyScopeSetsForUser(user).orders.view.join(',') || 'none', paymentScope: paymentSet.join(',') || 'none',
        },
      });
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра платежей клиента', { requiredPermissions: [...REQUIRED] });
    }
    if (!(await this.ports.read.clientExists(clientId))) throw new ApiError(404, 'CLIENT_NOT_FOUND', 'Клиент не найден');
    const result = await this.ports.read.list(clientId, user, page, pageSize);
    return {
      data: result.rows.map((row) => ({
        paymentId: Number(row.payment_id), paymentDate: row.payment_date, amount: money(Number(row.amount)),
        typePaidName: row.type_paid_name, notes: row.notes, fromOnec: row.from_onec === true,
        order: { orderId: Number(row.order_id), orderName: row.order_name, fullNumber: row.full_number },
      })),
      pagination: { page, pageSize, total: result.total, totalPages: Math.max(1, Math.ceil(result.total / pageSize)) },
      scope: answerScope(orderScope.kind, paymentSet),
      summary: { amount: money(result.amount) },
    };
  }
}
