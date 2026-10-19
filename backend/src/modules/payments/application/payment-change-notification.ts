import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from '../../../database/database.types';
import { safeOutboundText } from '../../crm-sync/application/bitrix24-safe-text';
import type { PaymentAuditActor, PaymentAuditOrigin, PaymentAuditRow, PaymentChangeEvent } from './payment-change-audit';

/**
 * Notification of the Bitrix24 deal owner about payment changes made in ERP (migration 260): one row per order
 * touched by one command, written in the command's transaction with a snapshot of safe fields. Changes that came
 * from Bitrix24 itself are its echo and are not notified. The crm-sync worker delivers the rows.
 */

/** Origins whose changes are made by ERP people; Bitrix24 reverse sync and the widget are not notified. */
export const NOTIFIED_PAYMENT_ORIGINS: ReadonlySet<PaymentAuditOrigin> = new Set(['order_form', 'payment_command', 'snapshot_import']);

export type PaymentNotificationLineKind = 'added' | 'changed' | 'deleted' | 'restored' | 'moved_in' | 'moved_out';

export interface PaymentNotificationLine {
  kind: PaymentNotificationLineKind;
  otherOrderName?: string;
  amountBefore?: number;
  amountAfter?: number;
  dateBefore?: string;
  dateAfter?: string;
  typeBefore?: string;
  typeAfter?: string;
}

export interface PaymentNotificationPayload {
  orderName: string;
  finalAmount: number | null;
  paidAfter: number;
  statusAfter: string | null;
  actorName: string | null;
  lines: PaymentNotificationLine[];
  /** Payments the lines are about (for the audit links, never rendered). */
  paymentIds: number[];
}

export interface NotifiedPaymentChange {
  event: PaymentChangeEvent;
  was: PaymentAuditRow | null;
  now: PaymentAuditRow | null;
  auditId: string;
}

interface OrderRow {
  order_id: string | number;
  order_name: string | null;
  final_amount: string | number | null;
  paid_amount: string | number | null;
  payment_status_name: string | null;
}

/** Writes one notification row per order with a visible change. Returns the number of rows. */
export async function recordPaymentNotifications(
  client: DatabaseClient,
  input: { origin: PaymentAuditOrigin; requestId: string; actor: PaymentAuditActor | null },
  changes: NotifiedPaymentChange[],
): Promise<number> {
  if (!NOTIFIED_PAYMENT_ORIGINS.has(input.origin) || changes.length === 0) return 0;
  const orderIds = [...new Set(changes.flatMap(({ was, now }) => [was?.orderId, now?.orderId]).filter((id): id is number => id !== undefined))];
  const orders = new Map((await client.query<OrderRow>(
    `SELECT o.order_id, o.order_name, o.final_amount, o.paid_amount, ps.payment_status_name
       FROM orders o LEFT JOIN payment_statuses ps ON ps.payment_status_id = o.payment_status_id
      WHERE o.order_id = ANY($1::bigint[])`,
    [orderIds],
  )).rows.map((row) => [Number(row.order_id), row]));
  const name = (orderId: number) => safeOutboundText(orders.get(orderId)?.order_name ?? `№${orderId}`);

  const byOrder = new Map<number, { lines: PaymentNotificationLine[]; auditIds: string[]; paymentIds: number[] }>();
  const add = (orderId: number, line: PaymentNotificationLine, auditId: string, paymentId: number) => {
    const group = byOrder.get(orderId) ?? { lines: [], auditIds: [], paymentIds: [] };
    group.lines.push(line);
    if (!group.auditIds.includes(auditId)) group.auditIds.push(auditId);
    if (!group.paymentIds.includes(paymentId)) group.paymentIds.push(paymentId);
    byOrder.set(orderId, group);
  };
  for (const { event, was, now, auditId } of changes) {
    const paymentId = (now ?? was)!.paymentId;
    if (event === 'payments.create' || event === 'payments.restore') {
      add(now!.orderId, { kind: event === 'payments.create' ? 'added' : 'restored', ...afterOf(now!) }, auditId, paymentId);
    } else if (event === 'payments.delete') {
      add(was!.orderId, { kind: 'deleted', ...beforeOf(was!) }, auditId, paymentId);
    } else if (was!.orderId !== now!.orderId) {
      add(was!.orderId, { kind: 'moved_out', otherOrderName: name(now!.orderId), ...beforeOf(was!) }, auditId, paymentId);
      add(now!.orderId, { kind: 'moved_in', otherOrderName: name(was!.orderId), ...changedOf(was!, now!), ...afterOf(now!) }, auditId, paymentId);
    } else {
      const changed = changedOf(was!, now!);
      // A change of the note or the 1C reference only is not shown to the manager.
      if (Object.keys(changed).length > 0) add(now!.orderId, { kind: 'changed', ...changed }, auditId, paymentId);
    }
  }
  if (![...byOrder.keys()].some((orderId) => orders.has(orderId))) return 0;

  const actorName = safeOutboundText(await actorDisplayName(client, input.actor)) || null;
  let written = 0;
  for (const [orderId, group] of [...byOrder].sort(([a], [b]) => a - b)) {
    const order = orders.get(orderId);
    if (!order) continue;
    const payload: PaymentNotificationPayload = {
      orderName: name(orderId),
      finalAmount: order.final_amount === null ? null : Number(order.final_amount),
      paidAfter: Number(order.paid_amount ?? 0),
      statusAfter: safeOutboundText(order.payment_status_name) || null,
      actorName,
      lines: group.lines,
      paymentIds: group.paymentIds,
    };
    const syncEventId = await ownOrderSyncEventId(client, orderId);
    await client.query(
      `INSERT INTO crm_sync_payment_notification
         (notification_id, erp_order_id, correlation_request_id, audit_ids, actor_user_id, payload, sync_event_id)
       VALUES ($1, $2, $3, $4::uuid[], $5, $6::jsonb, $7)`,
      [randomUUID(), orderId, input.requestId, group.auditIds, actorId(input.actor), JSON.stringify(payload),
        syncEventId],
    );
    written += 1;
  }
  return written;
}

/**
 * The order's sync event enqueued by THIS command: the migration 260 trigger recorded every event the command
 * inserted into the session table while its capture was on; the one still pending is the event that will carry
 * this command's payments to Bitrix24 (the enqueue function replaced the earlier ones). No timestamps, no xid
 * arithmetic. Null when the table is absent (no capture) or not exactly one is pending (readiness then falls back
 * to the order's events).
 */
export async function ownOrderSyncEventId(client: DatabaseClient, orderId: number): Promise<string | null> {
  const table = await client.query<{ present: boolean }>(
    "SELECT to_regclass('pg_temp.payment_notification_sync_event') IS NOT NULL AS present",
  );
  if (table.rows[0]?.present !== true) return null;
  const result = await client.query<{ outbox_event_id: string }>(
    `SELECT e.outbox_event_id
       FROM pg_temp.payment_notification_sync_event c
       JOIN crm_sync_outbox e ON e.outbox_event_id = c.outbox_event_id
      WHERE c.idempotency_key = 'order:' || $1::text AND e.status = 'pending'
      LIMIT 2`,
    [orderId],
  );
  return result.rows.length === 1 ? result.rows[0].outbox_event_id : null;
}

function afterOf(row: PaymentAuditRow): Pick<PaymentNotificationLine, 'amountAfter' | 'dateAfter' | 'typeAfter'> {
  return { amountAfter: row.amount, dateAfter: row.paymentDate, typeAfter: safeOutboundText(row.typePaidName) };
}

function beforeOf(row: PaymentAuditRow): Pick<PaymentNotificationLine, 'amountBefore' | 'dateBefore' | 'typeBefore'> {
  return { amountBefore: row.amount, dateBefore: row.paymentDate, typeBefore: safeOutboundText(row.typePaidName) };
}

/** Only the visible fields that changed, as before/after pairs. */
function changedOf(was: PaymentAuditRow, now: PaymentAuditRow): Partial<PaymentNotificationLine> {
  const changed: Partial<PaymentNotificationLine> = {};
  if (was.amount !== now.amount) Object.assign(changed, { amountBefore: was.amount, amountAfter: now.amount });
  if (was.paymentDate !== now.paymentDate) Object.assign(changed, { dateBefore: was.paymentDate, dateAfter: now.paymentDate });
  if (was.typePaidId !== now.typePaidId) {
    Object.assign(changed, { typeBefore: safeOutboundText(was.typePaidName), typeAfter: safeOutboundText(now.typePaidName) });
  }
  return changed;
}

function actorId(actor: PaymentAuditActor | null): number | null {
  const id = Number(actor?.id);
  return actor?.id !== null && actor?.id !== undefined && Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function actorDisplayName(client: DatabaseClient, actor: PaymentAuditActor | null): Promise<string | null> {
  const id = actorId(actor);
  if (id !== null) {
    const user = await client.query<{ full_name: string | null; username: string | null }>(
      'SELECT full_name, username::text AS username FROM users WHERE user_id = $1',
      [id],
    );
    const row = user.rows[0];
    if (row) return row.full_name?.trim() || row.username;
  }
  return actor?.username ?? null;
}
