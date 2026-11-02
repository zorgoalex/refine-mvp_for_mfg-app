import { randomUUID } from 'node:crypto';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import { INCOMING_KINDS, paymentToken, REFUND_KINDS } from '../domain/onec-receipts';
import { detectOnecMatchTransitions, lockActiveMatches, lockOnecOrderRefs, lockOrderCandidates, SOURCE, writeMatchEvent } from '../application/onec-match-transitions';
import { seriesRuleOrderSql } from '../domain/onec-order-link-sql';
import { BASE_SQL, item, type BaseRow } from './pg-onec-receipts-read-repository';

/** An ERP order locked by a command, with the fields the payments scope policy needs. */
export interface LockedOrderRow {
  orderId: number;
  createdBy: string | null;
  managerId: string | null;
  clientId: number | null;
  deleted: boolean;
}

export interface CommandActor {
  userId: string;
  username: string | null;
  role: string | null;
  requestId: string;
  correlationId: string | null;
}

/** Scope check of the service, run under the command's locks (the orders are locked, their owners are stable). */
export type ScopeCheck = (orders: readonly (LockedOrderRow | null)[]) => Promise<void>;

export interface MatchCommandResult {
  changed: boolean;
  matchId: number | null;
}

const stateChanged = (details?: Record<string, unknown>) =>
  new ApiError(409, 'ONEC_RECEIPT_STATE_CHANGED', 'Данные поступления изменились; обновите строку', details);
const notFound = () => new ApiError(404, 'ONEC_RECEIPT_NOT_FOUND', 'Поступление 1С не найдено');
const NOTE_MAX = 500;
/** Окно дат автосверки (план §1, решение пользователя п. 3). */
export const AUTO_MATCH_DAYS = 3;
/** Limit of the auto-match candidates query (whole read model), transaction-local. */
export const AUTO_MATCH_CANDIDATES_TIMEOUT_MS = 60_000;

function requireNote(note: string | null | undefined, code: string, message: string): string {
  const value = (note ?? '').trim();
  if (value.length === 0) throw new ApiError(422, code, message);
  if (value.length > NOTE_MAX) throw new ApiError(422, 'ONEC_NOTE_TOO_LONG', `Комментарий длиннее ${NOTE_MAX} символов`);
  return value;
}

function optionalNote(note: string | null | undefined): string | null {
  const value = (note ?? '').trim();
  if (value.length > NOTE_MAX) throw new ApiError(422, 'ONEC_NOTE_TOO_LONG', `Комментарий длиннее ${NOTE_MAX} символов`);
  return value.length === 0 ? null : value;
}

const num = (value: string | number | null | undefined): number | null => (value === null || value === undefined ? null : Number(value));
const dateOnly = (value: unknown): string => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));

/**
 * Manual commands of the «Поступления 1С» tab (plan 2026-10-04-onec-incoming-payments §6, slice B).
 * Lock order of every command (R1-1, R3-1): user `FOR SHARE` → ERP orders `FOR UPDATE` by ascending id → payment
 * `FOR UPDATE` → 1C document headers `FOR SHARE` by ascending id (the receipt, the 1C customer order the ERP order is
 * resolved by, the refunds of the receipt) → the 1C line `FOR SHARE` → match records `FOR UPDATE`. The state token is
 * recomputed after all locks; a mismatch → 409 `ONEC_RECEIPT_STATE_CHANGED`, nothing written.
 */
export class PgOnecReceiptsCommandRepository {
  constructor(private readonly database: DatabaseService, private readonly series: () => string | null) {}

  match(
    lineId: number,
    input: { paymentId: number; expectedStateToken: string; expectedPaymentToken: string; note?: string | null },
    actor: CommandActor,
    checkScope: ScopeCheck,
  ): Promise<MatchCommandResult> {
    return this.database.transaction(async (tx) => {
      await this.lockUser(tx, actor.userId);
      const before = await this.loadLine(tx, lineId);
      const paymentOrder = await this.paymentOrderId(tx, input.paymentId);
      const orders = await this.lockOrders(tx, [num(before.erp_order_id), paymentOrder]);
      const payment = await this.lockPayment(tx, input.paymentId);
      await this.lockLineDocuments(tx, before);
      const active = await this.lockMatches(tx, lineId, input.paymentId);
      const row = await this.loadLine(tx, lineId);
      // Scope FIRST, before any answer that tells the state of the line or the payment (code review B-main R1-2):
      // the line's ERP order («no order» — only scope «all») and the order of the payment AS LOCKED (R2-3: a payment
      // moved meanwhile to an order not locked here, or a payment that does not exist, needs scope «all»).
      await checkScope([
        row.erp_order_id === null ? null : orders.get(Number(row.erp_order_id)) ?? null,
        payment === null ? null : orders.get(Number(payment.order_id)) ?? null,
      ]);

      // Repeat of the same match: the record already exists → no change (plan §6 «Идемпотентность»).
      const own = active.find((m) => Number(m.onec_document_line_id) === lineId);
      if (own && own.kind === 'matched' && Number(own.payment_id) === input.paymentId) {
        return { changed: false, matchId: Number(own.match_id) };
      }
      if (own) throw new ApiError(409, 'ONEC_RECEIPT_ALREADY_MATCHED', 'У поступления уже есть сверка или отметка «разобрано»', { matchId: Number(own.match_id) });
      if (active.some((m) => Number(m.payment_id) === input.paymentId)) {
        throw new ApiError(409, 'PAYMENT_ALREADY_MATCHED', 'Платёж уже сверен с другим поступлением 1С');
      }
      this.assertToken(row, before, orders, input.expectedStateToken);
      if (payment === null || payment.delete_flag || num(payment.order_id) !== num(row.erp_order_id)) {
        throw new ApiError(409, 'ONEC_PAYMENT_NOT_OF_ORDER', 'Платёж не относится к заказу ERP этого поступления');
      }
      const token = paymentToken({
        paymentId: String(payment.payment_id), orderId: String(payment.order_id), version: String(payment.version),
        amount: String(payment.amount), paymentDate: dateOnly(payment.payment_date),
      });
      if (token !== input.expectedPaymentToken) throw stateChanged({ paymentId: input.paymentId });
      // Only an eligible receipt line with payments of its order and no record is matched by hand (states §5).
      if (row.state !== 'review') throw new ApiError(409, 'ONEC_RECEIPT_NOT_ELIGIBLE', 'Поступление сейчас нельзя сверить', { state: row.state, reason: row.reason });
      const amountDiffers = Number(payment.amount) !== Number(row.line_amount);
      const note = amountDiffers
        ? requireNote(input.note, 'ONEC_MATCH_NOTE_REQUIRED', 'Суммы различаются: укажите комментарий')
        : optionalNote(input.note);

      const { rows: [inserted] } = await tx.query<{ match_id: string }>(
        `INSERT INTO payment_onec_matches (onec_document_line_id, kind, origin, payment_id, payment_id_at_match, order_id_at_match,
                                           source_id, onec_order_ref_key, onec_amount, onec_currency, onec_doc_date,
                                           payment_amount, payment_date, note, created_by)
         VALUES ($1, 'matched', 'manual', $2, $2, $3, $4, $5::uuid, $6, $7, $8::date, $9, $10::date, $11, $12)
         RETURNING match_id`,
        [lineId, input.paymentId, row.erp_order_id, row.source_id, row.order_ref, row.line_amount, row.currency, dateOnly(row.doc_date),
          payment.amount, dateOnly(payment.payment_date), note, actor.userId],
      );
      const matchId = Number(inserted.match_id);
      const facts = {
        origin: 'manual', onecAmount: String(row.line_amount), onecDocDate: dateOnly(row.doc_date), onecCurrency: row.currency,
        paymentAmount: String(payment.amount), paymentDate: dateOnly(payment.payment_date), amountDiffers,
      };
      await this.audit(tx, actor, 'payment.onec_matched', matchId, row, {
        orderId: Number(row.erp_order_id), clientId: orders.get(Number(row.erp_order_id))?.clientId ?? null, paymentId: input.paymentId, before: null,
        after: { kind: 'matched', ...facts, note }, metadata: { lineId, documentNumber: row.number },
      });
      await writeMatchEvent(tx, 'payment.onec_matched', `payment.onec_matched:${matchId}`, {
        matchId, lineId, onecDocumentId: Number(row.doc_id), orderId: Number(row.erp_order_id), paymentId: input.paymentId, ...facts,
      }, { requestId: actor.requestId, correlationId: actor.correlationId, actorUserId: actor.userId });
      return { changed: true, matchId };
    });
  }

  dismiss(
    lineId: number,
    input: { expectedStateToken: string; note: string },
    actor: CommandActor,
    checkScope: ScopeCheck,
  ): Promise<MatchCommandResult> {
    return this.database.transaction(async (tx) => {
      await this.lockUser(tx, actor.userId);
      const before = await this.loadLine(tx, lineId);
      const orders = await this.lockOrders(tx, [num(before.erp_order_id)]);
      await this.lockLineDocuments(tx, before);
      const active = await this.lockMatches(tx, lineId, null);
      const row = await this.loadLine(tx, lineId);
      // Scope first (B-main R1-2). Without an ERP order the line is visible only with the scope «all» — the same for
      // the decision on it.
      await checkScope([row.erp_order_id === null ? null : orders.get(Number(row.erp_order_id)) ?? null]);
      const own = active.find((m) => Number(m.onec_document_line_id) === lineId);
      if (own && own.kind === 'dismissed') return { changed: false, matchId: Number(own.match_id) };
      if (own) throw new ApiError(409, 'ONEC_RECEIPT_ALREADY_MATCHED', 'У поступления уже есть сверка', { matchId: Number(own.match_id) });
      this.assertToken(row, before, orders, input.expectedStateToken);
      const note = requireNote(input.note, 'ONEC_DISMISS_NOTE_REQUIRED', 'Укажите, почему поступление разобрано без сверки');
      const { rows: [inserted] } = await tx.query<{ match_id: string }>(
        `INSERT INTO payment_onec_matches (onec_document_line_id, kind, origin, order_id_at_match, source_id, onec_order_ref_key,
                                           onec_amount, onec_currency, onec_doc_date, note, created_by)
         VALUES ($1, 'dismissed', 'manual', $2, $3, $4::uuid, $5, $6, $7::date, $8, $9)
         RETURNING match_id`,
        [lineId, row.erp_order_id, row.source_id, row.order_ref, row.line_amount, row.currency, dateOnly(row.doc_date), note, actor.userId],
      );
      const matchId = Number(inserted.match_id);
      await this.audit(tx, actor, 'payment.onec_dismissed', matchId, row, {
        orderId: num(row.erp_order_id), clientId: row.erp_order_id === null ? null : orders.get(Number(row.erp_order_id))?.clientId ?? null,
        paymentId: null, before: { state: row.state },
        after: { kind: 'dismissed', note }, metadata: { lineId, documentNumber: row.number },
      });
      await writeMatchEvent(tx, 'payment.onec_dismissed', `payment.onec_dismissed:${matchId}`, {
        matchId, lineId, onecDocumentId: Number(row.doc_id), orderId: num(row.erp_order_id), state: row.state,
      }, { requestId: actor.requestId, correlationId: actor.correlationId, actorUserId: actor.userId });
      return { changed: true, matchId };
    });
  }

  /** Removes the active record of the line (a match or «разобрано»); the record stays as history. */
  unmatch(
    lineId: number,
    input: { expectedMatchId: number; reason?: string | null },
    actor: CommandActor,
    checkScope: ScopeCheck,
  ): Promise<MatchCommandResult> {
    return this.database.transaction(async (tx) => {
      await this.lockUser(tx, actor.userId);
      const before = await this.loadLine(tx, lineId);
      const { rows: [record] } = await tx.query<{ order_id_at_match: string | null; payment_id: string | null; removed_at: Date | null; line_id: string }>(
        `SELECT order_id_at_match, payment_id, removed_at, onec_document_line_id AS line_id FROM payment_onec_matches WHERE match_id = $1`,
        [input.expectedMatchId],
      );
      // A record of another line (or none) is only reported AFTER the scope of this line (B-main R2-2): a foreign line
      // answers 403 whatever match id is given, so match ids cannot be probed.
      const mine = record && Number(record.line_id) === lineId ? record : null;
      const paymentOrder = mine?.payment_id == null ? null : await this.paymentOrderId(tx, Number(mine.payment_id));
      const orders = await this.lockOrders(tx, [num(mine?.order_id_at_match ?? null), paymentOrder, num(before.erp_order_id)]);
      const lockedPayment = mine?.payment_id == null ? null : await this.lockPayment(tx, Number(mine.payment_id));
      await this.lockLineDocuments(tx, before);
      const active = await this.lockMatches(tx, lineId, null);
      const row = await this.loadLine(tx, lineId);
      // Scope of the line itself first («no order» now — only «all»: fails closed for a scoped user).
      await checkScope([row.erp_order_id === null ? null : orders.get(Number(row.erp_order_id)) ?? null]);
      if (!mine) throw stateChanged({ matchId: input.expectedMatchId });
      // Then the scope of the record (B-main R1-2): the order at match time and the order of its payment as locked
      // (R1-3: one moved meanwhile to an order not locked here maps to «no order» → «all»); a «разобрано» without an
      // order — «all».
      await checkScope(mine.payment_id !== null
        ? [num(mine.order_id_at_match), num(lockedPayment?.order_id ?? null)].map((id) => (id === null ? null : orders.get(id) ?? null))
        : [mine.order_id_at_match === null ? null : orders.get(Number(mine.order_id_at_match)) ?? null]);
      const own = active.find((m) => Number(m.onec_document_line_id) === lineId);
      // Already removed (a repeat) → no change; another record is active now → stale.
      if (!own) {
        if (mine.removed_at !== null) return { changed: false, matchId: input.expectedMatchId };
        throw stateChanged({ matchId: input.expectedMatchId });
      }
      if (Number(own.match_id) !== input.expectedMatchId) throw stateChanged({ matchId: Number(own.match_id) });
      const reason = optionalNote(input.reason);
      await tx.query(
        `UPDATE payment_onec_matches SET removed_at = now(), removed_by = $2, removed_reason = 'manual' WHERE match_id = $1`,
        [own.match_id, actor.userId],
      );
      const event = own.kind === 'matched' ? 'payment.onec_unmatched' : 'payment.onec_dismiss_removed';
      await this.audit(tx, actor, event, Number(own.match_id), row, {
        orderId: num(own.order_id_at_match),
        clientId: own.order_id_at_match === null ? null : orders.get(Number(own.order_id_at_match))?.clientId ?? null,
        paymentId: num(own.payment_id),
        before: { kind: own.kind, paymentId: num(own.payment_id), note: own.note }, after: { removedReason: 'manual', reason },
        metadata: { lineId, documentNumber: row.number, state: row.state },
      });
      await writeMatchEvent(tx, own.kind === 'matched' ? 'payment.onec_unmatched' : 'payment.onec_dismissed_removed',
        `${own.kind === 'matched' ? 'payment.onec_unmatched' : 'payment.onec_dismissed'}:${own.match_id}:removed`, {
          matchId: Number(own.match_id), lineId, onecDocumentId: Number(row.doc_id), orderId: num(own.order_id_at_match),
          paymentId: num(own.payment_id), reason: 'manual',
        }, { requestId: actor.requestId, correlationId: actor.correlationId, actorUserId: actor.userId });
      return { changed: true, matchId: Number(own.match_id) };
    });
  }

  /**
   * Manual link of the line's 1C customer order: `orderId` — this ERP order; `null` — «not an ERP order» (the rule is
   * suppressed); `remove` — back to the series rule. Scope: the new order and the order resolved before (R1-3).
   */
  link(
    lineId: number,
    input: { expectedStateToken: string; orderId: number | null; remove: boolean; note?: string | null },
    actor: CommandActor,
    checkScope: ScopeCheck,
  ): Promise<MatchCommandResult> {
    return this.database.transaction(async (tx) => {
      await this.lockUser(tx, actor.userId);
      const before = await this.loadLine(tx, lineId);
      if (before.order_ref === null) {
        // Reported only after the scope of the line (B-main R2-2); without a 1C order there is no ERP order → «all».
        const lineOrders = await this.lockOrders(tx, [num(before.erp_order_id)]);
        await checkScope([before.erp_order_id === null ? null : lineOrders.get(Number(before.erp_order_id)) ?? null]);
        throw new ApiError(409, 'ONEC_RECEIPT_NO_ONEC_ORDER', 'У поступления нет заказа 1С');
      }
      // The ERP order AFTER the change: the target, or — on unlink — what the series rule resolves without the link.
      // Both orders are locked (ascending) and their candidate sets serialised with the auto-match (code review R2-1).
      const afterOrder = input.remove ? await this.ruleOrderOf(tx, before) : input.orderId;
      const orders = await this.lockOrders(tx, [num(before.erp_order_id), afterOrder]);
      await this.lockLineDocuments(tx, before);
      const { rows: links } = await tx.query<{ link_id: string; order_id: string | null }>(
        `SELECT link_id, order_id FROM order_onec_order_links
          WHERE removed_at IS NULL AND ((source_id = $1 AND onec_order_ref_key = $2::uuid) OR order_id = $3)
          ORDER BY link_id FOR UPDATE`,
        [before.source_id, before.order_ref, input.remove ? null : input.orderId],
      );
      const row = await this.loadLine(tx, lineId);
      // Scope first (B-main R1-2): the ERP order before and the one after the change — on unlink the order the rule
      // resolves (R1-3); «no order» on either side needs the scope «all».
      await checkScope([
        row.erp_order_id === null ? null : orders.get(Number(row.erp_order_id)) ?? null,
        afterOrder === null ? null : orders.get(afterOrder) ?? null,
      ]);
      this.assertToken(row, before, orders, input.expectedStateToken);
      const current = links.find((l) => Number(l.link_id) === num(row.link_id)) ?? null;
      if (input.remove && current === null) return { changed: false, matchId: null };
      if (!input.remove && current !== null && num(current.order_id) === input.orderId) return { changed: false, matchId: null };
      if (!input.remove && input.orderId !== null) {
        const target = orders.get(input.orderId);
        const ok = await tx.query<{ ok: boolean }>(
          `SELECT (o.delete_flag = false AND o.order_kind = 'production_order') AS ok FROM orders o WHERE o.order_id = $1`, [input.orderId]);
        if (!target || ok.rows[0]?.ok !== true) throw new ApiError(409, 'ONEC_LINK_ORDER_NOT_ELIGIBLE', 'Заказ ERP не найден или это не производственный заказ');
        if (links.some((l) => num(l.order_id) === input.orderId && Number(l.link_id) !== num(row.link_id))) {
          throw new ApiError(409, 'ONEC_LINK_ORDER_TAKEN', 'Этот заказ ERP уже связан с другим заказом 1С');
        }
      }
      const note = optionalNote(input.note);
      // The match rows the detection below re-checks are locked BEFORE the advisory locks — the loader locks its match
      // rows first too, so a sibling receipt of the same 1C order cannot deadlock the two (code review R3-2).
      await lockActiveMatches(tx, { onecOrderRefKeys: [row.order_ref!] });
      // LAST locks: this 1C order (a loader adding its receipt lines waits, also while it resolves to no ERP order —
      // R3-1), then the ERP orders its receipts leave and join — no auto-match of either may count candidates in between.
      await lockOnecOrderRefs(tx, Number(row.source_id), [row.order_ref!], 'exclusive');
      await lockOrderCandidates(tx, [num(row.erp_order_id), afterOrder].filter((id): id is number => id !== null), 'exclusive');
      if (current !== null) {
        await tx.query('UPDATE order_onec_order_links SET removed_at = now(), removed_by = $2 WHERE link_id = $1', [current.link_id, actor.userId]);
      }
      let linkId: number | null = null;
      if (!input.remove) {
        const { rows: [created] } = await tx.query<{ link_id: string }>(
          `INSERT INTO order_onec_order_links (source_id, onec_order_ref_key, order_id, note, created_by)
           VALUES ($1, $2::uuid, $3, $4, $5) RETURNING link_id`,
          [row.source_id, row.order_ref, input.orderId, note, actor.userId],
        );
        linkId = Number(created.link_id);
      }
      const resolved = await this.loadLine(tx, lineId);
      if (num(resolved.erp_order_id) !== afterOrder) throw stateChanged({ lineId, expectedOrderId: afterOrder });
      const event = input.remove ? 'order.onec_order_unlinked' : 'order.onec_order_linked';
      const eventKey = linkId ?? Number(current!.link_id);
      // The order the 1C order is associated with after the change (null — «not an ERP order»), else the one before.
      const subjectOrder = afterOrder ?? num(row.erp_order_id);
      await auditService.record(tx, {
        event, entityType: 'order_onec_order_link', entityId: eventKey, actorUserId: actor.userId, actorUsername: actor.username,
        actorRole: actor.role, requestId: actor.requestId, source: SOURCE,
        relatedOrderId: subjectOrder,
        relatedClientId: subjectOrder === null ? null : orders.get(subjectOrder)?.clientId ?? null,
        before: { orderId: num(row.erp_order_id), linkOrigin: row.link_origin, linkId: num(row.link_id) },
        after: input.remove
          ? { orderId: afterOrder, linkOrigin: afterOrder === null ? null : 'rule' }
          : { orderId: input.orderId, linkOrigin: 'manual', linkId, note },
        metadata: { lineId, onecOrderRefKey: row.order_ref, onecOrderNumber: row.onec_order_number, correlationId: actor.correlationId },
        relatedEntities: [
          ...(row.onec_order_doc_id === null ? [] : [{ entityType: 'onec_document', entityId: Number(row.onec_order_doc_id) }]),
          ...[num(row.erp_order_id), afterOrder].filter((id): id is number => id !== null)
            .map((entityId) => ({ entityType: 'order', entityId })),
        ],
      });
      await tx.query(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
         VALUES ($1, 'order_onec_order_link', $2, $3::jsonb, $4) ON CONFLICT DO NOTHING`,
        [event, String(eventKey), JSON.stringify({
          eventId: randomUUID(), eventType: event, linkId: eventKey, onecOrderRefKey: row.order_ref, orderIdBefore: num(row.erp_order_id),
          orderIdAfter: afterOrder, actorUserId: Number(actor.userId), requestId: actor.requestId,
          correlationId: actor.correlationId, source: SOURCE,
        }), `${event}:${eventKey}`],
      );
      // The resolved ERP order changed → active matches of this 1C order may be `changed` now.
      await detectOnecMatchTransitions(tx, { onecOrderRefKeys: [row.order_ref!] },
        { requestId: actor.requestId, correlationId: actor.correlationId, actorUserId: actor.userId, writer: 'onec_order_link' });
      return { changed: true, matchId: null };
    });
  }

  /**
   * Pairs for the auto-match (plan §5 «Автосверка»): an eligible receipt line without a record (state `review`) and
   * exactly one free payment of its ERP order with the same amount and |payment date − document date| ≤ 3 days,
   * and that payment fits exactly one such line (mutual uniqueness, over ALL lines, before any scope filter).
   * Read only; every pair is re-checked under locks by `autoMatchPair`.
   */
  async autoMatchCandidates(): Promise<Array<{ lineId: number; paymentId: number; orderId: number; createdBy: string | null; managerId: string | null }>> {
    // The candidates read the whole receipts read model (every line, ~7 s on stage under load): this one query gets
    // its own limit, as the 1C ETL bulk statements, instead of the common 10 s (28.10: «Database query timed out», the
    // pass matched nothing). Shared by the scheduled pass and the «Сверить сейчас» button; the pairs then run one by
    // one, each re-checked under locks with the common limit, so a whole pass can take longer. Transaction-local.
    const { rows } = await this.database.transaction(async (tx) => {
      await tx.query(`SELECT set_config('statement_timeout', $1, true)`, [`${AUTO_MATCH_CANDIDATES_TIMEOUT_MS}ms`]);
      return tx.query<{ line_id: string; payment_id: string; order_id: string; created_by: string | null; manager_id: string | null }>(
        `${BASE_SQL},
         pairs AS (
           SELECT b.line_id, p.payment_id, b.erp_order_id AS order_id
             FROM base b
             JOIN payments p ON p.order_id = b.erp_order_id AND p.delete_flag = false AND p.amount = b.line_amount
                            AND abs(p.payment_date - b.doc_date) <= ${AUTO_MATCH_DAYS}
            WHERE b.state = 'review'
              AND NOT EXISTS (SELECT 1 FROM payment_onec_matches pm WHERE pm.payment_id = p.payment_id AND pm.removed_at IS NULL)
         )
         SELECT pr.line_id, pr.payment_id, pr.order_id, o.created_by, o.manager_id
           FROM pairs pr JOIN orders o ON o.order_id = pr.order_id
          WHERE (SELECT count(*) FROM pairs x WHERE x.line_id = pr.line_id) = 1
            AND (SELECT count(*) FROM pairs y WHERE y.payment_id = pr.payment_id) = 1
          ORDER BY pr.order_id, pr.line_id`,
        [[...INCOMING_KINDS], this.series(), 'all', 0],
        { timeoutMs: AUTO_MATCH_CANDIDATES_TIMEOUT_MS },
      );
    });
    return rows.map((r) => ({
      lineId: Number(r.line_id), paymentId: Number(r.payment_id), orderId: Number(r.order_id),
      createdBy: r.created_by === null ? null : String(r.created_by), managerId: r.manager_id === null ? null : String(r.manager_id),
    }));
  }

  /**
   * One automatic match (origin `auto`), with the locks of a manual command and every condition re-checked under them:
   * the line is still `review`, the payment is still free and of the line's order, amount equal, dates ≤ 3 days apart,
   * and the pair is still mutually unique. Anything else → `false`, nothing written (the next pass decides again).
   */
  autoMatchPair(
    lineId: number,
    paymentId: number,
    actor: CommandActor & { passId: string },
    scope?: (order: LockedOrderRow) => boolean,
  ): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      await this.lockUser(tx, actor.userId);
      const before = await this.loadLine(tx, lineId);
      const orders = await this.lockOrders(tx, [num(before.erp_order_id), await this.paymentOrderId(tx, paymentId)]);
      const payment = await this.lockPayment(tx, paymentId);
      await this.lockLineDocuments(tx, before);
      const active = await this.lockMatches(tx, lineId, paymentId);
      // LAST lock: competing receipt lines of this ERP order cannot commit between the count and our commit (R1-4).
      if (before.erp_order_id !== null) await lockOrderCandidates(tx, [Number(before.erp_order_id)], 'exclusive');
      const row = await this.loadLine(tx, lineId);
      if (active.length > 0 || row.state !== 'review' || payment === null || payment.delete_flag) return false;
      if (row.erp_order_id === null || num(row.erp_order_id) !== num(before.erp_order_id) || !orders.has(Number(row.erp_order_id))
        || num(payment.order_id) !== num(row.erp_order_id)) return false;
      // The button's scope, re-checked on the locked order (owner/manager stable now; code review R1-2).
      if (scope && !scope(orders.get(Number(row.erp_order_id))!)) return false;
      if (Number(payment.amount) !== Number(row.line_amount)) return false;
      const { rows: [unique] } = await tx.query<{ payments: string; lines: string; days: number }>(
        `${BASE_SQL}
         SELECT (SELECT count(*) FROM payments p
                  WHERE p.order_id = $5 AND p.delete_flag = false AND p.amount = $6::numeric AND abs(p.payment_date - $7::date) <= ${AUTO_MATCH_DAYS}
                    AND NOT EXISTS (SELECT 1 FROM payment_onec_matches pm WHERE pm.payment_id = p.payment_id AND pm.removed_at IS NULL)) AS payments,
                (SELECT count(*) FROM base b
                  WHERE b.erp_order_id = $5 AND b.state = 'review' AND b.line_amount = $8::numeric
                    AND abs($9::date - b.doc_date) <= ${AUTO_MATCH_DAYS}) AS lines,
                abs($9::date - $7::date) AS days`,
        [[...INCOMING_KINDS], this.series(), 'all', 0, row.erp_order_id, row.line_amount, dateOnly(row.doc_date), payment.amount, dateOnly(payment.payment_date)],
      );
      if (Number(unique.payments) !== 1 || Number(unique.lines) !== 1 || unique.days > AUTO_MATCH_DAYS) return false;

      const { rows: [inserted] } = await tx.query<{ match_id: string }>(
        `INSERT INTO payment_onec_matches (onec_document_line_id, kind, origin, payment_id, payment_id_at_match, order_id_at_match,
                                           source_id, onec_order_ref_key, onec_amount, onec_currency, onec_doc_date,
                                           payment_amount, payment_date, created_by)
         VALUES ($1, 'matched', 'auto', $2, $2, $3, $4, $5::uuid, $6, $7, $8::date, $9, $10::date, $11)
         RETURNING match_id`,
        [lineId, paymentId, row.erp_order_id, row.source_id, row.order_ref, row.line_amount, row.currency, dateOnly(row.doc_date),
          payment.amount, dateOnly(payment.payment_date), actor.userId],
      );
      const matchId = Number(inserted.match_id);
      const facts = {
        origin: 'auto', onecAmount: String(row.line_amount), onecDocDate: dateOnly(row.doc_date), onecCurrency: row.currency,
        paymentAmount: String(payment.amount), paymentDate: dateOnly(payment.payment_date), amountDiffers: false,
      };
      await this.audit(tx, actor, 'payment.onec_matched', matchId, row, {
        orderId: Number(row.erp_order_id), clientId: orders.get(Number(row.erp_order_id))?.clientId ?? null, paymentId, before: null,
        after: { kind: 'matched', ...facts },
        metadata: { lineId, documentNumber: row.number, auto: true, passId: actor.passId },
      });
      await writeMatchEvent(tx, 'payment.onec_matched', `payment.onec_matched:${matchId}`, {
        matchId, lineId, onecDocumentId: Number(row.doc_id), orderId: Number(row.erp_order_id), paymentId, ...facts, auto: true, passId: actor.passId,
      }, { requestId: actor.requestId, correlationId: actor.correlationId, actorUserId: actor.userId });
      return true;
    });
  }

  // ------------------------------------------------------------------ locks and reads

  /** The ERP order the series rule gives the line's 1C order, ignoring any manual link (what unlink resolves to). */
  private async ruleOrderOf(tx: DatabaseClient, row: BaseRow): Promise<number | null> {
    const { rows } = await tx.query<{ order_id: string | null }>(
      `SELECT byrule.order_id
         FROM (SELECT NULL::bigint AS link_id) lk
         LEFT JOIN onec_documents od ON od.source_id = $1 AND od.doc_kind = 'customer_order' AND od.onec_ref_key = $2::uuid
         LEFT JOIN LATERAL (${seriesRuleOrderSql('$3')}) byrule ON true`,
      [row.source_id, row.order_ref, this.series()],
    );
    return num(rows[0]?.order_id ?? null);
  }

  private async lockUser(tx: DatabaseClient, userId: string): Promise<void> {
    await tx.query('SELECT 1 FROM users WHERE user_id = $1 FOR SHARE', [userId]);
  }

  /** The line as the read model sees it (scope «all»: visibility is the command's own scope check). */
  private async loadLine(tx: DatabaseClient, lineId: number): Promise<BaseRow> {
    const { rows } = await tx.query<BaseRow>(`${BASE_SQL} SELECT * FROM base WHERE line_id = $5`,
      [[...INCOMING_KINDS], this.series(), 'all', 0, lineId]);
    if (!rows[0]) throw notFound();
    return rows[0];
  }

  private async paymentOrderId(tx: DatabaseClient, paymentId: number): Promise<number | null> {
    const { rows } = await tx.query<{ order_id: string }>('SELECT order_id FROM payments WHERE payment_id = $1', [paymentId]);
    return rows[0] ? Number(rows[0].order_id) : null;
  }

  private async lockOrders(tx: DatabaseClient, orderIds: readonly (number | null)[]): Promise<Map<number, LockedOrderRow>> {
    const wanted = [...new Set(orderIds.filter((id): id is number => id !== null))];
    if (wanted.length === 0) return new Map();
    const { rows } = await tx.query<{ order_id: string; created_by: string | null; manager_id: string | null; client_id: string | null; delete_flag: boolean }>(
      `SELECT order_id, created_by, manager_id, client_id, delete_flag FROM orders WHERE order_id = ANY($1::bigint[]) ORDER BY order_id FOR UPDATE`,
      [wanted],
    );
    return new Map(rows.map((r) => [Number(r.order_id), {
      orderId: Number(r.order_id), createdBy: r.created_by === null ? null : String(r.created_by),
      managerId: r.manager_id === null ? null : String(r.manager_id), clientId: num(r.client_id), deleted: r.delete_flag,
    }]));
  }

  private async lockPayment(tx: DatabaseClient, paymentId: number) {
    const { rows } = await tx.query<{
      payment_id: string; order_id: string; version: string; amount: string; payment_date: string | Date; delete_flag: boolean;
    }>('SELECT payment_id, order_id, version, amount, payment_date, delete_flag FROM payments WHERE payment_id = $1 FOR UPDATE', [paymentId]);
    return rows[0] ?? null;
  }

  /** Headers the decision depends on (R3-1): the receipt, the 1C customer order of the line, the refunds of the receipt. */
  private async lockLineDocuments(tx: DatabaseClient, row: BaseRow): Promise<void> {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT DISTINCT rd.onec_document_id AS id
         FROM onec_document_lines rl JOIN onec_documents rd ON rd.onec_document_id = rl.onec_document_id
        WHERE rd.source_id = $1 AND rl.settlement_doc_ref_key = $2::uuid AND rd.doc_kind = ANY($3::text[])`,
      [row.source_id, row.doc_ref, [...REFUND_KINDS]],
    );
    const ids = [Number(row.doc_id), num(row.onec_order_doc_id), num(row.receipt_doc_id), ...rows.map((r) => Number(r.id))]
      .filter((id): id is number => id !== null);
    await tx.query('SELECT 1 FROM onec_documents WHERE onec_document_id = ANY($1::bigint[]) ORDER BY onec_document_id FOR SHARE',
      [[...new Set(ids)]]);
    await tx.query('SELECT 1 FROM onec_document_lines WHERE onec_document_line_id = $1 FOR SHARE', [row.line_id]);
  }

  private async lockMatches(tx: DatabaseClient, lineId: number, paymentId: number | null) {
    const { rows } = await tx.query<{
      match_id: string; onec_document_line_id: string; kind: 'matched' | 'dismissed'; payment_id: string | null;
      order_id_at_match: string | null; note: string | null; payment_current_order_id: string | null;
    }>(
      `SELECT m.match_id, m.onec_document_line_id, m.kind, m.payment_id, m.order_id_at_match, m.note,
              (SELECT p.order_id FROM payments p WHERE p.payment_id = m.payment_id) AS payment_current_order_id
         FROM payment_onec_matches m
        WHERE m.removed_at IS NULL AND (m.onec_document_line_id = $1 OR m.payment_id = $2)
        ORDER BY m.match_id FOR UPDATE OF m`,
      [lineId, paymentId],
    );
    return rows;
  }

  /** The token after the locks, and the resolved ERP order is one of the locked ones (else the lock set was wrong). */
  private assertToken(row: BaseRow, before: BaseRow, orders: Map<number, LockedOrderRow>, expected: string): void {
    const now = item(row).stateToken;
    if (now !== expected || now !== item(before).stateToken) throw stateChanged({ lineId: Number(row.line_id) });
    if (row.erp_order_id !== null && !orders.has(Number(row.erp_order_id))) throw stateChanged({ lineId: Number(row.line_id) });
  }

  private async audit(
    tx: DatabaseClient,
    actor: CommandActor,
    event: string,
    matchId: number,
    row: BaseRow,
    detail: {
      orderId: number | null; clientId: number | null; paymentId: number | null;
      before: Record<string, unknown> | null; after: Record<string, unknown>; metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    await auditService.record(tx, {
      event, entityType: 'payment_onec_match', entityId: matchId, actorUserId: actor.userId, actorUsername: actor.username,
      actorRole: actor.role, requestId: actor.requestId, source: SOURCE, relatedOrderId: detail.orderId, relatedClientId: detail.clientId,
      relatedPaymentId: detail.paymentId,
      before: detail.before, after: detail.after,
      metadata: { ...detail.metadata, correlationId: actor.correlationId },
      relatedEntities: [
        { entityType: 'onec_document', entityId: Number(row.doc_id) },
        { entityType: 'onec_document_line', entityId: Number(row.line_id) },
      ],
    });
  }
}
