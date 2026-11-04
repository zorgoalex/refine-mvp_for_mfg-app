import type { TransactionClient } from '../../database/database.types';

/**
 * Context of the `order.payment_status_changed` event that the DB trigger on `orders.payment_status_id` writes
 * (migration 291). Transaction-local GUCs only: `app.user_id` from `set_session_user` lives on the pooled
 * connection and may belong to a previous request, so the trigger never reads it.
 *
 * Every backend path that changes `orders.payment_status_id` calls this before its UPDATE with the same actor and
 * request id that its audit record uses; a path without a user (integration worker) passes `actorUserId: null`.
 */
export interface PaymentStatusEventContext {
  actorUserId: string | number | null;
  /** Writer path, e.g. `payments`, `orders`, `crm-sync-widget`. */
  source: string;
  /** Correlation id of the path's audit record; omitted → the trigger falls back to `erp.request_id`. */
  correlationId?: string | null;
}

export async function setPaymentStatusEventContext(
  tx: TransactionClient,
  context: PaymentStatusEventContext,
): Promise<void> {
  await tx.query(
    `SELECT set_config('erp.event_actor_user_id', $1, true),
            set_config('erp.event_source', $2, true),
            set_config('erp.event_correlation_id', $3, true)`,
    [
      context.actorUserId === null || context.actorUserId === undefined ? '' : String(context.actorUserId),
      context.source,
      context.correlationId ?? '',
    ],
  );
}

/**
 * The path wrote `order.payment_status_changed` to the outbox itself (production action «статус оплаты», with its
 * command idempotency key): the trigger stays silent in this transaction, so there is exactly one producer.
 */
export async function markPaymentStatusEventEmitted(tx: TransactionClient): Promise<void> {
  await tx.query("SELECT set_config('erp.payment_status_event', 'emitted', true)");
}

/**
 * Service bulk updates (backfills, data migrations) that must not notify: the trigger requires a reason and stays
 * silent; the caller writes its own summary audit.
 */
export async function suppressPaymentStatusEvents(tx: TransactionClient, reason: string): Promise<void> {
  if (!reason.trim()) throw new Error('suppressPaymentStatusEvents requires a reason');
  await tx.query(
    `SELECT set_config('erp.payment_status_event', 'suppressed', true),
            set_config('erp.payment_status_event_reason', $1, true)`,
    [reason],
  );
}
