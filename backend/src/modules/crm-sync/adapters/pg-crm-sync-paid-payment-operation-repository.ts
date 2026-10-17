import { randomUUID } from 'node:crypto';
import type { AuditService } from '../../../common/audit/audit.service';
import type { AuditEvent } from '../../../common/audit/audit-event.types';
import type { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { PaymentCardsResult } from '../application/bitrix24-paid-payment-guard';

const PAYMENT_CARD_EVENTS: Record<PaymentCardsResult['stage'], string> = {
  requested: 'crm_sync.payment_card_close_requested',
  closed: 'crm_sync.payment_card_closed',
  failed: 'crm_sync.payment_card_close_failed',
};

export type PaidPaymentAction = 'update' | 'delete';
export type PaidPaymentPhase = 'requested' | 'unpaid' | 'completed';
export type PaidPaymentOutcome = 'applied' | 'deleted' | 'remote_missing';

export interface PaidPaymentOperation {
  operationId: string;
  erpPaymentId: string;
  erpOrderId: string;
  bitrixPaymentId: string;
  bitrixDealId: string | null;
  action: PaidPaymentAction;
  phase: PaidPaymentPhase;
  attempts: number;
  stuckAt: string | null;
  originOutboxEventId: string | null;
  bitrixSumBefore: number | null;
  targetSum: number | null;
}

export interface BeginPaidPaymentOperation {
  erpPaymentId: string;
  erpOrderId: string;
  bitrixPaymentId: string;
  bitrixDealId: string | null;
  action: PaidPaymentAction;
  bitrixSumBefore: number | null;
  bitrixCurrency: string | null;
  targetSum: number | null;
  originOutboxEventId: string | null;
}

/** Attempts after which an operation is flagged stuck (it keeps being retried). */
export const PAID_RESET_STUCK_AFTER_ATTEMPTS = 5;
const BACKOFF_MINUTES = [1, 5, 15, 60];

interface OperationRow {
  operation_id: string;
  erp_payment_id: string | number;
  erp_order_id: string | number;
  bitrix_payment_id: string;
  bitrix_deal_id: string | null;
  action: PaidPaymentAction;
  phase: PaidPaymentPhase;
  attempts: number | string;
  stuck_at: Date | string | null;
  origin_outbox_event_id: string | null;
  bitrix_sum_before: string | number | null;
  target_sum: string | number | null;
}

const COLUMNS = `operation_id, erp_payment_id, erp_order_id, bitrix_payment_id, bitrix_deal_id,
  action, phase, attempts, stuck_at, origin_outbox_event_id, bitrix_sum_before, target_sum`;

/**
 * Durable state of «paid payment» operations. Every phase change commits together with its audit
 * row (and the domain event of a terminal state), so nothing depends on the caller's SyncIntent
 * being persisted later.
 */
export class PgCrmSyncPaidPaymentOperationRepository {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async findOpen(erpPaymentId: string): Promise<PaidPaymentOperation | null> {
    const result = await this.db.query<OperationRow>(
      `SELECT ${COLUMNS} FROM crm_sync_paid_payment_operation
        WHERE erp_payment_id=$1 AND phase <> 'completed'`,
      [erpPaymentId],
    );
    return result.rows[0] ? toOperation(result.rows[0]) : null;
  }

  async listOpenFor(erpOrderId: string, erpPaymentIds: string[]): Promise<PaidPaymentOperation[]> {
    const result = await this.db.query<OperationRow>(
      `SELECT ${COLUMNS} FROM crm_sync_paid_payment_operation
        WHERE phase <> 'completed'
          AND (erp_order_id=$1 OR erp_payment_id = ANY($2::bigint[]))
        ORDER BY created_at`,
      [erpOrderId, erpPaymentIds],
    );
    return result.rows.map(toOperation);
  }

  async listDue(limit: number): Promise<PaidPaymentOperation[]> {
    const result = await this.db.query<OperationRow>(
      `SELECT ${COLUMNS} FROM crm_sync_paid_payment_operation
        WHERE phase <> 'completed' AND next_attempt_at <= now()
        ORDER BY next_attempt_at, created_at
        LIMIT $1`,
      [limit],
    );
    return result.rows.map(toOperation);
  }

  /** Starts an operation, or returns the one already open for this ERP payment. */
  async begin(input: BeginPaidPaymentOperation): Promise<PaidPaymentOperation> {
    const started = await this.db.transaction(async (tx) => {
      const inserted = await tx.query<OperationRow>(
        `INSERT INTO crm_sync_paid_payment_operation (
           operation_id, erp_payment_id, erp_order_id, bitrix_payment_id, bitrix_deal_id, action,
           bitrix_sum_before, bitrix_currency, target_sum, origin_outbox_event_id
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (erp_payment_id) WHERE phase <> 'completed' DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          randomUUID(),
          input.erpPaymentId,
          input.erpOrderId,
          input.bitrixPaymentId,
          input.bitrixDealId,
          input.action,
          input.bitrixSumBefore,
          input.bitrixCurrency,
          input.targetSum,
          input.originOutboxEventId,
        ],
      );
      const row = inserted.rows[0];
      if (!row) return null;
      const operation = toOperation(row);
      await this.audit.record(tx, this.auditEvent(operation, 'crm_sync.payment_paid_reset_requested', {
        before: { bitrixPaid: true, bitrixSum: input.bitrixSumBefore, bitrixCurrency: input.bitrixCurrency },
        after: { phase: 'requested', action: input.action, targetSum: input.targetSum },
      }));
      return operation;
    });
    if (started) return started;
    const open = await this.findOpen(input.erpPaymentId);
    if (!open) throw new Error(`CRM sync: paid payment operation race for ERP payment ${input.erpPaymentId}`);
    return open;
  }

  async markUnpaid(operation: PaidPaymentOperation, requestId: string): Promise<PaidPaymentOperation> {
    return this.db.transaction(async (tx) => {
      const row = await this.updateOpen(tx, operation.operationId, `phase='unpaid'`);
      const next = row ? toOperation(row) : { ...operation, phase: 'unpaid' as const };
      if (row && operation.phase !== 'unpaid') {
        await this.audit.record(tx, this.auditEvent(next, 'crm_sync.payment_paid_reset_unpaid', {
          requestId,
          before: { phase: operation.phase },
          after: { phase: 'unpaid', bitrixPaid: false },
        }));
      }
      return next;
    });
  }

  /** An update whose ERP payment disappeared becomes a delete of the confirmed Bitrix payment. */
  async switchToDelete(operation: PaidPaymentOperation, requestId: string): Promise<PaidPaymentOperation> {
    if (operation.action === 'delete') return operation;
    return this.db.transaction(async (tx) => {
      const row = await this.updateOpen(tx, operation.operationId, `action='delete', target_sum=NULL`);
      const next = row ? toOperation(row) : { ...operation, action: 'delete' as const, targetSum: null };
      if (row) {
        await this.audit.record(tx, this.auditEvent(next, 'crm_sync.payment_paid_reset_action_changed', {
          requestId,
          before: { action: 'update' },
          after: { action: 'delete', reason: 'erp_payment_deleted' },
        }));
      }
      return next;
    });
  }

  /**
   * Terminal state. For a delete (or a payment already gone in Bitrix) the create guard and the
   * mapping of the ERP payment are cleared in the same transaction, so a retry never searches for
   * the payment again. With `reproject`, the original order and the payment's current order get a
   * fresh upsert event (as the crm_sync_enqueue trigger does), independent of the originating event.
   */
  async complete(
    operation: PaidPaymentOperation,
    outcome: PaidPaymentOutcome,
    options: { requestId: string; reproject: boolean; bitrixSumAfter?: number | null },
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const result = await tx.query<OperationRow>(
        `UPDATE crm_sync_paid_payment_operation
            SET phase='completed', remote_outcome=$2, completed_at=now(), updated_at=now(),
                stuck_at=NULL, last_error=NULL
          WHERE operation_id=$1 AND phase <> 'completed'
          RETURNING ${COLUMNS}`,
        [operation.operationId, outcome],
      );
      const row = result.rows[0];
      if (!row) return false;
      const done = toOperation(row);

      if (outcome !== 'applied') {
        // Only what belongs to THIS operation: the create guard of its own Deal and the mapping
        // that still points at its own Bitrix payment — never a replacement on another Deal.
        if (done.bitrixDealId) {
          await tx.query(
            'DELETE FROM crm_sync_payment_create_guard WHERE erp_payment_id=$1 AND bitrix_deal_id=$2',
            [done.erpPaymentId, done.bitrixDealId],
          );
        }
        await tx.query(
          `UPDATE crm_sync_mapping
              SET status='deleted', last_error=NULL, last_synced_at=now(), updated_at=now()
            WHERE entity_type='payment' AND erp_id=$1 AND bitrix_id=$2 AND status <> 'deleted'`,
          [done.erpPaymentId, done.bitrixPaymentId],
        );
      }

      const reprojected = options.reproject ? await this.reprojectOrders(tx, done) : [];

      await this.audit.record(tx, this.auditEvent(done, 'crm_sync.payment_paid_reset_completed', {
        requestId: options.requestId,
        before: { phase: operation.phase, bitrixSum: operation.bitrixSumBefore },
        after: {
          phase: 'completed',
          outcome,
          action: done.action,
          bitrixSum: options.bitrixSumAfter ?? null,
          bitrixPaid: outcome === 'applied' ? true : null,
        },
        metadata: { reprojectedOrderIds: reprojected },
      }));
      await enqueueDomainEvent(tx, {
        eventType: 'bitrix24.payment_paid_reset.completed',
        aggregateType: 'payment',
        aggregateId: done.erpPaymentId,
        idempotencyKey: `paid-reset:${done.operationId}:completed`,
        payload: {
          operationId: done.operationId,
          paymentId: Number(done.erpPaymentId),
          orderId: Number(done.erpOrderId),
          bitrixPaymentId: done.bitrixPaymentId,
          action: done.action,
          outcome,
          requestId: options.requestId,
        },
      });
      return true;
    });
  }

  /** Records a failed step: backoff, and a one-time stuck flag after the threshold. */
  async recordFailure(operation: PaidPaymentOperation, error: string, requestId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const attempts = operation.attempts + 1;
      const delayMinutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1];
      const result = await tx.query<OperationRow>(
        `UPDATE crm_sync_paid_payment_operation
            SET attempts=attempts+1, last_error=$2, updated_at=now(),
                next_attempt_at=now() + ($3::int * interval '1 minute'),
                stuck_at=CASE WHEN attempts+1 >= $4 AND stuck_at IS NULL THEN now() ELSE stuck_at END
          WHERE operation_id=$1 AND phase <> 'completed'
          RETURNING ${COLUMNS}`,
        [operation.operationId, error.slice(0, 1000), delayMinutes, PAID_RESET_STUCK_AFTER_ATTEMPTS],
      );
      const row = result.rows[0];
      if (!row) return;
      const next = toOperation(row);
      if (operation.stuckAt === null && next.stuckAt !== null) {
        await this.audit.record(tx, this.auditEvent(next, 'crm_sync.payment_paid_reset_stuck', {
          requestId,
          after: { phase: next.phase, attempts: next.attempts },
          metadata: { error: error.slice(0, 1000) },
        }));
        await enqueueDomainEvent(tx, {
          eventType: 'bitrix24.payment_paid_reset.stuck',
          aggregateType: 'payment',
          aggregateId: next.erpPaymentId,
          idempotencyKey: `paid-reset:${next.operationId}:stuck:${next.attempts}`,
          payload: {
            operationId: next.operationId,
            paymentId: Number(next.erpPaymentId),
            orderId: Number(next.erpOrderId),
            bitrixPaymentId: next.bitrixPaymentId,
            action: next.action,
            phase: next.phase,
            attempts: next.attempts,
            requestId,
          },
        });
      }
    });
  }

  async recordPaymentCards(
    operation: PaidPaymentOperation,
    result: PaymentCardsResult,
    requestId: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.audit.record(tx, this.auditEvent(operation, PAYMENT_CARD_EVENTS[result.stage], {
        requestId,
        before: { cardSums: result.cardSums },
        after: { sum: result.appliedSum, cardIds: result.cardIds },
        metadata: result.error === null ? {} : { error: result.error.slice(0, 1000) },
      }));
    });
  }

  private async updateOpen(tx: DatabaseClient, operationId: string, assignments: string): Promise<OperationRow | null> {
    const result = await tx.query<OperationRow>(
      `UPDATE crm_sync_paid_payment_operation
          SET ${assignments}, updated_at=now()
        WHERE operation_id=$1 AND phase <> 'completed'
        RETURNING ${COLUMNS}`,
      [operationId],
    );
    return result.rows[0] ?? null;
  }

  private async reprojectOrders(tx: DatabaseClient, operation: PaidPaymentOperation): Promise<number[]> {
    const current = await tx.query<{ order_id: string | number }>(
      'SELECT order_id FROM payments WHERE payment_id=$1 AND delete_flag=false',
      [operation.erpPaymentId],
    );
    const orderIds = [...new Set([
      String(operation.erpOrderId),
      ...current.rows.map((row) => String(row.order_id)),
    ])];
    for (const orderId of orderIds) {
      const order = await tx.query<{ client_id: string | number | null }>(
        'SELECT client_id FROM orders WHERE order_id=$1',
        [orderId],
      );
      const clientId = order.rows[0]?.client_id == null ? null : String(order.rows[0].client_id);
      const key = `order:${orderId}`;
      await tx.query(`DELETE FROM crm_sync_outbox WHERE idempotency_key=$1 AND status='pending'`, [key]);
      await tx.query(
        `INSERT INTO crm_sync_outbox (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
         VALUES ('crm.sync.order.upsert', 'crm_sync', $1,
                 jsonb_build_object('entity','order','id',$1::text,'op','upsert','clientId',$2::text), $3)`,
        [orderId, clientId, key],
      );
    }
    return orderIds.map(Number);
  }

  private auditEvent(
    operation: PaidPaymentOperation,
    event: string,
    extra: Partial<Pick<AuditEvent, 'requestId' | 'before' | 'after' | 'metadata'>>,
  ): AuditEvent {
    return {
      event,
      entityType: 'payment',
      entityId: operation.erpPaymentId,
      requestId: extra.requestId ?? operation.originOutboxEventId ?? `recovery:${operation.operationId}`,
      source: 'crm-sync',
      actorUserId: null,
      relatedOrderId: Number(operation.erpOrderId),
      relatedPaymentId: Number(operation.erpPaymentId),
      before: extra.before ?? null,
      after: extra.after ?? null,
      metadata: {
        operationId: operation.operationId,
        bitrixPaymentId: operation.bitrixPaymentId,
        bitrixDealId: operation.bitrixDealId,
        ...(extra.metadata ?? {}),
      },
    };
  }
}

function toOperation(row: OperationRow): PaidPaymentOperation {
  return {
    operationId: row.operation_id,
    erpPaymentId: String(row.erp_payment_id),
    erpOrderId: String(row.erp_order_id),
    bitrixPaymentId: row.bitrix_payment_id,
    bitrixDealId: row.bitrix_deal_id,
    action: row.action,
    phase: row.phase,
    attempts: Number(row.attempts),
    stuckAt: row.stuck_at == null ? null : new Date(row.stuck_at).toISOString(),
    originOutboxEventId: row.origin_outbox_event_id,
    bitrixSumBefore: row.bitrix_sum_before == null ? null : Number(row.bitrix_sum_before),
    targetSum: row.target_sum == null ? null : Number(row.target_sum),
  };
}

async function enqueueDomainEvent(
  tx: DatabaseClient,
  input: {
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
     VALUES ($1,$2,$3,$4::jsonb,$5)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [input.eventType, input.aggregateType, input.aggregateId, JSON.stringify(input.payload), input.idempotencyKey],
  );
}
