import {
  Bitrix24ApiError,
  type Bitrix24ApiPort,
  type Bitrix24PaymentCard,
  type Bitrix24RequestGuard,
} from '../adapters/bitrix24-api-client';
import type {
  BeginPaidPaymentOperation,
  PaidPaymentOperation,
  PaidPaymentOutcome,
} from '../adapters/pg-crm-sync-paid-payment-operation-repository';
import {
  type Bitrix24MapperOptions,
  mapPayment,
  paymentXmlId,
} from './bitrix24-sync-mapper';
import type { PaymentRow } from './crm-sync.types';

/** Durable operation state (PgCrmSyncPaidPaymentOperationRepository). */
export interface PaidPaymentOperationStore {
  findOpen(erpPaymentId: string): Promise<PaidPaymentOperation | null>;
  /** Open operations of this order or of any of these ERP payments. */
  listOpenFor(erpOrderId: string, erpPaymentIds: string[]): Promise<PaidPaymentOperation[]>;
  listDue(limit: number): Promise<PaidPaymentOperation[]>;
  begin(input: BeginPaidPaymentOperation): Promise<PaidPaymentOperation>;
  markUnpaid(operation: PaidPaymentOperation, requestId: string): Promise<PaidPaymentOperation>;
  switchToDelete(operation: PaidPaymentOperation, requestId: string): Promise<PaidPaymentOperation>;
  complete(
    operation: PaidPaymentOperation,
    outcome: PaidPaymentOutcome,
    options: { requestId: string; reproject: boolean; bitrixSumAfter?: number | null },
  ): Promise<boolean>;
  recordFailure(operation: PaidPaymentOperation, error: string, requestId: string): Promise<void>;
  /**
   * Audit of closing the open payment cards after a paid reset: `requested` (written BEFORE Bitrix24 is
   * called), then `closed` or `failed`. A failure to write throws, so the operation is not completed
   * and recovery repeats the step.
   */
  recordPaymentCards(operation: PaidPaymentOperation, result: PaymentCardsResult, requestId: string): Promise<void>;
}

export interface PaymentCardsResult {
  stage: 'requested' | 'closed' | 'failed';
  /** Bitrix24 activity ids of the cards (to close, or closed). */
  cardIds: string[];
  /** Amount each card shows, as Bitrix24 kept it (null: the card has none). */
  cardSums: Array<number | null>;
  /** Amount applied to the payment by this step. */
  appliedSum: number;
  error: string | null;
}

export interface PaidPaymentSource {
  /** Current ERP payment, or null when it no longer exists (or is deleted). */
  getPaymentById(paymentId: string): Promise<PaymentRow | null>;
}

/** Whether a NEW operation may start for this order (recovery of started ones is never limited). */
export interface PaidPaymentStartPolicy {
  enabled: boolean;
  /** Empty = every order. */
  orderIds: ReadonlySet<string>;
}

interface Bitrix24PaidPaymentGuardDeps {
  bitrix: Bitrix24ApiPort;
  store: PaidPaymentOperationStore;
  source: PaidPaymentSource;
  options: Bitrix24MapperOptions;
  policy: () => PaidPaymentStartPolicy;
}

interface RemotePayment {
  paid: boolean;
  sum: number | null;
  currency: string | null;
  xmlId: string | null;
  paySystemId: number | null;
}

/** Steps an operation may need: unpay, apply/delete, plus a switch to delete. */
const MAX_STEPS = 4;

/**
 * Changes and deletes ERP payments in Bitrix24 although Bitrix24 holds them as «Оплачено».
 *
 * ERP is authoritative for its payments (user decision 2026-10-14). Bitrix24 refuses to change the
 * amount of a paid payment and to delete it, so the paid flag is removed first and set back by the
 * full update. Only a payment that Bitrix24 shows with OUR xmlId is ever touched this way; every
 * phase is committed before the next call, and each step starts from the observed Bitrix24 and ERP
 * state, so a crash, a lost response or a lost lease is finished by recovery.
 */
export class Bitrix24PaidPaymentGuard {
  constructor(private readonly deps: Bitrix24PaidPaymentGuardDeps) {}

  /**
   * Updates an ERP payment in Bitrix24. Returns `applied`, or the terminal outcome when the payment
   * turned out to be gone (`remote_missing`/`deleted`): the caller must not record it as synced —
   * the operation already queued a fresh projection of the order.
   */
  async update(input: {
    payment: PaymentRow;
    dealId: string;
    bitrixId: string;
    fields: Record<string, unknown>;
    requestId: string;
  }): Promise<PaidPaymentOutcome> {
    const { payment, bitrixId, fields } = input;
    await this.settle(payment.paymentId, input.requestId);
    try {
      await this.deps.bitrix.updatePayment(bitrixId, fields);
      return 'applied';
    } catch (error) {
      if (!isRejection(error) || !this.canStart(payment.orderId)) throw error;
      const remote = await this.read(bitrixId);
      const targetSum = Number(fields.sum);
      if (
        !remote ||
        !ownedBy(remote, payment.paymentId) ||
        !remote.paid ||
        sameAmount(remote.sum, targetSum) ||
        !(targetSum > 0) ||
        (remote.currency !== null && remote.currency !== String(fields.psCurrency))
      ) {
        throw error;
      }
      const operation = await this.deps.store.begin({
        erpPaymentId: payment.paymentId,
        erpOrderId: payment.orderId,
        bitrixPaymentId: bitrixId,
        bitrixDealId: input.dealId,
        action: 'update',
        bitrixSumBefore: remote.sum,
        bitrixCurrency: remote.currency,
        targetSum,
        originOutboxEventId: uuidOrNull(input.requestId),
      });
      return this.drive(operation, input.requestId, false);
    }
  }

  /**
   * Deletes an ERP payment in Bitrix24. Ownership is proven for EVERY candidate before any delete:
   * a payment Bitrix24 shows without our exact xmlId (a manager's payment, or a create whose
   * tagging never happened) is never deleted. A payment already gone is a success.
   */
  async delete(input: {
    erpPaymentId: string;
    erpOrderId: string;
    dealId: string | null;
    bitrixId: string;
    requestId: string;
  }): Promise<void> {
    await this.settle(input.erpPaymentId, input.requestId);
    const remote = await this.read(input.bitrixId);
    if (!remote) return;
    if (!ownedBy(remote, input.erpPaymentId)) {
      throw new Error(
        `BITRIX24_PAYMENT_NOT_OWNED: Bitrix payment ${input.bitrixId} is not ERP payment ` +
        `${input.erpPaymentId}; automatic delete is blocked`,
      );
    }
    if (!remote.paid || !this.canStart(input.erpOrderId)) {
      // Unpaid: an ordinary delete. Paid while starting is not allowed: Bitrix24's own refusal.
      await this.deps.bitrix.deletePayment(input.bitrixId);
      return;
    }
    const operation = await this.deps.store.begin({
      erpPaymentId: input.erpPaymentId,
      erpOrderId: input.erpOrderId,
      bitrixPaymentId: input.bitrixId,
      bitrixDealId: input.dealId,
      action: 'delete',
      bitrixSumBefore: remote.sum,
      bitrixCurrency: remote.currency,
      targetSum: null,
      originOutboxEventId: uuidOrNull(input.requestId),
    });
    await this.drive(operation, input.requestId, false);
  }

  /**
   * Finishes the open operation of this ERP payment BEFORE the caller discovers or creates Bitrix
   * payments, so no replacement create can start while an old operation is unfinished.
   */
  async settle(erpPaymentId: string, requestId: string): Promise<void> {
    const open = await this.deps.store.findOpen(erpPaymentId);
    if (open) await this.drive(open, requestId, true);
  }

  /** Same for every open operation of an order (and of its current/mapped payments). */
  async settleOrder(erpOrderId: string, erpPaymentIds: string[], requestId: string): Promise<void> {
    for (const open of await this.deps.store.listOpenFor(erpOrderId, erpPaymentIds)) {
      await this.drive(open, requestId, true);
    }
  }

  /**
   * Finishes due operations, independent of the outbox events that started them. Runs under the
   * live writer; every Bitrix24 request first proves that ownership (`requestGuard`).
   */
  async recoverDue(
    requestGuard: Bitrix24RequestGuard,
    limit = 20,
  ): Promise<{ completed: number; failed: number }> {
    return this.deps.bitrix.withRequestGuard(requestGuard, async () => {
      let completed = 0;
      let failed = 0;
      for (const operation of await this.deps.store.listDue(limit)) {
        try {
          await this.drive(operation, `recovery:${operation.operationId}`, true);
          completed++;
        } catch {
          failed++;
        }
      }
      return { completed, failed };
    });
  }

  private canStart(orderId: string): boolean {
    const policy = this.deps.policy();
    return policy.enabled && (policy.orderIds.size === 0 || policy.orderIds.has(orderId));
  }

  private async drive(
    initial: PaidPaymentOperation,
    requestId: string,
    reproject: boolean,
  ): Promise<PaidPaymentOutcome> {
    let operation = initial;
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const next = await this.step(operation, requestId, reproject);
        if (typeof next === 'string') return next;
        operation = next;
      }
      throw new Error(
        `CRM sync: paid payment operation ${operation.operationId} did not finish in ${MAX_STEPS} steps`,
      );
    } catch (error) {
      await this.deps.store.recordFailure(
        operation,
        error instanceof Error ? error.message : String(error),
        requestId,
      );
      throw error;
    }
  }

  /** One observation-driven step (plan §3 table). */
  private async step(
    operation: PaidPaymentOperation,
    requestId: string,
    reproject: boolean,
  ): Promise<PaidPaymentOperation | PaidPaymentOutcome> {
    const id = operation.bitrixPaymentId;
    const remote = await this.read(id);
    if (!remote) {
      // The payment is gone: the current projection is stale, so the order is always reprojected
      // (also inline), never left to an event that would record the vanished payment as synced.
      const outcome = operation.action === 'delete' ? 'deleted' : 'remote_missing';
      await this.deps.store.complete(operation, outcome, { requestId, reproject: true });
      return outcome;
    }
    if (!ownedBy(remote, operation.erpPaymentId)) {
      throw new Error(
        `BITRIX24_PAYMENT_NOT_OWNED: Bitrix payment ${id} is not ERP payment ${operation.erpPaymentId}`,
      );
    }

    if (operation.action === 'update') {
      const payment = await this.deps.source.getPaymentById(operation.erpPaymentId);
      if (!payment) return this.deps.store.switchToDelete(operation, requestId);
      const fields = mapPayment(payment, this.deps.options).fields;
      const targetSum = Number(fields.sum);
      if (remote.paid && !sameAmount(remote.sum, targetSum)) {
        if (!(targetSum > 0)) throw new Error(`CRM sync: ERP payment ${payment.paymentId} has no positive amount`);
        await this.deps.bitrix.updatePayment(id, this.unpaidFields(remote));
        return this.deps.store.markUnpaid(operation, requestId);
      }
      // Unpaid, or paid with the current amount (incl. a lost response of the full update):
      // the full update sets the fields and the flag back.
      await this.deps.bitrix.updatePayment(id, fields);
      // Before completion: a crash or an audit failure leaves the operation open, and recovery
      // repeats this step (the payment update is idempotent, a closed card is not listed again).
      await this.closeOpenCards(operation, targetSum, requestId);
      await this.deps.store.complete(operation, 'applied', {
        requestId,
        reproject,
        bitrixSumAfter: targetSum,
      });
      return 'applied';
    }

    if (remote.paid) {
      await this.deps.bitrix.updatePayment(id, this.unpaidFields(remote));
      return this.deps.store.markUnpaid(operation, requestId);
    }
    await this.deps.bitrix.deletePayment(id);
    await this.deps.store.complete(operation, 'deleted', { requestId, reproject });
    return 'deleted';
  }

  /**
   * Closes every open «Поступила оплата от клиента» card of the payment after the paid reset, same as
   * the «Обработано» button. Bitrix24 keeps one card per payment with the amount of the moment it was
   * first marked paid; setting the flag back reopens that card (production, 18.10: a closed card came
   * back when the amount returned to the old one), so an open card here is an effect of ERP's own
   * unpaid → paid switch, whatever amount it shows, not a new payment from the client.
   * Runs after the payment carries the new amount and before the operation completes. Only a
   * Bitrix24 error is audited as a failed close and does not stop the payment; any other error (lost
   * writer ownership from the request guard, an audit write) propagates, the operation stays open and
   * recovery repeats the step. Closed cards are left as they are.
   */
  private async closeOpenCards(
    operation: PaidPaymentOperation,
    appliedSum: number,
    requestId: string,
  ): Promise<void> {
    const { bitrix, store } = this.deps;
    if (!bitrix.listPaymentCards || !bitrix.completeActivity) return;
    // The paid-reset flag and order allowlist also stop closing for operations already started.
    if (!this.canStart(operation.erpOrderId)) return;
    let open: Bitrix24PaymentCard[];
    try {
      open = (await bitrix.listPaymentCards(operation.bitrixPaymentId))
        .filter((card) => !card.completed);
    } catch (error) {
      if (!(error instanceof Bitrix24ApiError)) throw error;
      await store.recordPaymentCards(operation, {
        stage: 'failed', cardIds: [], cardSums: [], appliedSum, error: error.message,
      }, requestId);
      return;
    }
    if (open.length === 0) return;
    const cardIds = open.map((card) => card.id);
    const cardSums = open.map((card) => card.sum);
    await store.recordPaymentCards(operation, { stage: 'requested', cardIds, cardSums, appliedSum, error: null }, requestId);
    const closed: string[] = [];
    try {
      for (const card of open) {
        await bitrix.completeActivity(card.id);
        closed.push(card.id);
      }
    } catch (error) {
      if (!(error instanceof Bitrix24ApiError)) throw error;
      await store.recordPaymentCards(operation, {
        stage: 'failed', cardIds: closed, cardSums, appliedSum, error: error.message,
      }, requestId);
      return;
    }
    await store.recordPaymentCards(operation, { stage: 'closed', cardIds, cardSums, appliedSum, error: null }, requestId);
  }

  private async read(id: string): Promise<RemotePayment | null> {
    let payment: Record<string, unknown>;
    try {
      payment = await this.deps.bitrix.getPayment(id);
    } catch (error) {
      if (error instanceof Bitrix24ApiError && error.isNotFound) return null;
      throw error;
    }
    const sum = Number(payment.sum);
    return {
      paid: String(payment.paid ?? '').toUpperCase() === 'Y',
      sum: Number.isFinite(sum) ? sum : null,
      currency: typeof payment.currency === 'string' && payment.currency ? payment.currency : null,
      xmlId: typeof payment.xmlId === 'string' ? payment.xmlId : null,
      paySystemId: positiveInteger(payment.paySystemId),
    };
  }

  /**
   * Fields that only remove the paid flag. sale.payment.update rejects an update without paySystemId
   * («Required fields: paySystemId», production 15.10), so the payment's own pay system is sent back
   * unchanged; the configured one only when Bitrix24 did not report it.
   */
  private unpaidFields(remote: RemotePayment): Record<string, unknown> {
    return { paid: 'N', paySystemId: remote.paySystemId ?? this.deps.options.paySystemId };
  }
}

function isRejection(error: unknown): boolean {
  return error instanceof Bitrix24ApiError && error.status === 400;
}

function ownedBy(remote: RemotePayment, erpPaymentId: string): boolean {
  return remote.xmlId === paymentXmlId(erpPaymentId);
}

function sameAmount(left: number | null, right: number): boolean {
  return left !== null && Math.round(left * 100) === Math.round(right * 100);
}

function uuidOrNull(value: string): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
