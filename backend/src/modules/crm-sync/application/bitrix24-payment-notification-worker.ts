import { Logger, type LoggerService } from '@nestjs/common';
import { redactLogFields } from '../../../common/logging/redaction';
import { safeBitrixError } from '../../audit/application/bitrix-audit-sanitization';
import { Bitrix24ApiError, type Bitrix24ApiPort } from '../adapters/bitrix24-api-client';
import type {
  NotificationPatch,
  PaymentNotification,
  PgCrmSyncPaymentNotificationRepository,
} from '../adapters/pg-crm-sync-payment-notification-repository';
import { notificationMarker, renderPaymentNotification } from './bitrix24-payment-notification-text';

const MINUTE = 60_000;
/** Backoff of a step after a proven refusal; the 8th refusal ends the step as failed. */
const BACKOFF_MINUTES = [1, 5, 15, 60];
export const STEP_MAX_ATTEMPTS = 8;
const WAIT_FOR_SYNC_MS = 15 * MINUTE;
const WAIT_FOR_DEAL_MS = 30 * MINUTE;
const RECONCILE_EVERY_MS = 10 * MINUTE;
const RECONCILE_FOR_MS = 24 * 60 * MINUTE;

/**
 * Bitrix24 error codes that prove the request was refused before it created anything. Everything else after the
 * request left (HTTP 5xx, network, timeout, an unrecognized answer) is an unknown outcome.
 */
const REFUSED_CODES = new Set([
  'QUERY_LIMIT_EXCEEDED',
  'INSUFFICIENT_SCOPE',
  'ACCESS_DENIED',
  'INVALID_CREDENTIALS',
  'WRONG_AUTH_TYPE',
  'EXPIRED_TOKEN',
  'ERROR_ARGUMENT',
  'INVALID_ARG_VALUE',
  'USER_ID_EMPTY',
  'NOT_FOUND',
]);
const NO_SCOPE_CODES = new Set(['INSUFFICIENT_SCOPE', 'ACCESS_DENIED']);

export type CreateOutcome = 'refused' | 'no_scope' | 'unknown';

export function classifyCreateError(error: unknown): CreateOutcome {
  // The relay's ownership guard runs right before the request leaves (Bitrix24ApiClient.callOnce): a proven
  // «not sent». Any other error that is not a recognized Bitrix24 refusal may have followed a sent request.
  if (error instanceof Error && error.name === 'OwnershipLost') return 'refused';
  if (!(error instanceof Bitrix24ApiError)) return 'unknown';
  const code = error.code.toUpperCase();
  if (NO_SCOPE_CODES.has(code)) return 'no_scope';
  return REFUSED_CODES.has(code) ? 'refused' : 'unknown';
}

const COMMENT_DONE = new Set(['created', 'resolved', 'unknown', 'failed']);
const NOTIFY_DONE = new Set(['sent', 'unknown', 'no_scope', 'no_recipient', 'failed']);

export interface PaymentNotificationWorkerDeps {
  bitrix: Bitrix24ApiPort;
  store: PgCrmSyncPaymentNotificationRepository;
  policy: () => { enabled: boolean; orderIds: ReadonlySet<string> };
  erpBaseUrl: string | null;
  portalHost: string | null;
  batchSize?: number;
  leaseMs?: number;
  now?: () => number;
  logger?: LoggerService;
}

/**
 * Delivers payment notifications (migration 260) inside the crm-sync relay tick, under its live writer lock:
 * a deal timeline comment and a system notification of the deal's responsible user. The start of each create
 * call is committed before the call; a lost answer is never repeated — the comment is then searched by its
 * marker for 24 hours, the notification is given up.
 */
export class Bitrix24PaymentNotificationWorker {
  private readonly now: () => number;
  private readonly logger: LoggerService;

  constructor(private readonly deps: PaymentNotificationWorkerDeps) {
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger ?? new Logger(Bitrix24PaymentNotificationWorker.name);
  }

  async runDue(requestGuard: () => Promise<void>): Promise<{ processed: number }> {
    const policy = this.deps.policy();
    const bitrix = this.deps.bitrix;
    // Housekeeping runs with the flag off too: rows are written regardless of it and must not pile up.
    await this.deps.store.expireUntouched();
    await this.deps.store.purgeFinished();
    if (!policy.enabled || !bitrix.addDealComment || !bitrix.notifyUser || !bitrix.listDealComments) {
      return { processed: 0 };
    }
    const rows = await this.deps.store.claimDue(this.deps.batchSize ?? 20, this.deps.leaseMs ?? 10 * MINUTE, policy.orderIds);
    let processed = 0;
    for (const row of rows) {
      try {
        await bitrix.withRequestGuard(requestGuard, () => this.process(row));
        processed += 1;
      } catch (error) {
        const message = errorText(error);
        this.logger.error(redactLogFields({ event: 'crm_sync_payment_notification_error', notificationId: row.notificationId, errorMessage: message }));
        // Ownership or database failure: give the row back; started attempts are recovered on the next claim.
        await this.deps.store.release(row, new Date(this.now() + MINUTE), { lastError: message }).catch(() => undefined);
        if (error instanceof Error && error.name === 'OwnershipLost') break;
      }
    }
    return { processed };
  }

  private async process(claimed: PaymentNotification): Promise<void> {
    let row = claimed;
    const apply = async (patch: NotificationPatch) => {
      if (!await this.deps.store.update(row, patch)) throw leaseLost();
      row = merge(row, patch, this.now());
    };

    // A previous worker started a call and never recorded its outcome (crash, lost lease, database error).
    if (row.commentState === 'attempting') await apply({ commentState: 'unresolved', commentNextAt: new Date(this.now()) });
    if (row.notifyState === 'attempting') await apply({ notifyState: 'unknown' });

    if (!row.readyAt) {
      const prepared = await this.prepare(row);
      if (!prepared) return;
      await apply(prepared);
    }

    const text = renderPaymentNotification(row.payload, {
      notificationId: row.notificationId,
      orderId: row.erpOrderId,
      dealId: row.bitrixDealId!,
      erpBaseUrl: this.deps.erpBaseUrl,
      portalHost: this.deps.portalHost,
      syncIncomplete: row.syncIncomplete,
    });

    if (row.commentState === 'none' && this.due(row.commentNextAt)) {
      await apply({ commentState: 'attempting', commentAttemptStartedAt: 'now', commentAttempts: row.commentAttempts + 1 });
      // Only the external call is inside try: a failure to save its result leaves the step `attempting`, and the
      // next owner treats it as unresolved (never as a refusal that would allow a second comment).
      const call = await settled(() => this.deps.bitrix.addDealComment!(row.bitrixDealId!, text.comment));
      if (call.ok) {
        await apply({ commentState: 'created', commentId: call.value, lastError: null });
      } else {
        const outcome = classifyCreateError(call.error);
        const message = errorText(call.error);
        if (outcome === 'unknown') {
          await apply({ commentState: 'unresolved', commentNextAt: new Date(this.now() + RECONCILE_EVERY_MS), lastError: message });
        } else {
          await apply({
            commentState: row.commentAttempts >= STEP_MAX_ATTEMPTS ? 'failed' : 'none',
            commentNextAt: this.backoff(row.commentAttempts),
            lastError: message,
          });
        }
        // The relay lost its writer lock before the request left: the refusal is recorded, the batch stops.
        if (isLeaseLost(call.error)) throw call.error;
      }
    } else if (row.commentState === 'unresolved' && this.due(row.commentNextAt)) {
      await this.reconcileComment(row, apply);
    }

    if (row.notifyState === 'none' && this.due(row.notifyNextAt)) {
      await apply({ notifyState: 'attempting', notifyAttemptStartedAt: 'now', notifyAttempts: row.notifyAttempts + 1 });
      const call = await settled(() => this.deps.bitrix.notifyUser!(row.bitrixUserId!, text.notify));
      if (call.ok) {
        await apply({ notifyState: 'sent', notifiedAt: 'now', lastError: null });
      } else {
        const outcome = classifyCreateError(call.error);
        const message = errorText(call.error);
        if (outcome === 'unknown') await apply({ notifyState: 'unknown', lastError: message });
        else if (outcome === 'no_scope') await apply({ notifyState: 'no_scope', lastError: message });
        else {
          await apply({
            notifyState: row.notifyAttempts >= STEP_MAX_ATTEMPTS ? 'failed' : 'none',
            notifyNextAt: this.backoff(row.notifyAttempts),
            lastError: message,
          });
        }
        if (isLeaseLost(call.error)) throw call.error;
      }
    }

    await this.settle(row);
  }

  /** Deal, its responsible user and the sync readiness; null = not yet (the row is released or finished). */
  private async prepare(row: PaymentNotification): Promise<NotificationPatch | null> {
    const age = this.now() - row.createdAt.getTime();
    const dealId = await this.deps.store.findDealId(row.erpOrderId);
    if (!dealId) {
      if (age < WAIT_FOR_DEAL_MS) await this.deps.store.release(row, new Date(this.now() + MINUTE));
      else await this.deps.store.finish(row, 'skipped', {}, { skipReason: 'no_deal' });
      return null;
    }
    const readiness = await this.deps.store.readiness(row);
    if (!readiness.synced && !readiness.broken && age < WAIT_FOR_SYNC_MS) {
      await this.deps.store.release(row, new Date(this.now() + MINUTE));
      return null;
    }
    let deal: Record<string, unknown>;
    try {
      deal = await this.deps.bitrix.getCrmItem(2, dealId);
    } catch (error) {
      if (isLeaseLost(error)) throw error;
      if (error instanceof Bitrix24ApiError && error.isNotFound) {
        await this.deps.store.finish(row, 'skipped', { bitrixDealId: dealId }, { skipReason: 'no_deal' });
      } else {
        await this.deps.store.release(row, this.backoff(row.attempts + 1), { attempts: row.attempts + 1, lastError: errorText(error) });
      }
      return null;
    }
    const userId = String(deal.assignedById ?? '');
    const bitrixUserId = /^[1-9][0-9]*$/.test(userId) ? userId : null;
    return {
      readyAt: 'now',
      syncIncomplete: !readiness.synced,
      bitrixDealId: dealId,
      bitrixUserId,
      ...(bitrixUserId === null ? { notifyState: 'no_recipient' as const } : {}),
    };
  }

  private async reconcileComment(row: PaymentNotification, apply: (patch: NotificationPatch) => Promise<void>): Promise<void> {
    const startedAt = row.commentAttemptStartedAt ?? row.createdAt;
    // A missing marker never allows a new comment: after 24 hours the outcome stays unknown.
    const expired = this.now() - startedAt.getTime() >= RECONCILE_FOR_MS;
    const later: NotificationPatch = expired ? { commentState: 'unknown' } : { commentNextAt: new Date(this.now() + RECONCILE_EVERY_MS) };
    let found: string | null = null;
    try {
      const page = await this.deps.bitrix.listDealComments!(row.bitrixDealId!, new Date(startedAt.getTime() - MINUTE));
      const marker = notificationMarker(row.notificationId);
      // The marker ends with the full UUID; a match on a longer id is impossible, so `includes` is exact enough.
      found = page.comments.find((comment) => comment.comment.includes(marker))?.id ?? null;
    } catch (error) {
      if (isLeaseLost(error)) throw error;
      await apply({ ...later, lastError: errorText(error) });
      return;
    }
    // An incomplete listing that did not show the marker proves nothing: try again later (or give up at 24 h).
    await apply(found ? { commentState: 'resolved', commentId: found, lastError: null } : later);
  }

  /** Finishes the row when both steps are final; otherwise schedules the earliest pending step. */
  private async settle(row: PaymentNotification): Promise<void> {
    const commentDone = COMMENT_DONE.has(row.commentState);
    const notifyDone = NOTIFY_DONE.has(row.notifyState);
    if (commentDone && notifyDone) {
      const delivered = row.commentState === 'created' || row.commentState === 'resolved' || row.notifyState === 'sent';
      if (!await this.deps.store.finish(row, delivered ? 'sent' : 'failed', {}, {})) throw leaseLost();
      return;
    }
    const times: number[] = [];
    if (!commentDone) times.push(row.commentNextAt?.getTime() ?? this.now());
    if (!notifyDone) times.push(row.notifyNextAt?.getTime() ?? this.now());
    const next = Math.max(Math.min(...times), this.now() + 1000);
    if (!await this.deps.store.release(row, new Date(next))) throw leaseLost();
  }

  private due(at: Date | null): boolean {
    return at === null || at.getTime() <= this.now();
  }

  private backoff(attempts: number): Date {
    const minutes = BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1];
    return new Date(this.now() + minutes * MINUTE);
  }
}

function merge(row: PaymentNotification, patch: NotificationPatch, now: number): PaymentNotification {
  const at = (value: 'now' | undefined, current: Date | null) => (value === 'now' ? new Date(now) : current);
  return {
    ...row,
    readyAt: at(patch.readyAt, row.readyAt),
    syncIncomplete: patch.syncIncomplete ?? row.syncIncomplete,
    bitrixDealId: patch.bitrixDealId !== undefined ? patch.bitrixDealId : row.bitrixDealId,
    bitrixUserId: patch.bitrixUserId !== undefined ? patch.bitrixUserId : row.bitrixUserId,
    commentState: patch.commentState ?? row.commentState,
    commentAttemptStartedAt: at(patch.commentAttemptStartedAt, row.commentAttemptStartedAt),
    commentAttempts: patch.commentAttempts ?? row.commentAttempts,
    commentNextAt: patch.commentNextAt !== undefined ? patch.commentNextAt : row.commentNextAt,
    commentId: patch.commentId !== undefined ? patch.commentId : row.commentId,
    notifyState: patch.notifyState ?? row.notifyState,
    notifyAttempts: patch.notifyAttempts ?? row.notifyAttempts,
    notifyNextAt: patch.notifyNextAt !== undefined ? patch.notifyNextAt : row.notifyNextAt,
    attempts: patch.attempts ?? row.attempts,
  };
}

class NotificationLeaseLost extends Error {
  constructor() {
    super('crm-sync: payment notification lease lost');
    this.name = 'NotificationLeaseLost';
  }
}

function leaseLost(): NotificationLeaseLost {
  return new NotificationLeaseLost();
}

function isLeaseLost(error: unknown): boolean {
  return error instanceof NotificationLeaseLost || (error instanceof Error && error.name === 'OwnershipLost');
}

/** Error text for `last_error` and logs: webhook paths and tokens are masked before truncation. */
function errorText(error: unknown): string {
  return safeBitrixError(error instanceof Error ? error.message : String(error));
}

async function settled<T>(call: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    return { ok: false, error };
  }
}
