import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { PaymentAccessPolicy } from '../../../permissions/policies/payment-access.policy';
import { policyScopeSetsForUser, rolePolicyForUser, scopeSetHas } from '../../../permissions/policies/scope';
import type { CommandActor, LockedOrderRow, MatchCommandResult, PgOnecReceiptsCommandRepository } from '../adapters/pg-onec-receipts-command-repository';
import type { PgOnecReceiptsReadRepository, ReceiptsReadContext } from '../adapters/pg-onec-receipts-read-repository';
import type { OnecReceiptsAutoMatcher } from './onec-receipts-auto-match.service';
import { paymentScope } from '../domain/onec-receipts';
import type { OnecReceiptCardDto, OnecReceiptCommandResponseDto, OnecReceiptListQuery, OnecReceiptListResponseDto } from './onec-receipts.types';

// Amounts of ERP orders and payments are financial data: like payments in Hasura (access predicates) they also need
// orders.view_financials (the «финансы» stage).
const VIEW = ['payments.onec.view', 'payments.view', 'orders.view_financials'] as const;
/** Ручные команды (план §6 «Права и scope»): к правам чтения — управление сверкой и изменение платежей. */
const MANAGE = [...VIEW, 'payments.onec.manage', 'payments.update'] as const;

export interface OnecReceiptsSettings {
  /** `BACKEND_ONEC_PAYMENT_MATCHING_VIEW` и включённая интеграция 1С. */
  viewEnabled: boolean;
  /** `BACKEND_ONEC_PAYMENT_MATCHING_COMMANDS` (требует чтения): ручные команды вкладки. */
  commandsEnabled: boolean;
  /** Серия номеров заказов 1С, которые являются заказами ERP; `null` — правило выключено. */
  series: string | null;
}

export interface CommandRequest {
  requestId: string;
  correlationId: string | null;
}

/**
 * Вкладка «Поступления 1С» (план 2026-10-04-onec-incoming-payments): чтение (срез A) и ручные команды (срез B).
 * Права и область видимости проверяются здесь, а не декоратором: отказ должен попасть в аудит.
 */
export class OnecReceiptsService {
  private readonly paymentAccess = new PaymentAccessPolicy();

  constructor(private readonly ports: {
    read: PgOnecReceiptsReadRepository;
    commands?: PgOnecReceiptsCommandRepository;
    autoMatcher?: OnecReceiptsAutoMatcher;
    settings: () => OnecReceiptsSettings;
    auditClient: DatabaseClient;
  }) {}

  async list(user: CurrentUser, query: OnecReceiptListQuery, requestId: string): Promise<OnecReceiptListResponseDto> {
    return this.ports.read.list(await this.context(user, requestId, null), query);
  }

  async getCard(user: CurrentUser, lineId: number, requestId: string): Promise<OnecReceiptCardDto> {
    return this.ports.read.getCard(await this.context(user, requestId, lineId), lineId);
  }

  match(user: CurrentUser, lineId: number, body: { paymentId: number; expectedStateToken: string; expectedPaymentToken: string; note?: string | null }, request: CommandRequest) {
    return this.command(user, lineId, 'match', request, (repo, actor, scope) => repo.match(lineId, body, actor, scope));
  }

  unmatch(user: CurrentUser, lineId: number, body: { expectedMatchId: number; reason?: string | null }, request: CommandRequest) {
    return this.command(user, lineId, 'unmatch', request, (repo, actor, scope) => repo.unmatch(lineId, body, actor, scope));
  }

  dismiss(user: CurrentUser, lineId: number, body: { expectedStateToken: string; note: string }, request: CommandRequest) {
    return this.command(user, lineId, 'dismiss', request, (repo, actor, scope) => repo.dismiss(lineId, body, actor, scope));
  }

  link(user: CurrentUser, lineId: number, body: { expectedStateToken: string; orderId: number | null; note?: string | null }, request: CommandRequest) {
    return this.command(user, lineId, 'link', request, (repo, actor, scope) => repo.link(lineId, { ...body, remove: false }, actor, scope));
  }

  unlink(user: CurrentUser, lineId: number, body: { expectedStateToken: string }, request: CommandRequest) {
    return this.command(user, lineId, 'unlink', request,
      (repo, actor, scope) => repo.link(lineId, { expectedStateToken: body.expectedStateToken, orderId: null, remove: true }, actor, scope));
  }

  /**
   * «Сверить сейчас» (план §6): автосверка только по заказам в области `payments.update` инициатора; автор сверок —
   * инициатор (origin `auto`). Нужны те же права и флаг, что у ручных команд.
   */
  async autoMatchNow(user: CurrentUser, request: CommandRequest): Promise<{ matched: number; candidates: number; skipped: boolean }> {
    const settings = this.ports.settings();
    if (!settings.viewEnabled || !settings.commandsEnabled || !this.ports.autoMatcher) {
      throw new ApiError(503, 'ONEC_PAYMENT_MATCHING_COMMANDS_DISABLED', 'Команды сверки поступлений 1С выключены');
    }
    const missing = MANAGE.filter((permission) => !user.permissions.includes(permission));
    if (missing.length > 0) {
      await this.denied(user, request.requestId, 0, 'auto_match', 'missing_permission', null);
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для сверки поступлений 1С', { requiredPermissions: [...MANAGE] });
    }
    const result = await this.ports.autoMatcher.run({
      actorUserId: user.id, trigger: 'button', correlationId: request.correlationId ?? request.requestId,
      scope: (order) => this.paymentAccess.canUpdate(user, { paymentId: 0, order: { createdByUserId: order.createdBy, managerUserId: order.managerId } }),
    });
    return { matched: result.matched, candidates: result.candidates, skipped: result.skipped };
  }

  private async command(
    user: CurrentUser,
    lineId: number,
    action: string,
    request: CommandRequest,
    run: (repo: PgOnecReceiptsCommandRepository, actor: CommandActor, scope: (orders: readonly (LockedOrderRow | null)[]) => Promise<void>) => Promise<MatchCommandResult>,
  ): Promise<OnecReceiptCommandResponseDto> {
    const settings = this.ports.settings();
    if (!settings.viewEnabled || !settings.commandsEnabled || !this.ports.commands) {
      throw new ApiError(503, 'ONEC_PAYMENT_MATCHING_COMMANDS_DISABLED', 'Команды сверки поступлений 1С выключены');
    }
    const missing = MANAGE.filter((permission) => !user.permissions.includes(permission));
    if (missing.length > 0) {
      await this.denied(user, request.requestId, lineId, action, 'missing_permission', null);
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для сверки поступлений 1С', { requiredPermissions: [...MANAGE] });
    }
    const actor: CommandActor = { userId: user.id, username: user.username, role: user.role, ...request };
    // Under the command's locks: `payments.update` over every order the decision touches; «no order» — only scope «all».
    const updateScopes = policyScopeSetsForUser(user).payments.update;
    const checkScope = async (orders: readonly (LockedOrderRow | null)[]) => {
      for (const order of orders) {
        const allowed = order === null
          ? scopeSetHas(updateScopes, 'all')
          : this.paymentAccess.canUpdate(user, { paymentId: 0, order: { createdByUserId: order.createdBy, managerUserId: order.managerId } });
        if (!allowed) {
          await this.denied(user, request.requestId, lineId, action, 'scope', order?.orderId ?? null);
          throw new ApiError(403, 'PERMISSION_DENIED', 'Нет доступа к платежам этого заказа', { requiredPermissions: ['payments.update'] });
        }
      }
    };
    const result = await run(this.ports.commands, actor, checkScope);
    const line = await this.ports.read.line(await this.context(user, request.requestId, lineId), lineId);
    return { changed: result.changed, matchId: result.matchId, line };
  }

  /** Отказ пишется пулом (вне транзакции команды) — переживает её откат. */
  private async denied(user: CurrentUser, requestId: string, lineId: number, action: string, reason: string, orderId: number | null): Promise<void> {
    try {
      await auditService.recordDenied(this.ports.auditClient, {
        event: 'payments.onec_denied',
        entityType: 'onec_document_line',
        entityId: lineId,
        actorUserId: user.id,
        actorUsername: user.username,
        actorRole: user.role,
        requestId,
        source: 'backend-payments-onec',
        reason,
        requiredPermissions: [...MANAGE],
        metadata: { action, orderId },
      });
    } catch {
      // best-effort: an audit-sink outage must not mask the 403
    }
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
    const commands = settings.commandsEnabled && this.ports.commands !== undefined
      && MANAGE.every((permission) => user.permissions.includes(permission));
    return { userId: user.id, scope, series: settings.series, commands };
  }
}
