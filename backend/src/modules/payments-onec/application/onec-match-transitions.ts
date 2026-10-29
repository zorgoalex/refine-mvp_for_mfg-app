import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient } from '../../../database/database.types';
import { matchDriftReasonsSql } from '../domain/onec-match-drift-sql';
import { erpOrderOfOnecOrderSql } from '../domain/onec-order-link-sql';

/**
 * Hooks of every writer that can change the state of an active 1C receipt match (plan 2026-10-04-onec-incoming-payments
 * §6–7, slice B): the transition detector and the guard of a physical payment delete. Plain functions, as
 * `evaluateStatusAutomation`: payments, the order form, Bitrix24 and the 1C loader call them inside their own
 * transaction, after their own locks. They lock only `payment_onec_matches` rows, always last (lock order:
 * orders → payments → 1C documents → 1C lines → match records), and never orders, payments or 1C documents.
 */

export const SOURCE = 'backend-payments-onec';

export interface OnecMatchingRuntime {
  /** Series of the 1C order numbers that are ERP orders (`BACKEND_ONEC_ORDER_NUMBER_SERIES`); null — rule off. */
  series: string | null;
  /** `BACKEND_ONEC_PAYMENT_MATCHING_COMMANDS`: the operator manages matches on the tab. */
  commandsEnabled: boolean;
}

let runtime: OnecMatchingRuntime | null = null;

/** Set by `PaymentsOnecModule` at start-up. Until then the detector is a no-op (the read model still shows `changed`). */
export function configureOnecMatching(next: OnecMatchingRuntime | null): void {
  runtime = next;
}

export function onecMatchingRuntime(): OnecMatchingRuntime | null {
  return runtime;
}

export interface OnecMatchTransitionScope {
  orderIds?: readonly number[];
  paymentIds?: readonly number[];
  onecDocumentIds?: readonly number[];
  onecOrderRefKeys?: readonly string[];
}

export interface OnecMatchWriterContext {
  requestId: string;
  correlationId?: string | null;
  /** Who made the change; null — a system writer (1C loader, Bitrix24). */
  actorUserId: string | number | null;
  /** The writer, for the event (e.g. `payment_command`, `order_form`, `onec_loader`). */
  writer: string;
}

const ids = (values: readonly number[] | undefined): number[] =>
  [...new Set((values ?? []).filter((value) => Number.isSafeInteger(value) && value > 0))];

const LIVE_SQL = `(d.posted AND NOT d.deleted_in_onec AND d.missing_in_source_at IS NULL AND l.removed_in_onec_at IS NULL AND l.amount > 0)`;

/**
 * Locks (FOR UPDATE, ascending) the active `matched` records a writer's scope touches — the rows the detector
 * re-checks. A writer that takes the candidate advisory locks before its detection runs this first, so match rows are
 * always locked before the advisory locks, as in the loader (code review R3-2).
 */
export async function lockActiveMatches(tx: DatabaseClient, scope: OnecMatchTransitionScope): Promise<string[]> {
  const orderIds = ids(scope.orderIds);
  const paymentIds = ids(scope.paymentIds);
  const documentIds = ids(scope.onecDocumentIds);
  const refs = [...new Set(scope.onecOrderRefKeys ?? [])].filter((ref) => typeof ref === 'string' && ref.length > 0);
  if (orderIds.length + paymentIds.length + documentIds.length + refs.length === 0) return [];
  const { rows } = await tx.query<{ match_id: string }>(
    `SELECT m.match_id FROM payment_onec_matches m
      WHERE m.removed_at IS NULL AND m.kind = 'matched'
        AND (m.order_id_at_match = ANY($1::bigint[]) OR m.payment_id = ANY($2::bigint[])
             OR m.payment_id IN (SELECT p.payment_id FROM payments p WHERE p.order_id = ANY($1::bigint[]))
             OR m.onec_document_line_id IN (SELECT l.onec_document_line_id FROM onec_document_lines l WHERE l.onec_document_id = ANY($3::bigint[]))
             OR m.onec_order_ref_key = ANY($4::uuid[]))
      ORDER BY m.match_id
      FOR UPDATE OF m`,
    [orderIds, paymentIds, documentIds, refs],
  );
  return rows.map((row) => row.match_id);
}

/**
 * Re-checks the active `matched` records touched by a writer (plan §7): a new drift (reasons + current values)
 * becomes `changed_fingerprint`, bumps `review_seq` and writes `payment.onec_review_required` to the outbox; the
 * same drift again writes nothing; a drift that disappeared clears the fingerprint (the next one is a new event).
 * Without active matches in scope — one index query, no writes.
 */
export async function detectOnecMatchTransitions(
  tx: DatabaseClient,
  scope: OnecMatchTransitionScope,
  context: OnecMatchWriterContext,
): Promise<number> {
  const settings = runtime;
  if (settings === null) return 0;
  const touched = await lockActiveMatches(tx, scope);
  if (touched.length === 0) return 0;

  const { rows } = await tx.query<{
    match_id: string; line_id: string; document_id: string; order_id_at_match: string | null; payment_id_at_match: string | null;
    changed_fingerprint: string | null; review_seq: number; reasons: string[]; current: unknown;
  }>(
    `SELECT m.match_id, m.onec_document_line_id AS line_id, d.onec_document_id AS document_id, m.order_id_at_match,
            m.payment_id_at_match, m.changed_fingerprint, m.review_seq,
            ${matchDriftReasonsSql({
              live: LIVE_SQL, currency: 'd.currency', lineAmount: 'l.amount', docDate: 'd.doc_date', orderRef: 'l.onec_order_ref_key',
              erpOrderId: 'cur.erp_order_id', orderOk: 'cur.order_ok', match: 'm', payment: 'p',
            })} AS reasons,
            json_build_array(${LIVE_SQL}, l.amount, d.currency, d.doc_date, l.onec_order_ref_key, cur.erp_order_id, cur.order_ok,
                             p.payment_id, p.delete_flag, p.order_id, p.amount, p.payment_date) AS current
       FROM payment_onec_matches m
       JOIN onec_document_lines l ON l.onec_document_line_id = m.onec_document_line_id
       JOIN onec_documents d ON d.onec_document_id = l.onec_document_id
       LEFT JOIN payments p ON p.payment_id = m.payment_id
       LEFT JOIN LATERAL (
         SELECT e.erp_order_id,
                (o.order_id IS NOT NULL AND o.delete_flag = false AND o.order_kind = 'production_order'
                 AND (EXISTS (SELECT 1 FROM order_details od WHERE od.order_id = o.order_id AND od.delete_flag = false)
                      OR EXISTS (SELECT 1 FROM order_catalog_lines cl WHERE cl.order_id = o.order_id AND cl.delete_flag = false))) AS order_ok
           FROM (SELECT ${erpOrderOfOnecOrderSql('d.source_id', 'l.onec_order_ref_key', '$2')} AS erp_order_id) e
           LEFT JOIN orders o ON o.order_id = e.erp_order_id
       ) cur ON true
      WHERE m.match_id = ANY($1::bigint[])
      ORDER BY m.match_id`,
    [touched, settings.series],
  );

  let events = 0;
  for (const row of rows) {
    const fingerprint = row.reasons.length === 0
      ? null
      : createHash('sha256').update(JSON.stringify([row.reasons, row.current])).digest('base64url');
    if (fingerprint === row.changed_fingerprint) continue;
    if (fingerprint === null) {
      await tx.query('UPDATE payment_onec_matches SET changed_fingerprint = NULL WHERE match_id = $1', [row.match_id]);
      continue;
    }
    const reviewSeq = row.review_seq + 1;
    await tx.query('UPDATE payment_onec_matches SET changed_fingerprint = $2, review_seq = $3 WHERE match_id = $1',
      [row.match_id, fingerprint, reviewSeq]);
    await writeMatchEvent(tx, 'payment.onec_review_required', `payment_onec_review:${row.match_id}:${reviewSeq}`, {
      matchId: Number(row.match_id), lineId: Number(row.line_id), onecDocumentId: Number(row.document_id),
      orderId: row.order_id_at_match === null ? null : Number(row.order_id_at_match),
      paymentId: row.payment_id_at_match === null ? null : Number(row.payment_id_at_match),
      reasons: row.reasons, reviewSeq, writer: context.writer,
    }, context);
    events += 1;
  }
  return events;
}

export async function writeMatchEvent(
  tx: DatabaseClient,
  eventType: string,
  idempotencyKey: string,
  data: Record<string, unknown> & { matchId: number },
  context: { requestId: string; correlationId?: string | null; actorUserId: string | number | null },
): Promise<void> {
  await tx.query(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
     VALUES ($1, 'payment_onec_match', $2, $3::jsonb, $4) ON CONFLICT DO NOTHING`,
    [eventType, String(data.matchId), JSON.stringify({
      eventId: randomUUID(), eventType, ...data,
      actorUserId: context.actorUserId === null ? null : Number(context.actorUserId),
      actor: context.actorUserId === null ? 'system' : 'user',
      requestId: context.requestId, correlationId: context.correlationId ?? null, source: SOURCE,
    }), idempotencyKey],
  );
}

/**
 * Before a PHYSICAL payment delete (payment API, order form, snapshot import). An active match holds its payment
 * (FK SET NULL + CHECK, migration 240), so the database would refuse the delete with a check violation.
 * Commands on — 409 `PAYMENT_HAS_ONEC_MATCH`: the operator unmatches on the tab first. Commands off — the tab cannot
 * manage matches, so the match is removed here, atomically with the delete (audit + outbox), and the payment is not
 * stuck (plan §6, R1-8). `actorUserId` is the user of the delete (removed_by is required).
 */
export async function releaseOnecMatchesBeforePaymentDelete(
  tx: DatabaseClient,
  paymentIds: readonly number[],
  context: OnecMatchWriterContext & { actorUserId: string | number },
): Promise<void> {
  const payments = ids(paymentIds);
  if (payments.length === 0) return;
  const { rows } = await tx.query<{
    match_id: string; payment_id: string; line_id: string; document_id: string; number: string; order_id_at_match: string;
    client_id: string | null;
  }>(
    `SELECT m.match_id, m.payment_id, m.onec_document_line_id AS line_id, d.onec_document_id AS document_id, d.number,
            m.order_id_at_match, o.client_id
       FROM payment_onec_matches m
       JOIN onec_document_lines l ON l.onec_document_line_id = m.onec_document_line_id
       JOIN onec_documents d ON d.onec_document_id = l.onec_document_id
       LEFT JOIN orders o ON o.order_id = m.order_id_at_match
      WHERE m.payment_id = ANY($1::bigint[]) AND m.removed_at IS NULL
      ORDER BY m.match_id
      FOR UPDATE OF m`,
    [payments],
  );
  if (rows.length === 0) return;
  if (runtime?.commandsEnabled === true) {
    throw new ApiError(409, 'PAYMENT_HAS_ONEC_MATCH', 'Платёж сверен с поступлением 1С: сначала снимите сверку на вкладке «Поступления 1С»', {
      matches: rows.map((row) => ({ paymentId: Number(row.payment_id), lineId: Number(row.line_id), onecDocumentNumber: row.number })),
    });
  }
  for (const row of rows) {
    await tx.query(
      `UPDATE payment_onec_matches SET removed_at = now(), removed_by = $2, removed_reason = 'payment_deleted_feature_off'
        WHERE match_id = $1`,
      [row.match_id, context.actorUserId],
    );
    await auditService.record(tx, {
      event: 'payment.onec_unmatched',
      entityType: 'payment_onec_match',
      entityId: row.match_id,
      actorUserId: context.actorUserId,
      requestId: context.requestId,
      source: SOURCE,
      relatedOrderId: Number(row.order_id_at_match),
      relatedClientId: row.client_id === null ? null : Number(row.client_id),
      relatedPaymentId: Number(row.payment_id),
      before: { kind: 'matched', paymentId: Number(row.payment_id), lineId: Number(row.line_id) },
      after: { removedReason: 'payment_deleted_feature_off' },
      metadata: { writer: context.writer, onecDocumentNumber: row.number, correlationId: context.correlationId ?? null },
      relatedEntities: [
        { entityType: 'onec_document', entityId: Number(row.document_id) },
        { entityType: 'onec_document_line', entityId: Number(row.line_id) },
      ],
    });
    await writeMatchEvent(tx, 'payment.onec_unmatched', `payment.onec_unmatched:${row.match_id}:removed`, {
      matchId: Number(row.match_id), lineId: Number(row.line_id), onecDocumentId: Number(row.document_id),
      orderId: Number(row.order_id_at_match), paymentId: Number(row.payment_id), reason: 'payment_deleted_feature_off',
      writer: context.writer,
    }, context);
  }
}

/**
 * Serialises the auto-match decision «this pair is mutually unique» with the 1C loader (code review R1-4). The loader
 * cannot lock ERP orders (its documents are locked first), so both sides take an advisory lock per ERP order as their
 * LAST lock: the auto-match exclusively before it counts competing lines, the loader shared at the end of its document
 * transaction for every ERP order its receipt lines (or its 1C customer order) resolve to. Whoever comes second sees
 * the other's committed result: a line committed first is counted; a line arriving after a committed match finds
 * the payment taken (state `review`). Lock order of every writer: its row locks (incl. the match rows it re-checks),
 * then `lockOnecOrderRefs`, then this — so no two writers wait on each other's advisory and row locks crosswise.
 */
export async function lockOrderCandidates(tx: DatabaseClient, orderIds: readonly number[], mode: 'exclusive' | 'shared'): Promise<void> {
  const fn = mode === 'exclusive' ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared';
  for (const orderId of ids(orderIds).sort((a, b) => a - b)) {
    await tx.query(`SELECT ${fn}(hashtext('payments-onec:order-candidates:' || $1::text))`, [orderId]);
  }
}

/**
 * Serialises a change of which ERP order a 1C customer order resolves to (manual link / unlink — exclusive) with the
 * loader adding or changing receipt lines of that 1C order (shared), whatever it resolves to now — also «not an ERP
 * order», when no ERP order lock covers it (code review R3-1). Taken before `lockOrderCandidates` on both sides.
 */
export async function lockOnecOrderRefs(tx: DatabaseClient, sourceId: number, refs: readonly string[], mode: 'exclusive' | 'shared'): Promise<void> {
  const fn = mode === 'exclusive' ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared';
  const wanted = [...new Set(refs.filter((ref) => typeof ref === 'string' && ref.length > 0).map((ref) => ref.toLowerCase()))].sort();
  for (const ref of wanted) {
    await tx.query(`SELECT ${fn}(hashtext('payments-onec:onec-order:' || $1::text || ':' || $2::text))`, [sourceId, ref]);
  }
}

/** ERP orders the given 1C customer order refs of one source resolve to now (manual link, otherwise the series rule). */
export async function erpOrdersOfOnecOrders(tx: DatabaseClient, sourceId: number, refs: readonly string[]): Promise<number[]> {
  const settings = runtime;
  const wanted = [...new Set(refs.filter((ref) => typeof ref === 'string' && ref.length > 0))];
  if (settings === null || wanted.length === 0) return [];
  const { rows } = await tx.query<{ order_id: string | null }>(
    `SELECT ${erpOrderOfOnecOrderSql('$1::bigint', 'r.ref', '$3')} AS order_id FROM unnest($2::uuid[]) AS r(ref)`,
    [sourceId, wanted, settings.series],
  );
  return rows.map((row) => (row.order_id === null ? null : Number(row.order_id))).filter((id): id is number => id !== null);
}
