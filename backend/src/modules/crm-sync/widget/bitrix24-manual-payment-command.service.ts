import { ApiError } from '../../../common/errors/api-error';
import { moneyToCents } from '../../orders/domain/order-calculations';
import type { CurrentUser } from '../../../permissions/current-user';
import { CrmSyncRuntimeConfigService } from '../http/crm-sync-runtime-config.service';
import { Bitrix24LocalAppClient } from '../reverse/bitrix24-local-app-client';
import { normalizeBitrixPayment } from '../reverse/bitrix24-reverse-normalizer';
import { Bitrix24OAuthTokenService } from '../reverse/bitrix24-oauth-token.service';
import { Bitrix24TokenCipher } from '../reverse/bitrix24-token-cipher';
import type { CreateWidgetPaymentInput } from './bitrix24-payment-widget.dto';
import { requestHash } from './bitrix24-payment-widget.dto';
import type { AuthenticatedWidgetSession } from './bitrix24-payment-widget-auth.service';
import { Bitrix24PaymentWidgetAuthService } from './bitrix24-payment-widget-auth.service';
import { Bitrix24PaymentSystemCatalogService } from './bitrix24-payment-system-catalog.service';
import {
  Bitrix24PaymentWidgetRepository,
  type ManualPaymentCommand,
  type WidgetCommandStatus,
  type WidgetDealContext,
  type WidgetPaymentSystem,
} from './bitrix24-payment-widget.repository';

export interface WidgetContextResponse {
  deal: { id: string; title: string; currencyId: string | null };
  actor: { bitrixUserId: string; displayName: string };
  erp: {
    linkState: 'unlinked' | 'crm_request' | 'production_order';
    requestId: number | null;
    orderId: number | null;
    orderVersion: number | null;
    finalAmount: string | null;
    paidAmount: string | null;
    debtAmount: string | null;
  };
  paymentSystems: Array<{ id: number; name: string; erpTypePaidId: number; isDefault: boolean }>;
  recentPayments: Awaited<ReturnType<Bitrix24PaymentWidgetRepository['getRecentDealPayments']>>;
  serverDate: string;
  canCreate: boolean;
  blockReason: string | null;
}

export interface WidgetCommandResponse {
  commandId: string;
  status: WidgetCommandStatus;
  bitrixPaymentId: string | null;
  erpPaymentId: number | null;
  dealId: string;
  orderId: number | null;
  amount: string;
  currencyId: string;
  paymentDate: string;
  message: string;
}

import { Bitrix24PaidConversionService } from '../reverse/bitrix24-paid-conversion.service';
import { Bitrix24ProductSyncService } from '../reverse/bitrix24-product-sync.service';
import { Bitrix24ReverseProcessorService } from '../reverse/bitrix24-reverse-processor.service';

export class Bitrix24ManualPaymentCommandService {
  constructor(
    private readonly repository: Bitrix24PaymentWidgetRepository,
    private readonly auth: Bitrix24PaymentWidgetAuthService,
    private readonly bitrix: Bitrix24LocalAppClient,
    private readonly installationTokens: Bitrix24OAuthTokenService,
    private readonly config: CrmSyncRuntimeConfigService,
    private readonly catalog: Bitrix24PaymentSystemCatalogService,
    private readonly paidConversion?: Bitrix24PaidConversionService,
    private readonly productSync?: Bitrix24ProductSyncService,
    private readonly processor?: Bitrix24ReverseProcessorService,
  ) {}

  async getContext(authenticated: AuthenticatedWidgetSession): Promise<WidgetContextResponse> {
    const dealItem = await this.bitrix.getDeal({
      domain: authenticated.session.domain,
      accessToken: authenticated.accessToken,
      dealId: authenticated.session.dealId,
    });
    let deal = await this.repository.getDealContext(authenticated.session.dealId);
    let blockReason: string | null = null;
    try {
      await this.auth.requireCreateAccess(authenticated, deal);
    } catch (error) {
      blockReason = error instanceof ApiError ? error.code : 'BITRIX24_WIDGET_PERMISSION_DENIED';
    }
    // An archived request keeps its mapping but must not accept new payments
    // or trigger sync writes; converted requests stay payable through the
    // linked production order.
    if (blockReason === null && deal.requestId !== null && deal.requestState === 'archived') {
      blockReason = 'BITRIX24_REQUEST_NOT_ACTIVE';
    }
    // A materialized remote payment that diverged from the linked ERP payment
    // makes local totals untrustworthy — reconcile before new payments.
    if (blockReason === null && deal.paymentOutOfSync) {
      blockReason = 'BITRIX24_PAYMENT_OUT_OF_SYNC';
    }
    // Refresh/import the remote product rows before showing totals: the
    // widget must never render a fake zero total or an unreviewed debt. Runs
    // only after current ERP create access is confirmed — a revoked or
    // reassigned session must not trigger durable sync writes.
    if (blockReason === null && deal.requestId !== null && deal.requestState === 'active' &&
        deal.orderKind === 'crm_request') {
      if (!this.productSync) {
        blockReason = 'BITRIX24_PRODUCT_SYNC_FAILED';
      } else {
        try {
          const sync = await this.productSync.syncDeal({
            dealId: authenticated.session.dealId,
            auditRequestId: `widget-context:${authenticated.session.dealId}`,
          });
          deal = await this.repository.getDealContext(authenticated.session.dealId);
          if (sync.status === 'blocked') {
            blockReason = sync.reason ?? 'BITRIX24_PRODUCTS_BLOCKED';
          } else if (
            sync.status === 'skipped' &&
            deal.requestId !== null &&
            deal.orderKind === 'crm_request' &&
            deal.requestState === 'active'
          ) {
            // The required refresh did not apply for a still-linked active
            // request — never show stale totals as payable.
            blockReason = 'BITRIX24_PRODUCT_SYNC_FAILED';
          } else if (sync.status === 'skipped') {
            // Concurrently converted/relinked — reauthorize on the fresh
            // context before displaying anything.
            try {
              await this.auth.requireCreateAccess(authenticated, deal);
            } catch (error) {
              blockReason = error instanceof ApiError
                ? error.code
                : 'BITRIX24_WIDGET_PERMISSION_DENIED';
            }
          }
        } catch (error) {
          blockReason = error instanceof ApiError
            ? error.code
            : 'BITRIX24_PRODUCT_SYNC_FAILED';
        }
      }
    }
    const currencyId = text(dealItem.currencyId ?? dealItem.CURRENCY_ID);
    if (currencyId !== this.config.getBitrix24().currencyId) {
      blockReason = 'BITRIX24_PAYMENT_CURRENCY_MISMATCH';
    }
    await this.catalog.refreshIfStale();
    const systems = await this.repository.listWidgetPaymentSystems(
      this.config.getBitrix24().paySystemId,
    );
    if (systems.length === 0 && blockReason === null) {
      blockReason = 'BITRIX24_PAYMENT_SYSTEM_UNMAPPED';
    }
    const finalAmount = numberOrNull(deal.finalAmount);
    const paidAmount = numberOrNull(deal.paidAmount);
    return {
      deal: {
        id: authenticated.session.dealId,
        title: text(dealItem.title ?? dealItem.TITLE) ?? `Сделка #${authenticated.session.dealId}`,
        currencyId,
      },
      actor: {
        bitrixUserId: authenticated.session.bitrixUserId,
        displayName: authenticated.actorDisplayName,
      },
      erp: {
        linkState: deal.orderKind === 'production_order'
          ? 'production_order'
          : deal.requestId !== null
            ? 'crm_request'
            : 'unlinked',
        requestId: deal.requestId,
        orderId: deal.orderId,
        orderVersion: deal.orderVersion,
        finalAmount: deal.finalAmount,
        paidAmount: deal.paidAmount,
        debtAmount: finalAmount === null || paidAmount === null
          ? null
          : (Math.max(0,
              moneyToCents(deal.finalAmount) -
              moneyToCents(deal.paidAmount) -
              moneyToCents(deal.snapshotPaidAmount) -
              moneyToCents(deal.commandReservedAmount)) / 100).toFixed(2),
      },
      paymentSystems: systems.map((system) => ({
        id: system.paySystemId,
        name: system.name,
        erpTypePaidId: system.typePaidId,
        isDefault: system.isDefault,
      })),
      recentPayments: await this.repository.getRecentDealPayments(authenticated.session.dealId),
      serverDate: dateInPortalTimezone(new Date(), this.config.getReverseSync().portalTimezone),
      canCreate: blockReason === null,
      blockReason,
    };
  }

  async create(input: {
    authenticated: AuthenticatedWidgetSession;
    idempotencyKey: string;
    body: CreateWidgetPaymentInput;
    requestId: string;
  }): Promise<{ response: WidgetCommandResponse; created: boolean }> {
    const { authenticated, body } = input;
    const dealItem = await this.bitrix.getDeal({
      domain: authenticated.session.domain,
      accessToken: authenticated.accessToken,
      dealId: authenticated.session.dealId,
    });
    let deal = await this.repository.getDealContext(authenticated.session.dealId);
    // Current ERP access precedes the replay decision: a revoked session must
    // not resume a command either.
    await this.auth.requireCreateAccess(authenticated, deal);
    // Idempotent replay short-circuits BEFORE currency/financial/product
    // gates: a saved command resolves to its own stored state even when the
    // deal or mappings have since changed. The replay binds the exact Deal —
    // the same key/body on another Deal never resumes.
    const hashValue = requestHash(body);
    const existing = await this.repository.findCommandByIdempotencyKey(
      authenticated.session.memberId,
      authenticated.session.bitrixUserId,
      input.idempotencyKey,
    );
    if (existing) {
      if (
        existing.requestHash !== hashValue ||
        existing.bitrixDealId !== authenticated.session.dealId
      ) {
        throw new ApiError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency key was used with another request',
        );
      }
      const replayed = await this.resume(existing, authenticated.accessToken);
      return { response: responseFor(replayed), created: false };
    }
    let resolvedPaySystem: WidgetPaymentSystem;
    try {
      this.assertCurrency(dealItem);
      // Archived requests are post-payment territory even though the Deal
      // mapping stays active.
      if (deal.requestId !== null && deal.requestState === 'archived') {
        throw new ApiError(
          409,
          'BITRIX24_REQUEST_NOT_ACTIVE',
          'The linked Bitrix24 request is archived',
        );
      }
      if (deal.paymentOutOfSync) {
        throw new ApiError(
          409,
          'BITRIX24_PAYMENT_OUT_OF_SYNC',
          'A materialized Bitrix24 payment diverged from the ERP payment; reconcile the request',
        );
      }
      // Import/refresh remote product rows AND reconcile the current remote
      // payments before the totals check: a native Bitrix payment since the
      // last callback must shrink the remaining amount, and a fresh request
      // must never look like a zero-total order.
      if (deal.requestId !== null && deal.orderKind === 'crm_request') {
      if (!this.processor) {
        throw new ApiError(
          503,
          'BITRIX24_PRODUCT_SYNC_FAILED',
          'Bitrix24 request reconciliation is not configured',
        );
      }
      const result = await this.processor.reconcileIncomingRequestNow({
        requestId: deal.requestId,
        dealId: authenticated.session.dealId,
        auditRequestId: input.requestId,
      });
      if (result.productStatus === 'blocked') {
        throw new ApiError(
          409,
          result.productReason ?? 'BITRIX24_PRODUCTS_BLOCKED',
          'Bitrix24 product rows are blocked; reconcile the request',
        );
      }
      if (!result.paymentsApplied) {
        // A newer payment-snapshot state committed between the remote fetch
        // and the apply — retry so the remaining amount is computed from the
        // newest truth, never a torn refresh.
        throw new ApiError(
          409,
          'BITRIX24_PAYMENT_SYNC_STALE',
          'Bitrix24 payment reconciliation raced a newer update; retry',
        );
      }
      deal = await this.repository.getDealContext(authenticated.session.dealId);
      if (deal.orderKind === 'crm_request' && deal.requestId !== null &&
          deal.requestState === 'active' &&
          result.productStatus !== 'ready' && result.productStatus !== 'unchanged') {
        // The required refresh was skipped/failed for a still-linked active
        // request — never accept a payment on stale totals.
        throw new ApiError(
          409,
          'BITRIX24_PRODUCT_SYNC_FAILED',
          'Bitrix24 product refresh did not apply; reconcile the request and retry',
        );
      }
      // Revalidate access against the authoritative refreshed context (a
      // concurrent conversion may have relinked the Deal).
      await this.auth.requireCreateAccess(authenticated, deal);
    }
    // NEW payments on a production order (converted request or ERP-origin
    // direct mapping) also need a fresh remote payment refresh: a native
    // Bitrix payment recorded since the last callback must shrink the
    // remaining amount before this command is admitted.
    if (deal.orderKind === 'production_order' && deal.orderId !== null) {
      if (!this.processor) {
        throw new ApiError(
          503,
          'BITRIX24_PRODUCT_SYNC_FAILED',
          'Bitrix24 payment reconciliation is not configured',
        );
      }
      const reconciled = await this.processor.reconcileMappedOrderPaymentsNow({
        dealId: authenticated.session.dealId,
        orderId: deal.orderId,
        auditRequestId: input.requestId,
      });
      if (!reconciled.applied) {
        throw new ApiError(
          409,
          'BITRIX24_PAYMENT_SYNC_STALE',
          'Bitrix24 payment reconciliation raced a newer update; retry',
        );
      }
      deal = await this.repository.getDealContext(authenticated.session.dealId);
      await this.auth.requireCreateAccess(authenticated, deal);
    }
    this.assertVersion(body, deal);
      await this.catalog.refreshIfStale();
      const paySystem = (await this.repository.listWidgetPaymentSystems(
        this.config.getBitrix24().paySystemId,
      )).find((candidate) => candidate.paySystemId === body.paySystemId);
      if (!paySystem) {
        throw new ApiError(
          409,
          body.paySystemId === this.config.getBitrix24().paySystemId
            ? 'BITRIX24_PAYMENT_SYSTEM_FORBIDDEN'
            : 'BITRIX24_PAYMENT_SYSTEM_UNMAPPED',
          'Bitrix24 payment system is not available in the ERP widget',
        );
      }
      this.assertPreflightOverpayment(body, deal, authenticated.actor);
      resolvedPaySystem = paySystem;
    } catch (error) {
      // A same-key loser can arrive while the winner is still mid-flight: it
      // observed no command, then failed a refresh/preflight gate (stale CAS,
      // version, overpayment) against the winner's committed reservation.
      // Under a fresh context read and CURRENT authorization, re-check the
      // key: exact hash+Deal match resumes the stored command; a mismatched
      // command is still IDEMPOTENCY_KEY_REUSED; nothing resumes when the
      // caller's access was revoked in between — that failure must propagate.
      if (!(error instanceof ApiError)) throw error;
      const freshDeal = await this.repository.getDealContext(
        authenticated.session.dealId,
      );
      await this.auth.requireCreateAccess(authenticated, freshDeal);
      const nowExisting = await this.repository.findCommandByIdempotencyKey(
        authenticated.session.memberId,
        authenticated.session.bitrixUserId,
        input.idempotencyKey,
      );
      if (!nowExisting) throw error;
      if (
        nowExisting.requestHash !== hashValue ||
        nowExisting.bitrixDealId !== authenticated.session.dealId
      ) {
        throw new ApiError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency key was used with another request',
        );
      }
      const replayed = await this.resume(nowExisting, authenticated.accessToken);
      return { response: responseFor(replayed), created: false };
    }
    const commandCipher = new Bitrix24TokenCipher(this.requireWidgetConfig().commandTokenEncryptionKey);
    const result = await this.repository.createCommand({
      idempotencyKey: input.idempotencyKey,
      requestHash: hashValue,
      session: authenticated.session,
      installation: authenticated.installation,
      deal,
      amount: body.amount,
      currencyId: this.config.getBitrix24().currencyId,
      paymentDate: body.paymentDate,
      paySystem: resolvedPaySystem,
      comment: body.comment,
      confirmOverpayment: body.confirmOverpayment,
      callerAccessTokenCiphertext: commandCipher.encrypt(authenticated.accessToken),
      actorDisplayName: authenticated.actorDisplayName,
      callerRefreshTokenCiphertext: commandCipher.encrypt(authenticated.refreshToken),
      callerAccessTokenExpiresAt: authenticated.session.accessTokenExpiresAt,
      originatingRequestId: input.requestId,
    });
    const command = await this.resume(result.command, authenticated.accessToken);
    return { response: responseFor(command), created: result.created };
  }

  async getCommand(
    authenticated: AuthenticatedWidgetSession,
    commandId: string,
  ): Promise<WidgetCommandResponse> {
    return responseFor(await this.requireOwnedCommand(authenticated, commandId));
  }

  async retry(
    authenticated: AuthenticatedWidgetSession,
    commandId: string,
  ): Promise<WidgetCommandResponse> {
    let command = await this.requireOwnedCommand(authenticated, commandId);
    if (command.status === 'remote_create_ambiguous') {
      throw new ApiError(
        409,
        'BITRIX24_PAYMENT_CREATE_AMBIGUOUS',
        'Ambiguous payment creation requires administrative resolution',
      );
    }
    if (['completed', 'confirmed_not_created', 'failed_terminal'].includes(command.status)) {
      return responseFor(command);
    }
    if (command.status === 'awaiting_overpayment_confirmation') {
      throw new ApiError(
        409,
        'PAYMENT_OVERPAYMENT_CONFIRMATION_REQUIRED_AFTER_CREATE',
        'Overpayment confirmation is required',
      );
    }
    if (command.status === 'awaiting_actor_reauth') {
      throw new ApiError(409, 'BITRIX24_ACTOR_REAUTH_REQUIRED', 'Reauthorization is required');
    }
    if (command.status === 'awaiting_erp_retry' && command.errorCode === 'ORDER_VERSION_STALE') {
      const deal = await this.repository.getDealContext(command.bitrixDealId);
      await this.auth.requireCreateAccess(authenticated, deal);
      if (deal.orderVersion === null) {
        throw new ApiError(409, 'ORDER_NOT_READY_FOR_PAYMENTS', 'ERP order is not ready');
      }
      command = await this.repository.refreshExpectedOrderVersion({
        commandId: command.commandId,
        actorBitrixUserId: authenticated.session.bitrixUserId,
        expectedOrderVersion: deal.orderVersion,
      });
    }
    return responseFor(await this.resume(command, authenticated.accessToken));
  }

  async reauthorize(
    authenticated: AuthenticatedWidgetSession,
    commandId: string,
  ): Promise<WidgetCommandResponse> {
    const command = await this.requireOwnedCommand(authenticated, commandId);
    const cipher = new Bitrix24TokenCipher(this.requireWidgetConfig().commandTokenEncryptionKey);
    const updated = await this.repository.updateCommandCallerTokens({
      commandId: command.commandId,
      actorBitrixUserId: authenticated.session.bitrixUserId,
      accessTokenCiphertext: cipher.encrypt(authenticated.accessToken),
      refreshTokenCiphertext: cipher.encrypt(authenticated.refreshToken),
      accessTokenExpiresAt: authenticated.session.accessTokenExpiresAt,
    });
    return responseFor(await this.resume(updated, authenticated.accessToken));
  }

  async confirmOverpayment(
    authenticated: AuthenticatedWidgetSession,
    commandId: string,
  ): Promise<WidgetCommandResponse> {
    const command = await this.requireOwnedCommand(authenticated, commandId);
    if (!authenticated.actor.permissions.includes('bitrix24.payments.confirm_overpayment')) {
      throw new ApiError(
        403,
        'BITRIX24_WIDGET_PERMISSION_DENIED',
        'ERP user cannot confirm an overpayment',
      );
    }
    const confirmed = await this.repository.confirmOverpayment({
      commandId: command.commandId,
      actorUserId: Number(authenticated.actor.id),
    });
    return responseFor(await this.resume(confirmed, authenticated.accessToken));
  }

  async continueAfterAdministrativeResolution(
    command: ManualPaymentCommand,
  ): Promise<WidgetCommandResponse> {
    return responseFor(await this.resume(command));
  }

  async recover(limit = 20): Promise<{ recovered: number; ambiguous: number; failed: number }> {
    if (!this.requireWidgetConfig().enabled) return { recovered: 0, ambiguous: 0, failed: 0 };
    const commands = await this.repository.listRecoverableCommands(limit);
    let recovered = 0;
    let ambiguous = 0;
    let failed = 0;
    for (const command of commands) {
      try {
        const result = await this.resume(command);
        if (result.status === 'remote_create_ambiguous') ambiguous += 1;
        else recovered += 1;
      } catch (error) {
        if (errorCode(error) === 'BITRIX24_PAYMENT_CREATE_AMBIGUOUS') ambiguous += 1;
        else failed += 1;
        await this.repository.markPostCreateFailure(
          command.commandId,
          errorCode(error),
          safeError(error),
        );
      }
    }
    return { recovered, ambiguous, failed };
  }

  private async resume(
    initial: ManualPaymentCommand,
    freshActorToken?: string,
  ): Promise<ManualPaymentCommand> {
    const leaseToken = await this.repository.claimCommand(
      initial.commandId,
      this.requireWidgetConfig().commandLeaseMs,
    );
    if (!leaseToken) {
      return (await this.repository.getCommand(initial.commandId)) ?? initial;
    }
    try {
      return await this.resumeClaimed(initial, leaseToken, freshActorToken);
    } finally {
      await this.repository.releaseCommand(initial.commandId, leaseToken);
    }
  }

  private async resumeClaimed(
    initial: ManualPaymentCommand,
    leaseToken: string,
    freshActorToken?: string,
  ): Promise<ManualPaymentCommand> {
    let command = initial;
    if (command.status === 'processing') {
      const actorToken = freshActorToken ?? await this.commandActorToken(command);
      const before = await this.bitrix.listDealPaymentIds({
        domain: command.domain,
        accessToken: actorToken,
        dealId: command.bitrixDealId,
      });
      command = await this.repository.savePreCreate(command.commandId, before);
    }
    if (command.status === 'pre_create_saved') {
      const actorToken = freshActorToken ?? await this.commandActorToken(command);
      command = await this.repository.markRemoteCreateStarted(command.commandId);
      try {
        const paymentId = await this.bitrix.createDealPayment({
          domain: command.domain,
          accessToken: actorToken,
          dealId: command.bitrixDealId,
        });
        command = await this.repository.markRemoteCreated(command.commandId, paymentId);
      } catch (error) {
        let diagnosticCandidateIds: string[] = [];
        try {
          const after = await this.bitrix.listDealPaymentIds({
            domain: command.domain,
            accessToken: actorToken,
            dealId: command.bitrixDealId,
          });
          diagnosticCandidateIds = after.filter(
            (paymentId) => !command.beforePaymentIds.includes(paymentId),
          );
        } catch {
          diagnosticCandidateIds = [];
        }
        await this.repository.markAmbiguous(
          command.commandId,
          'BITRIX24_PAYMENT_CREATE_AMBIGUOUS',
          safeError(error),
          diagnosticCandidateIds,
        );
        throw new ApiError(
          409,
          'BITRIX24_PAYMENT_CREATE_AMBIGUOUS',
          'Bitrix24 did not confirm whether the payment was created',
          { commandId: command.commandId },
        );
      }
    }
    if (command.status === 'remote_create_started') {
      await this.repository.markCrashedCreateAmbiguous(command.commandId);
      throw new ApiError(
        409,
        'BITRIX24_PAYMENT_CREATE_AMBIGUOUS',
        'Payment creation was interrupted after its durable marker',
      );
    }
    if (command.status === 'remote_created') {
      try {
        command = await this.finalizeRemote(command, freshActorToken);
      } catch (error) {
        if (errorCode(error) === 'BITRIX24_ACTOR_REAUTH_REQUIRED') {
          await this.repository.markAwaitingActorReauth(command.commandId, safeError(error));
        } else {
          await this.repository.markPostCreateFailure(
            command.commandId,
            errorCode(error),
            safeError(error),
          );
        }
        throw error;
      }
    }
    if (
      command.status === 'snapshot_saved' ||
      command.status === 'awaiting_erp_retry' ||
      command.status === 'awaiting_order' ||
      command.status === 'awaiting_order_ready'
    ) {
      try {
        const auto = await this.paidConversion?.run({ dealId: command.bitrixDealId, requestId: command.originatingRequestId,
          widget: { commandId: command.commandId, leaseToken,
            awaitConfirmation: (tx, id) => this.repository.awaitOverpaymentConfirmationInTransaction(tx, id),
            materialize: (tx, id) => this.repository.materializeCommandInTransaction(tx, id) } });
        if (auto?.reason === 'PAYMENT_REQUIRES_CONFIRMATION') return (await this.repository.getCommand(command.commandId)) ?? command;
        command = await this.repository.materializeCommand(command.commandId);
      } catch (error) {
        await this.repository.markPostCreateFailure(
          command.commandId,
          errorCode(error),
          safeError(error),
        );
        throw error;
      }
    }
    return command;
  }

  private async finalizeRemote(
    command: ManualPaymentCommand,
    freshActorToken?: string,
  ): Promise<ManualPaymentCommand> {
    if (!command.bitrixPaymentId) {
      throw new ApiError(409, 'BITRIX24_PAYMENT_ID_MISSING', 'Payment ID is missing');
    }
    const actorToken = freshActorToken ?? await this.commandActorToken(command);
    const actorPayments = await this.bitrix.listDealPaymentIds({
      domain: command.domain,
      accessToken: actorToken,
      dealId: command.bitrixDealId,
    });
    if (!actorPayments.includes(command.bitrixPaymentId)) {
      throw new ApiError(
        409,
        'BITRIX24_PAYMENT_MEMBERSHIP_MISMATCH',
        'Created payment is not attached to the expected Deal',
      );
    }
    const executorToken = await this.installationTokens.getAccessToken(command.domain);
    const executor = await this.bitrix.currentUser({
      domain: command.domain,
      accessToken: executorToken,
    });
    if (!executor.active || !executor.admin || executor.id !== command.bitrixExecutorUserId) {
      throw new ApiError(
        403,
        'BITRIX24_EXECUTOR_INVALID',
        'Bitrix24 installation executor is not the verified administrator',
      );
    }
    const xmlId = `MEBELKZ_BITRIX_WIDGET_${command.commandId}`;
    const comments = [
      command.comment,
      `Команда ERP: ${command.commandId}`,
    ].filter(Boolean).join('\n');
    await this.bitrix.updatePayment({
      domain: command.domain,
      accessToken: executorToken,
      paymentId: command.bitrixPaymentId,
      fields: {
        paySystemId: command.paySystemId,
        sum: command.amount,
        paid: 'Y',
        datePaid: `${command.paymentDate}T12:00:00+05:00`,
        empPaidId: Number(command.bitrixActorUserId),
        responsibleId: Number(command.bitrixActorUserId),
        psStatus: 'Y',
        psSum: command.amount,
        psCurrency: command.currencyId,
        xmlId,
        comments,
        updated1c: 'N',
        externalPayment: 'N',
      },
    });
    // The snapshot generation fence is captured BEFORE each verification
    // GET; a newer snapshot mutation committed between the read and the save
    // makes the save stale — re-verify the SAME remote payment id, never
    // create a remote payment again.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fence = await this.repository.getPaymentSyncFence(command.bitrixDealId);
      const payment = await this.bitrix.getPayment({
        domain: command.domain,
        accessToken: executorToken,
        paymentId: command.bitrixPaymentId,
      });
      const after = await this.bitrix.listDealPaymentIds({
        domain: command.domain,
        accessToken: actorToken,
        dealId: command.bitrixDealId,
      });
      if (!after.includes(command.bitrixPaymentId)) {
        throw new ApiError(
          409,
          'BITRIX24_PAYMENT_MEMBERSHIP_MISMATCH',
          'Updated payment is not visible in the expected Deal',
        );
      }
      const normalized = normalizeBitrixPayment(command.bitrixPaymentId, payment);
      if (
        normalized.paySystemId !== command.paySystemId ||
        normalized.amount.toFixed(2) !== command.amount ||
        normalized.currencyId !== command.currencyId ||
        !normalized.paid ||
        text(payment.xmlId ?? payment.XML_ID) !== xmlId ||
        !normalized.paymentDate ||
        dateInPortalTimezone(normalized.paymentDate, this.config.getReverseSync().portalTimezone) !== command.paymentDate
      ) {
        throw new ApiError(
          502,
          'BITRIX24_PAYMENT_VERIFICATION_FAILED',
          'Bitrix24 returned payment fields that differ from the command',
        );
      }
      const saved = await this.repository.saveVerifiedSnapshot({
        command,
        paymentName: normalized.paySystemName,
        paidAt: normalized.paymentDate,
        normalizedHash: normalized.normalizedHash,
        rawAmount: normalized.amount.toFixed(2),
        rawCurrency: normalized.currencyId,
        expectedGen: fence,
      });
      if (saved.applied) return saved.command;
    }
    throw new ApiError(
      409,
      'BITRIX24_PAYMENT_SYNC_STALE',
      'Bitrix24 payment state changed during verification; retry the command',
    );
  }

  private async commandActorToken(command: ManualPaymentCommand): Promise<string> {
    const cipher = new Bitrix24TokenCipher(
      this.requireWidgetConfig().commandTokenEncryptionKey,
    );
    if (
      command.callerAccessTokenCiphertext &&
      command.callerAccessTokenExpiresAt &&
      command.callerAccessTokenExpiresAt.getTime() > Date.now() + 30_000
    ) {
      return cipher.decrypt(command.callerAccessTokenCiphertext);
    }
    if (!command.callerRefreshTokenCiphertext) {
      throw new ApiError(
        409,
        'BITRIX24_ACTOR_REAUTH_REQUIRED',
        'Original Bitrix24 actor must reopen the Deal widget',
      );
    }
    let refreshed: Awaited<ReturnType<Bitrix24OAuthTokenService['refreshCallerToken']>>;
    try {
      refreshed = await this.installationTokens.refreshCallerToken({
        domain: command.domain,
        memberId: command.memberId,
        refreshToken: cipher.decrypt(command.callerRefreshTokenCiphertext),
      });
      const user = await this.bitrix.currentUser({
        domain: command.domain,
        accessToken: refreshed.accessToken,
      });
      if (!user.active || user.id !== command.bitrixActorUserId) {
        throw new ApiError(
          403,
          'BITRIX24_ACTOR_MISMATCH',
          'Refreshed token belongs to another Bitrix24 user',
        );
      }
      await this.repository.refreshCommandCallerTokens({
        commandId: command.commandId,
        actorBitrixUserId: command.bitrixActorUserId,
        accessTokenCiphertext: cipher.encrypt(refreshed.accessToken),
        refreshTokenCiphertext: cipher.encrypt(refreshed.refreshToken),
        accessTokenExpiresAt: refreshed.expiresAt,
      });
      return refreshed.accessToken;
    } catch {
      throw new ApiError(
        409,
        'BITRIX24_ACTOR_REAUTH_REQUIRED',
        'Original Bitrix24 actor must reopen the Deal widget',
      );
    }
  }

  private async requireOwnedCommand(
    authenticated: AuthenticatedWidgetSession,
    commandId: string,
  ): Promise<ManualPaymentCommand> {
    const command = await this.repository.getCommand(commandId);
    if (
      !command ||
      command.memberId !== authenticated.session.memberId ||
      command.domain !== authenticated.session.domain ||
      command.bitrixDealId !== authenticated.session.dealId ||
      command.bitrixActorUserId !== authenticated.session.bitrixUserId ||
      command.erpActorUserId !== Number(authenticated.actor.id)
    ) {
      throw new ApiError(404, 'BITRIX24_PAYMENT_COMMAND_NOT_FOUND', 'Payment command not found');
    }
    return command;
  }

  private assertCurrency(dealItem: Record<string, unknown>): void {
    const currency = text(dealItem.currencyId ?? dealItem.CURRENCY_ID);
    if (currency !== this.config.getBitrix24().currencyId) {
      throw new ApiError(
        409,
        'BITRIX24_PAYMENT_CURRENCY_MISMATCH',
        'Bitrix24 Deal currency must be KZT',
      );
    }
  }

  private assertVersion(body: CreateWidgetPaymentInput, deal: WidgetDealContext): void {
    if (
      deal.orderId !== null &&
      (body.expectedOrderVersion === null || body.expectedOrderVersion !== deal.orderVersion)
    ) {
      throw new ApiError(409, 'ORDER_VERSION_STALE', 'ERP order changed; reload widget context');
    }
  }

  private assertPreflightOverpayment(
    body: CreateWidgetPaymentInput,
    deal: WidgetDealContext,
    actor: CurrentUser,
  ): void {
    // The overpayment-confirmation permission is enforced whenever the flag
    // is sent — a caller must not smuggle a raw confirm flag that becomes
    // effective only when a later locked check sees a real overpayment.
    if (
      body.confirmOverpayment &&
      !actor.permissions.includes('bitrix24.payments.confirm_overpayment')
    ) {
      throw new ApiError(
        403,
        'BITRIX24_WIDGET_PERMISSION_DENIED',
        'ERP user cannot confirm an overpayment',
      );
    }
    const total = numberOrNull(deal.finalAmount);
    const paid = numberOrNull(deal.paidAmount);
    // Remote paid snapshots not yet materialized and in-flight widget commands
    // reduce the remaining amount exactly once each. Integer minor units —
    // 0.30 - 0.20 must accept 0.10, not flag an overpayment.
    if (total === null || paid === null) return;
    const remainingCents =
      moneyToCents(deal.finalAmount) -
      moneyToCents(deal.paidAmount) -
      moneyToCents(deal.snapshotPaidAmount) -
      moneyToCents(deal.commandReservedAmount);
    if (moneyToCents(body.amount) <= remainingCents) return;
    if (!body.confirmOverpayment) {
      throw new ApiError(
        409,
        'PAYMENT_OVERPAYMENT_CONFIRMATION_REQUIRED',
        'Payment exceeds the remaining ERP order amount',
      );
    }
    if (!actor.permissions.includes('bitrix24.payments.confirm_overpayment')) {
      throw new ApiError(
        403,
        'BITRIX24_WIDGET_PERMISSION_DENIED',
        'ERP user cannot confirm an overpayment',
      );
    }
  }

  private requireWidgetConfig(): ReturnType<CrmSyncRuntimeConfigService['getPaymentWidget']> & {
    commandTokenEncryptionKey: string;
  } {
    const settings = this.config.getPaymentWidget();
    if (!settings.enabled || !settings.commandTokenEncryptionKey) {
      throw new ApiError(
        503,
        'BITRIX24_PAYMENT_WIDGET_DISABLED',
        'Bitrix24 payment widget is disabled',
      );
    }
    return settings as typeof settings & { commandTokenEncryptionKey: string };
  }
}

function responseFor(command: ManualPaymentCommand): WidgetCommandResponse {
  return {
    commandId: command.commandId,
    status: command.status,
    bitrixPaymentId: command.bitrixPaymentId,
    erpPaymentId: command.erpPaymentId,
    dealId: command.bitrixDealId,
    orderId: command.erpOrderId,
    amount: command.amount,
    currencyId: command.currencyId,
    paymentDate: command.paymentDate,
    message: commandMessage(command.status),
  };
}

function commandMessage(status: WidgetCommandStatus): string {
  if (status === 'completed') return 'Оплата добавлена в Bitrix24 и ERP';
  if (status === 'awaiting_order') return 'Оплата добавлена в Bitrix24 и ожидает создания заказа ERP';
  if (status === 'awaiting_order_ready') return 'Оплата добавлена в Bitrix24 и ожидает готовности заказа ERP';
  if (status === 'awaiting_overpayment_confirmation') {
    return 'Оплата добавлена в Bitrix24; подтвердите перенос переплаты в ERP';
  }
  if (status === 'remote_create_ambiguous') return 'Результат создания требует проверки администратора';
  if (status === 'awaiting_actor_reauth') return 'Переоткройте вкладку сделки для продолжения';
  return 'Команда сохранена и будет продолжена';
}

function dateInPortalTimezone(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function numberOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const result = String(value).trim();
  return result || null;
}

function errorCode(error: unknown): string {
  return error instanceof ApiError ? error.code : 'BITRIX24_PAYMENT_COMMAND_FAILED';
}

function safeError(error: unknown): string {
  return error instanceof ApiError ? `${error.code}: ${error.message}` : 'Unexpected command failure';
}
