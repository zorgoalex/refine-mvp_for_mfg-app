import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { rolePolicyForUser } from '../../../permissions/policies/scope';
import type { PgOnecReceiptsReadRepository, ReceiptsReadContext } from '../adapters/pg-onec-receipts-read-repository';
import { paymentScope } from '../domain/onec-receipts';
import type { OnecReceiptCardDto, OnecReceiptListQuery, OnecReceiptListResponseDto } from './onec-receipts.types';

const VIEW = ['payments.onec.view', 'payments.view'] as const;

export interface OnecReceiptsSettings {
  /** `BACKEND_ONEC_PAYMENT_MATCHING_VIEW` и включённая интеграция 1С. */
  viewEnabled: boolean;
  /** Серия номеров заказов 1С, которые являются заказами ERP; `null` — правило выключено. */
  series: string | null;
}

/**
 * Вкладка «Поступления 1С» (план 2026-10-04-onec-incoming-payments, срез A — только чтение).
 * Права проверяются здесь, а не декоратором: отказ должен попасть в аудит.
 */
export class OnecReceiptsService {
  constructor(private readonly ports: {
    read: PgOnecReceiptsReadRepository;
    settings: () => OnecReceiptsSettings;
    auditClient: DatabaseClient;
  }) {}

  async list(user: CurrentUser, query: OnecReceiptListQuery, requestId: string): Promise<OnecReceiptListResponseDto> {
    return this.ports.read.list(await this.context(user, requestId, null), query);
  }

  async getCard(user: CurrentUser, lineId: number, requestId: string): Promise<OnecReceiptCardDto> {
    return this.ports.read.getCard(await this.context(user, requestId, lineId), lineId);
  }

  private async context(user: CurrentUser, requestId: string, lineId: number | null): Promise<ReceiptsReadContext> {
    const settings = this.ports.settings();
    if (!settings.viewEnabled) {
      throw new ApiError(503, 'ONEC_PAYMENT_MATCHING_DISABLED', 'Сверка поступлений 1С выключена');
    }
    const missing = VIEW.filter((permission) => !user.permissions.includes(permission));
    // Область видимости платежей — та же, что у `PaymentAccessPolicy` (`payments.view`), а не область заказов.
    const scope = paymentScope(rolePolicyForUser(user).payments.view);
    if (missing.length > 0 || scope === 'none') {
      await auditService.recordDenied(this.ports.auditClient, {
        event: 'payments.onec_denied',
        entityType: 'onec_document_line',
        entityId: lineId ?? 0,
        actorUserId: user.id,
        actorUsername: user.username,
        actorRole: user.role,
        requestId,
        source: 'backend-payments-onec',
        reason: missing.length > 0 ? 'missing_permission' : 'scope_none',
        requiredPermissions: [...VIEW],
        metadata: { action: lineId === null ? 'list' : 'card' },
      });
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра поступлений 1С', { requiredPermissions: [...VIEW] });
    }
    return { userId: user.id, scope, series: settings.series };
  }
}
