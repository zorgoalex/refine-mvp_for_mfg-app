import type { AuditService } from '../../../common/audit/audit.service';
import type { AuditRelatedEntity } from '../../../common/audit/related-entities';
import type { DatabaseService } from '../../../database/database.service';
import type { PaymentNotificationPayload } from '../../payments/application/payment-change-notification';

export type NotificationCommentState = 'none' | 'attempting' | 'created' | 'unresolved' | 'resolved' | 'unknown' | 'failed';
export type NotificationNotifyState = 'none' | 'attempting' | 'sent' | 'unknown' | 'no_scope' | 'no_recipient' | 'failed';
export type NotificationStatus = 'pending' | 'sent' | 'skipped' | 'failed';
export type NotificationSkipReason = 'no_deal' | 'expired_untouched';

export interface PaymentNotification {
  notificationId: string;
  erpOrderId: string;
  correlationRequestId: string | null;
  actorUserId: string | null;
  syncEventId: string | null;
  payload: PaymentNotificationPayload;
  readyAt: Date | null;
  syncIncomplete: boolean;
  bitrixDealId: string | null;
  bitrixUserId: string | null;
  commentState: NotificationCommentState;
  commentAttemptStartedAt: Date | null;
  commentAttempts: number;
  commentNextAt: Date | null;
  commentId: string | null;
  notifyState: NotificationNotifyState;
  notifyAttempts: number;
  notifyNextAt: Date | null;
  attempts: number;
  createdAt: Date;
  leaseToken: string;
}

/** Columns a step may set; every write is fenced by the lease token of the worker that claimed the row. */
export interface NotificationPatch {
  readyAt?: 'now';
  syncIncomplete?: boolean;
  bitrixDealId?: string | null;
  bitrixUserId?: string | null;
  commentState?: NotificationCommentState;
  commentAttemptStartedAt?: 'now';
  commentAttempts?: number;
  commentNextAt?: Date | null;
  commentId?: string | null;
  notifyState?: NotificationNotifyState;
  notifyAttemptStartedAt?: 'now';
  notifyAttempts?: number;
  notifyNextAt?: Date | null;
  notifiedAt?: 'now';
  attempts?: number;
  lastError?: string | null;
  nextAttemptAt?: Date;
}

export interface NotificationReadiness {
  /** The order's latest Bitrix24 sync event created since the notification was processed, and no paid operation is open. */
  synced: boolean;
  /** The sync can no longer be waited for: the latest event failed or a paid operation is stuck. */
  broken: boolean;
}

interface Row {
  notification_id: string;
  erp_order_id: string | number;
  correlation_request_id: string | null;
  actor_user_id: string | number | null;
  sync_event_id: string | null;
  payload: PaymentNotificationPayload;
  ready_at: Date | null;
  sync_incomplete: boolean;
  bitrix_deal_id: string | null;
  bitrix_user_id: string | null;
  comment_state: NotificationCommentState;
  comment_attempt_started_at: Date | null;
  comment_attempts: number;
  comment_next_at: Date | null;
  comment_id: string | null;
  notify_state: NotificationNotifyState;
  notify_attempts: number;
  notify_next_at: Date | null;
  attempts: number;
  created_at: Date;
  lease_token: string;
}

const COLUMNS = `notification_id, erp_order_id, correlation_request_id, actor_user_id, sync_event_id, payload, ready_at, sync_incomplete,
  bitrix_deal_id, bitrix_user_id, comment_state, comment_attempt_started_at, comment_attempts, comment_next_at, comment_id,
  notify_state, notify_attempts, notify_next_at, attempts, created_at, lease_token`;

const PATCH_COLUMNS: Record<keyof NotificationPatch, string> = {
  readyAt: 'ready_at',
  syncIncomplete: 'sync_incomplete',
  bitrixDealId: 'bitrix_deal_id',
  bitrixUserId: 'bitrix_user_id',
  commentState: 'comment_state',
  commentAttemptStartedAt: 'comment_attempt_started_at',
  commentAttempts: 'comment_attempts',
  commentNextAt: 'comment_next_at',
  commentId: 'comment_id',
  notifyState: 'notify_state',
  notifyAttemptStartedAt: 'notify_attempt_started_at',
  notifyAttempts: 'notify_attempts',
  notifyNextAt: 'notify_next_at',
  notifiedAt: 'notified_at',
  attempts: 'attempts',
  lastError: 'last_error',
  nextAttemptAt: 'next_attempt_at',
};

export const NOTIFICATION_EVENTS = {
  sent: 'crm_sync.payment_notification_sent',
  skipped: 'crm_sync.payment_notification_skipped',
  failed: 'crm_sync.payment_notification_failed',
} as const;

export class PgCrmSyncPaymentNotificationRepository {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Rows nobody ever tried to deliver and older than an hour are not sent late (e.g. after the flag was off).
   * A row with any started attempt is never expired.
   */
  async expireUntouched(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const expired = await tx.query<Row>(
        `UPDATE crm_sync_payment_notification
            SET status='skipped', skip_reason='expired_untouched', completed_at=now(), updated_at=now(),
                lease_token=NULL, lease_until=NULL
          WHERE notification_id IN (
                  SELECT notification_id FROM crm_sync_payment_notification
                   WHERE status='pending' AND comment_attempt_started_at IS NULL AND notify_attempt_started_at IS NULL
                     AND created_at < now() - interval '1 hour'
                     AND (lease_until IS NULL OR lease_until < now())
                   ORDER BY created_at LIMIT 200
                   FOR UPDATE SKIP LOCKED)
          RETURNING ${COLUMNS}`,
      );
      for (const row of expired.rows) {
        await this.audit.record(tx, this.auditEvent(toNotification(row), NOTIFICATION_EVENTS.skipped, { skipReason: 'expired_untouched' }));
      }
      return expired.rows.length;
    });
  }

  /** Claims due rows for one worker; `orderIds` empty = every order. */
  async claimDue(limit: number, leaseMs: number, orderIds: ReadonlySet<string>): Promise<PaymentNotification[]> {
    const result = await this.db.query<Row>(
      `UPDATE crm_sync_payment_notification n
          SET lease_token=gen_random_uuid(), lease_until=now() + ($2::int * interval '1 millisecond'), updated_at=now()
        WHERE n.notification_id IN (
                SELECT notification_id FROM crm_sync_payment_notification
                 WHERE status='pending' AND next_attempt_at <= now()
                   AND (lease_until IS NULL OR lease_until < now())
                   AND (cardinality($3::bigint[]) = 0 OR erp_order_id = ANY($3::bigint[]))
                 ORDER BY next_attempt_at, created_at LIMIT $1
                 FOR UPDATE SKIP LOCKED)
        RETURNING ${COLUMNS}`,
      [limit, leaseMs, [...orderIds]],
    );
    return result.rows.map(toNotification);
  }

  /** Writes a step result only while the row is still pending and leased to this worker. */
  async update(row: PaymentNotification, patch: NotificationPatch): Promise<boolean> {
    const { assignments, values } = toAssignments(patch, 3);
    const result = await this.db.query(
      `UPDATE crm_sync_payment_notification SET ${assignments}, updated_at=now()
        WHERE notification_id=$1 AND lease_token=$2 AND status='pending'`,
      [row.notificationId, row.leaseToken, ...values],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /** Terminal state and its audit row, in one transaction, fenced by the lease. */
  async finish(
    row: PaymentNotification,
    status: Exclude<NotificationStatus, 'pending'>,
    patch: NotificationPatch,
    details: { skipReason?: NotificationSkipReason; error?: string | null },
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const { assignments, values } = toAssignments(patch, 5);
      const result = await tx.query<Row>(
        `UPDATE crm_sync_payment_notification
            SET status=$3, skip_reason=$4, completed_at=now(), updated_at=now(), lease_token=NULL, lease_until=NULL
                ${assignments ? `, ${assignments}` : ''}
          WHERE notification_id=$1 AND lease_token=$2 AND status='pending'
          RETURNING ${COLUMNS}`,
        [row.notificationId, row.leaseToken, status, details.skipReason ?? null, ...values],
      );
      const done = result.rows[0];
      if (!done) return false;
      await this.audit.record(tx, this.auditEvent({ ...toNotification(done), leaseToken: row.leaseToken }, NOTIFICATION_EVENTS[status], details));
      return true;
    });
  }

  /** Releases the lease without a result (the row is retried at `nextAttemptAt`). */
  async release(row: PaymentNotification, nextAttemptAt: Date, patch: NotificationPatch = {}): Promise<boolean> {
    const { assignments, values } = toAssignments({ ...patch, nextAttemptAt }, 3);
    const result = await this.db.query(
      `UPDATE crm_sync_payment_notification SET ${assignments}, lease_token=NULL, lease_until=NULL, updated_at=now()
        WHERE notification_id=$1 AND lease_token=$2 AND status='pending'`,
      [row.notificationId, row.leaseToken, ...values],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async findDealId(erpOrderId: string): Promise<string | null> {
    const result = await this.db.query<{ bitrix_id: string }>(
      `SELECT bitrix_id FROM crm_sync_mapping
        WHERE entity_type='order' AND bitrix_object='deal' AND erp_id=$1 AND status='active'
        ORDER BY updated_at DESC LIMIT 1`,
      [erpOrderId],
    );
    const id = result.rows[0]?.bitrix_id ?? null;
    return id !== null && /^[1-9][0-9]*$/.test(id) ? id : null;
  }

  /**
   * Readiness follows the order's own sync event, written by the payment transaction (`sync_event_id`):
   * pending/processing → wait; failed → broken; processed → synced (unless a «paid» operation is still open).
   * Transaction-start timestamps are never used to order events. When that event is gone (a later transaction
   * replaced it while it was pending, or it was never captured), its replacement was enqueued after this
   * transaction committed: then any pending/processing event of the order → wait; any event that failed or was
   * processed after the notification was created decides (failure wins). A failed row's `next_attempt_at` is set
   * at the failure moment (plus the poll interval), so «failed since» errs towards the warning.
   */
  async readiness(row: PaymentNotification): Promise<NotificationReadiness> {
    const result = await this.db.query<{
      own_status: string | null; outstanding: number; processed: number; failed: number; open_ops: number; stuck_ops: number;
    }>(
      `SELECT (SELECT status FROM crm_sync_outbox WHERE outbox_event_id = $3::uuid) AS own_status,
              count(*) FILTER (WHERE status IN ('pending', 'processing'))::int AS outstanding,
              count(*) FILTER (WHERE status = 'processed' AND processed_at >= $2)::int AS processed,
              count(*) FILTER (WHERE status = 'failed' AND next_attempt_at >= $2)::int AS failed,
              (SELECT count(*)::int FROM crm_sync_paid_payment_operation
                WHERE erp_order_id = $1::bigint AND phase <> 'completed') AS open_ops,
              (SELECT count(*)::int FROM crm_sync_paid_payment_operation
                WHERE erp_order_id = $1::bigint AND phase <> 'completed' AND stuck_at IS NOT NULL) AS stuck_ops
         FROM crm_sync_outbox
        WHERE idempotency_key = 'order:' || $1::text`,
      [row.erpOrderId, row.createdAt, row.syncEventId],
    );
    const state = result.rows[0];
    const openOps = Number(state?.open_ops ?? 0) > 0;
    const stuck = Number(state?.stuck_ops ?? 0) > 0;
    const own = state?.own_status ?? null;
    if (own !== null) {
      return {
        synced: own === 'processed' && !openOps,
        broken: own === 'failed' || stuck,
      };
    }
    const outstanding = Number(state?.outstanding ?? 0) > 0;
    const failed = !outstanding && Number(state?.failed ?? 0) > 0;
    return {
      synced: !outstanding && !failed && Number(state?.processed ?? 0) > 0 && !openOps,
      broken: failed || stuck,
    };
  }

  /** Finished rows are kept 30 days. */
  async purgeFinished(): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM crm_sync_payment_notification
        WHERE notification_id IN (
                SELECT notification_id FROM crm_sync_payment_notification
                 WHERE status <> 'pending' AND completed_at < now() - interval '30 days'
                 LIMIT 500)`,
    );
    return result.rowCount ?? 0;
  }

  private auditEvent(
    row: PaymentNotification,
    event: string,
    details: { skipReason?: NotificationSkipReason; error?: string | null },
  ) {
    const relatedEntities: AuditRelatedEntity[] = (row.payload.paymentIds ?? [])
      .map((id) => ({ entityType: 'payment', entityId: id }));
    return {
      event,
      entityType: 'order',
      entityId: row.erpOrderId,
      requestId: row.correlationRequestId ?? `payment-notification:${row.notificationId}`,
      source: 'crm-sync',
      actorUserId: null,
      relatedOrderId: Number(row.erpOrderId),
      relatedEntities,
      before: null,
      after: { status: event.slice(event.lastIndexOf('_') + 1), commentState: row.commentState, notifyState: row.notifyState },
      metadata: {
        notificationId: row.notificationId,
        dealId: row.bitrixDealId,
        bitrixUserId: row.bitrixUserId,
        commentId: row.commentId,
        notifyOutcome: row.notifyState,
        syncIncomplete: row.syncIncomplete,
        ...(details.skipReason ? { skipReason: details.skipReason } : {}),
        ...(details.error ? { error: details.error.slice(0, 500) } : {}),
      },
    };
  }
}

function toAssignments(patch: NotificationPatch, firstParam: number): { assignments: string; values: unknown[] } {
  const parts: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch) as Array<[keyof NotificationPatch, unknown]>) {
    if (value === undefined) continue;
    const column = PATCH_COLUMNS[key];
    if (value === 'now') {
      parts.push(`${column}=now()`);
    } else if (key === 'commentAttempts' || key === 'notifyAttempts' || key === 'attempts') {
      values.push(value);
      parts.push(`${column}=$${firstParam + values.length - 1}::int`);
    } else {
      values.push(value);
      parts.push(`${column}=$${firstParam + values.length - 1}`);
    }
  }
  return { assignments: parts.join(', '), values };
}

function toNotification(row: Row): PaymentNotification {
  return {
    notificationId: row.notification_id,
    erpOrderId: String(row.erp_order_id),
    correlationRequestId: row.correlation_request_id,
    actorUserId: row.actor_user_id === null ? null : String(row.actor_user_id),
    syncEventId: row.sync_event_id,
    payload: row.payload,
    readyAt: row.ready_at,
    syncIncomplete: row.sync_incomplete,
    bitrixDealId: row.bitrix_deal_id,
    bitrixUserId: row.bitrix_user_id,
    commentState: row.comment_state,
    commentAttemptStartedAt: row.comment_attempt_started_at,
    commentAttempts: Number(row.comment_attempts),
    commentNextAt: row.comment_next_at,
    commentId: row.comment_id,
    notifyState: row.notify_state,
    notifyAttempts: Number(row.notify_attempts),
    notifyNextAt: row.notify_next_at,
    attempts: Number(row.attempts),
    createdAt: row.created_at,
    leaseToken: row.lease_token,
  };
}
