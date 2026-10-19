import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { computeDiff } from '../../../common/audit/audit-diff';
import type { AuditRelatedEntity } from '../../../common/audit/related-entities';
import type { DatabaseClient } from '../../../database/database.types';
import { sanitizeBitrixAudit } from '../../audit/application/bitrix-audit-sanitization';
import { recordPaymentNotifications, type NotifiedPaymentChange } from './payment-change-notification';

/**
 * One audit trail for every change of a `payments` row, whoever writes it (order form, payment command,
 * snapshot import, Bitrix24 reverse sync, Bitrix24 widget). The caller starts the capture before its first
 * write and finishes it after the order totals are recalculated, in the same transaction
 * (`beginPaymentAuditCapture` / `finishPaymentAuditCapture`, migration 259): one `payments.create | update |
 * delete | restore` event per row the transaction itself changed, with the author, the field diff and the
 * totals of the orders whose totals it changed. No change — no event, so a replay writes nothing.
 */

export type PaymentAuditOrigin =
  | 'order_form'
  | 'payment_command'
  | 'snapshot_import'
  | 'bitrix24_reverse_manual'
  | 'bitrix24_reverse_auto'
  | 'bitrix24_widget';

export interface PaymentAuditActor {
  id: string | number | null;
  username: string | null;
  role: string | null;
}

/** The payment as before: the existing `PaymentDto` fields, plus the type name and the deletion mark. */
export interface PaymentAuditRow {
  paymentId: number;
  orderId: number;
  typePaidId: number;
  typePaidName: string | null;
  amount: number;
  paymentDate: string;
  notes: string | null;
  refKey1c: string | null;
  createdBy: number | null;
  editedBy: number | null;
  createdAt: string;
  updatedAt: string | null;
  deleted: boolean;
}

export interface OrderPaymentTotals {
  paidAmount: number;
  paymentStatusId: number | null;
  paymentStatusName: string | null;
}

export interface PaymentAuditState {
  payments: Map<number, PaymentAuditRow>;
  /** Totals only of the orders whose totals this transaction itself inserted or updated. */
  orders: Map<number, OrderPaymentTotals>;
}

export interface RecordPaymentChangesInput {
  before: PaymentAuditState;
  after: PaymentAuditState;
  actor: PaymentAuditActor | null;
  source: string;
  requestId: string;
  origin: PaymentAuditOrigin;
  /** Business reference of the trigger that is not an audit request id (e.g. an incoming request id). */
  requestRef?: Record<string, number | string> | null;
}

/** Who/where of a command whose changes were captured (`finishPaymentAuditCapture` supplies before/after). */
export type CapturedPaymentChangesInput = Omit<RecordPaymentChangesInput, 'before' | 'after'>;

/** Finishes the capture and writes the events. Returns the number of events written. */
export async function recordCapturedPaymentChanges(
  client: DatabaseClient,
  input: CapturedPaymentChangesInput,
): Promise<number> {
  return recordPaymentChanges(client, { ...input, ...await finishPaymentAuditCapture(client) });
}

/** Fields whose change is a business change of the payment (authorship/timestamps are not). */
const COMPARED_FIELDS = ['orderId', 'typePaidId', 'amount', 'paymentDate', 'notes', 'refKey1c', 'deleted'] as const;

interface PaymentStateRow extends QueryResultRow {
  payment_id: string | number;
  order_id: string | number;
  type_paid_id: string | number;
  type_paid_name?: string | null;
  amount: string | number;
  payment_date: string | Date;
  notes: string | null;
  ref_key_1c: string | null;
  created_by: string | number | null;
  edited_by: string | number | null;
  created_at: string | Date;
  updated_at: string | Date | null;
  delete_flag: boolean;
}

interface CaptureRow extends QueryResultRow {
  kind: 'payment' | 'order';
  id: string | number;
  image: Record<string, unknown> | null;
}

const CAPTURE_SETTING = 'app.payment_audit_capture';

/**
 * Starts capturing, for this transaction, the first image of every payments row and of the payment totals of
 * every orders row it changes (migration 259 triggers). Call before the command's first payment/order write.
 */
export async function beginPaymentAuditCapture(client: DatabaseClient): Promise<void> {
  const flag = await client.query<{ on: string | null }>(`SELECT current_setting('${CAPTURE_SETTING}', true) AS on`);
  if (flag.rows[0]?.on === 'on') throw new Error('Payment audit capture is already running in this transaction');
  await client.query(
    `CREATE TEMP TABLE IF NOT EXISTS payment_audit_capture (
       kind text NOT NULL, id bigint NOT NULL, image jsonb, PRIMARY KEY (kind, id)
     ) ON COMMIT DELETE ROWS`,
  );
  await client.query('DELETE FROM pg_temp.payment_audit_capture');
  // The order sync events this command enqueues (migration 260 trigger), for its Bitrix24 notifications.
  await client.query(
    `CREATE TEMP TABLE IF NOT EXISTS payment_notification_sync_event (
       outbox_event_id uuid PRIMARY KEY, idempotency_key text
     ) ON COMMIT DELETE ROWS`,
  );
  await client.query('DELETE FROM pg_temp.payment_notification_sync_event');
  await client.query(`SELECT set_config('${CAPTURE_SETTING}', 'on', true)`);
}

/**
 * Stops capturing and returns the captured rows as they were before the transaction changed them and as they are
 * now. Only rows this transaction wrote are included (they stay locked by it), so concurrent changes of other
 * transactions never appear. Call after the order totals are recalculated.
 */
export async function finishPaymentAuditCapture(
  client: DatabaseClient,
): Promise<{ before: PaymentAuditState; after: PaymentAuditState }> {
  await client.query(`SELECT set_config('${CAPTURE_SETTING}', '', true)`);
  const captured = await client.query<CaptureRow>('SELECT kind, id, image FROM pg_temp.payment_audit_capture ORDER BY kind, id');
  await client.query('DELETE FROM pg_temp.payment_audit_capture');
  const paymentImages = captured.rows.filter((row) => row.kind === 'payment');
  const orderImages = captured.rows.filter((row) => row.kind === 'order');
  const paymentIds = paymentImages.map((row) => Number(row.id));
  const orderIds = orderImages.map((row) => Number(row.id));

  const current = paymentIds.length === 0 ? [] : (await client.query<PaymentStateRow>(
    `SELECT p.payment_id, p.order_id, p.type_paid_id, pt.type_paid_name, p.amount, p.payment_date, p.notes,
            p.ref_key_1c, p.created_by, p.edited_by, p.created_at, p.updated_at, p.delete_flag
       FROM payments p LEFT JOIN payment_types pt ON pt.type_paid_id = p.type_paid_id
      WHERE p.payment_id = ANY($1::bigint[])`,
    [paymentIds],
  )).rows;
  const beforeRows = paymentImages
    .filter((row) => row.image !== null)
    .map((row) => row.image as unknown as PaymentStateRow);
  const typeNames = await paymentTypeNames(client, beforeRows.map((row) => Number(row.type_paid_id)));
  const currentOrders = orderIds.length === 0 ? [] : (await client.query<{ order_id: string | number; paid_amount: string | number | null; payment_status_id: string | number | null }>(
    'SELECT order_id, paid_amount, payment_status_id FROM orders WHERE order_id = ANY($1::bigint[])',
    [orderIds],
  )).rows;
  const statusIds = [
    ...orderImages.map((row) => row.image?.payment_status_id),
    ...currentOrders.map((row) => row.payment_status_id),
  ].filter((id) => id !== null && id !== undefined).map(Number);
  const statusNames = await paymentStatusNames(client, statusIds);
  const totals = (paid: unknown, statusId: unknown): OrderPaymentTotals => ({
    paidAmount: Number(paid ?? 0),
    paymentStatusId: statusId === null || statusId === undefined ? null : Number(statusId),
    paymentStatusName: statusId === null || statusId === undefined ? null : statusNames.get(Number(statusId)) ?? null,
  });

  return {
    before: {
      payments: new Map(beforeRows.map((row) => {
        const mapped = mapPaymentRow({ ...row, type_paid_name: typeNames.get(Number(row.type_paid_id)) ?? null });
        return [mapped.paymentId, mapped];
      })),
      orders: new Map(orderImages.map((row) => [Number(row.id), totals(row.image?.paid_amount, row.image?.payment_status_id)])),
    },
    after: {
      payments: new Map(current.map((row) => {
        const mapped = mapPaymentRow(row);
        return [mapped.paymentId, mapped];
      })),
      orders: new Map(currentOrders.map((row) => [Number(row.order_id), totals(row.paid_amount, row.payment_status_id)])),
    },
  };
}

async function paymentTypeNames(client: DatabaseClient, ids: number[]): Promise<Map<number, string | null>> {
  const unique = [...new Set(ids.filter(Number.isFinite))];
  if (unique.length === 0) return new Map();
  const result = await client.query<{ type_paid_id: string | number; type_paid_name: string | null }>(
    'SELECT type_paid_id, type_paid_name FROM payment_types WHERE type_paid_id = ANY($1::bigint[])',
    [unique],
  );
  return new Map(result.rows.map((row) => [Number(row.type_paid_id), row.type_paid_name]));
}

async function paymentStatusNames(client: DatabaseClient, ids: number[]): Promise<Map<number, string | null>> {
  const unique = [...new Set(ids.filter(Number.isFinite))];
  if (unique.length === 0) return new Map();
  const result = await client.query<{ payment_status_id: string | number; payment_status_name: string | null }>(
    'SELECT payment_status_id, payment_status_name FROM payment_statuses WHERE payment_status_id = ANY($1::bigint[])',
    [unique],
  );
  return new Map(result.rows.map((row) => [Number(row.payment_status_id), row.payment_status_name]));
}

/** Empty state (tests and callers that changed nothing). */
export function emptyPaymentAuditState(): PaymentAuditState {
  return { payments: new Map(), orders: new Map() };
}

export type PaymentChangeEvent = 'payments.create' | 'payments.update' | 'payments.delete' | 'payments.restore';

/**
 * Writes one audit event per changed payment and, for changes made in ERP, the Bitrix24 notification rows of the
 * affected orders (`recordPaymentNotifications`). Returns the number of events written.
 */
export async function recordPaymentChanges(
  client: DatabaseClient,
  input: RecordPaymentChangesInput,
): Promise<number> {
  const paymentIds = [...new Set([...input.before.payments.keys(), ...input.after.payments.keys()])].sort((a, b) => a - b);
  let actor: PaymentAuditActor | null = input.actor;
  let written = 0;
  const notified: NotifiedPaymentChange[] = [];
  for (const paymentId of paymentIds) {
    const was = input.before.payments.get(paymentId) ?? null;
    const now = input.after.payments.get(paymentId) ?? null;
    const event = classify(was, now);
    if (!event) continue;
    if (written === 0) actor = await withActorName(client, actor);
    const beforeOrderId = was?.orderId ?? now!.orderId;
    const afterOrderId = now?.orderId ?? was!.orderId;
    // Free-text fields may carry a pasted Bitrix24 webhook URL or token: mask them before persisting.
    const before = safe(event === 'payments.create'
      ? orderTotals(input.before, afterOrderId)
      : { ...was!, ...orderTotals(input.before, beforeOrderId) });
    const after = safe(event === 'payments.delete'
      ? { deleted: true, ...orderTotals(input.after, beforeOrderId) }
      : { ...now!, ...orderTotals(input.after, afterOrderId) });
    const relatedEntities: AuditRelatedEntity[] = [{ entityType: 'order', entityId: afterOrderId }];
    if (beforeOrderId !== afterOrderId) relatedEntities.push({ entityType: 'order', entityId: beforeOrderId });
    const auditId = await auditService.record(client, {
      event,
      entityType: 'payment',
      entityId: paymentId,
      actorUserId: actor?.id ?? null,
      actorUsername: actor?.username ?? null,
      actorRole: actor?.role ?? null,
      requestId: input.requestId,
      source: input.source,
      relatedOrderId: afterOrderId,
      relatedPaymentId: paymentId,
      relatedEntities,
      before,
      after,
      diff: computeDiff(withoutTechnical(before), withoutTechnical(after)),
      metadata: {
        origin: input.origin,
        previousOrderId: beforeOrderId !== afterOrderId ? beforeOrderId : null,
        ...(input.requestRef ? { requestRef: input.requestRef } : {}),
      },
    });
    notified.push({ event, was, now, auditId });
    written += 1;
  }
  await recordPaymentNotifications(client, { origin: input.origin, requestId: input.requestId, actor }, notified);
  return written;
}

/** Callers that know only the user id (Bitrix24 reverse endpoints) still get «who» by name in the history. */
async function withActorName(client: DatabaseClient, actor: PaymentAuditActor | null): Promise<PaymentAuditActor | null> {
  if (!actor || actor.id === null || actor.username) return actor;
  const id = Number(actor.id);
  if (!Number.isFinite(id)) return actor;
  const user = await client.query<{ username: string; role_code: string | null }>(
    `SELECT u.username, r.role_code FROM users u LEFT JOIN roles r ON r.role_id = u.role_id WHERE u.user_id = $1`,
    [id],
  );
  const row = user.rows[0];
  return row ? { id: actor.id, username: row.username, role: actor.role ?? row.role_code } : actor;
}

function classify(was: PaymentAuditRow | null, now: PaymentAuditRow | null): PaymentChangeEvent | null {
  const wasActive = was !== null && !was.deleted;
  const nowActive = now !== null && !now.deleted;
  if (!wasActive && nowActive) return was === null ? 'payments.create' : 'payments.restore';
  if (wasActive && !nowActive) return 'payments.delete';
  if (!wasActive || !nowActive) return null;
  return COMPARED_FIELDS.some((field) => was[field] !== now[field]) ? 'payments.update' : null;
}

function safe(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeBitrixAudit(value) as Record<string, unknown>;
}

/** Authorship and timestamps stay in before/after but are not part of the business diff. */
function withoutTechnical(value: Record<string, unknown>): Record<string, unknown> {
  const { createdBy: _createdBy, editedBy: _editedBy, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = value;
  return rest;
}

/** Totals of an order whose totals the transaction did not change are unknown here: no fields at all. */
function orderTotals(state: PaymentAuditState, orderId: number) {
  const totals = state.orders.get(orderId);
  if (!totals) return {};
  return {
    orderPaidAmount: totals.paidAmount,
    orderPaymentStatusName: totals.paymentStatusName,
  };
}

function mapPaymentRow(row: PaymentStateRow): PaymentAuditRow {
  return {
    paymentId: Number(row.payment_id),
    orderId: Number(row.order_id),
    typePaidId: Number(row.type_paid_id),
    typePaidName: row.type_paid_name ?? null,
    amount: Number(row.amount),
    paymentDate: toDateOnly(row.payment_date) ?? '',
    notes: row.notes,
    refKey1c: row.ref_key_1c,
    createdBy: row.created_by === null ? null : Number(row.created_by),
    editedBy: row.edited_by === null ? null : Number(row.edited_by),
    createdAt: toIso(row.created_at) ?? '',
    updatedAt: toIso(row.updated_at),
    deleted: row.delete_flag === true,
  };
}

function toDateOnly(value: string | Date | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function toIso(value: string | Date | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
