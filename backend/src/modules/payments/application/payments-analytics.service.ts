import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { rolePolicyForUser } from '../../../permissions/policies/scope';
import type { PaymentsAnalyticsSummaryDto, PaymentsAnalyticsSummaryQuery } from './payments-analytics.types';

/** Both are required: the analytics right itself and the right to see payments at all. */
export const PAYMENTS_ANALYTICS_PERMISSIONS = ['finance.analytics.view', 'payments.view'] as const;

export interface PaymentsAnalyticsReadPort {
  summary(query: PaymentsAnalyticsSummaryQuery): Promise<PaymentsAnalyticsSummaryDto>;
}

/**
 * Payments analytics («+Платежи»): totals over ALL payments of a period, so it is open only to a user
 * who has `finance.analytics.view` and whose payment visibility is not limited to their own orders.
 * The rights are checked here rather than by a decorator: a refusal must reach the audit log.
 */
export class PaymentsAnalyticsService {
  constructor(private readonly ports: { read: PaymentsAnalyticsReadPort; auditClient: DatabaseClient }) {}

  async summary(user: CurrentUser, query: PaymentsAnalyticsSummaryQuery, requestId: string): Promise<PaymentsAnalyticsSummaryDto> {
    const missing = PAYMENTS_ANALYTICS_PERMISSIONS.filter((permission) => !user.permissions.includes(permission));
    const scope = rolePolicyForUser(user).payments.view;
    if (missing.length > 0 || scope !== 'all') {
      await auditService.recordDenied(this.ports.auditClient, {
        event: 'payments.analytics_denied',
        entityType: 'payments_analytics',
        entityId: 0,
        actorUserId: user.id,
        actorUsername: user.username,
        actorRole: user.role,
        requestId,
        source: 'backend-payments-analytics',
        reason: missing.length > 0 ? 'missing_permission' : 'scope_not_all',
        requiredPermissions: [...PAYMENTS_ANALYTICS_PERMISSIONS],
        metadata: { action: 'summary', dateFrom: query.dateFrom, dateTo: query.dateTo },
      });
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра аналитики платежей', {
        requiredPermissions: [...PAYMENTS_ANALYTICS_PERMISSIONS],
      });
    }
    return this.ports.read.summary(query);
  }
}
