import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { PaymentAccessPolicy } from '../../../permissions/policies/payment-access.policy';
import type { ScopedEntity } from '../../../permissions/policies/scope';
import {
  calculatePaymentStatusId,
  roundMoney,
  sumMoney,
} from '../../orders/domain/order-calculations';
import type {
  CreatePaymentCommand,
  DeletePaymentCommand,
  PaymentMutationResult,
  PaymentRepositoryPort,
  UpdatePaymentCommand,
} from '../application/payment-command.types';
import type {
  DeletePaymentResponseDto,
  PaymentDto,
  PaymentOrderSummaryDto,
  UpdatePaymentRequestDto,
} from '../dto/payment.dto';
import { PaymentNotFoundError, PaymentOrderNotFoundError } from '../errors/payment.errors';

interface PaymentRow extends QueryResultRow {
  payment_id: string | number;
  order_id: string | number;
  type_paid_id: string | number;
  amount: string | number;
  payment_date: string | Date;
  notes: string | null;
  ref_key_1c: string | null;
  created_by: string | number | null;
  edited_by: string | number | null;
  created_at: string | Date;
  updated_at: string | Date | null;
}

interface LockedOrderRow extends QueryResultRow {
  order_id: string | number;
  final_amount: string | number | null;
  payment_status_id: string | number;
  version: string | number;
  created_by: string | number | null;
  manager_id: string | number | null;
}

interface PaymentTotalsRow extends QueryResultRow {
  paid_amount: string | number | null;
  payment_date: string | Date | null;
}

export class PgPaymentRepository implements PaymentRepositoryPort {
  private readonly paymentAccessPolicy = new PaymentAccessPolicy();

  constructor(private readonly database: DatabaseService) {}

  createPayment(command: CreatePaymentCommand): Promise<PaymentMutationResult> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const orders = await loadOrdersForUpdate(tx, [command.dto.orderId]);
      const order = requireLockedOrder(orders, command.dto.orderId);
      this.assertPaymentScope(command.currentUser, 'create', 0, order);
      const inserted = await tx.query<PaymentRow>(
        `
        INSERT INTO payments (order_id, amount, payment_date, type_paid_id, notes, ref_key_1c)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING
          payment_id, order_id, type_paid_id, amount, payment_date, notes, ref_key_1c,
          created_by, edited_by, created_at, updated_at
        `,
        [
          command.dto.orderId,
          command.dto.amount,
          command.dto.paymentDate,
          command.dto.typePaidId,
          command.dto.notes ?? null,
          command.dto.refKey1c ?? null,
        ],
      );
      const payment = mapPaymentRow(inserted.rows[0]);
      const orderSummary = await recalculateOrderPaymentState(tx, order);
      await writeAudit(tx, {
        action: 'payments.create',
        paymentId: payment.paymentId,
        orderId: payment.orderId,
        currentUser: command.currentUser,
        requestId: command.requestId,
        after: { ...payment },
      });

      return { payment, order: orderSummary };
    });
  }

  updatePayment(command: UpdatePaymentCommand): Promise<PaymentMutationResult> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const existing = await loadPaymentForUpdate(tx, command.paymentId);
      if (!existing) {
        throw new PaymentNotFoundError(command.paymentId);
      }

      const previousOrderId = toNumber(existing.order_id);
      const nextOrderId = command.dto.orderId ?? previousOrderId;
      const orders = await loadOrdersForUpdate(tx, uniqueNumbers([previousOrderId, nextOrderId]));
      const previousOrder = requireLockedOrder(orders, previousOrderId);
      const nextOrder = requireLockedOrder(orders, nextOrderId);
      this.assertPaymentScope(command.currentUser, 'update', command.paymentId, previousOrder);
      if (nextOrderId !== previousOrderId) {
        this.assertPaymentScope(command.currentUser, 'create', command.paymentId, nextOrder);
      }
      const update = buildUpdateAssignments(command.dto);
      const updated = await tx.query<PaymentRow>(
        `
        UPDATE payments
        SET ${update.assignments}
        WHERE payment_id = $1
        RETURNING
          payment_id, order_id, type_paid_id, amount, payment_date, notes, ref_key_1c,
          created_by, edited_by, created_at, updated_at
        `,
        update.params(command.paymentId),
      );
      const payment = mapPaymentRow(updated.rows[0]);
      let orderSummary: PaymentOrderSummaryDto | null = null;

      for (const order of orders.values()) {
        const summary = await recalculateOrderPaymentState(tx, order);
        if (order.orderId === nextOrder.orderId) {
          orderSummary = summary;
        }
      }

      await writeAudit(tx, {
        action: 'payments.update',
        paymentId: payment.paymentId,
        orderId: payment.orderId,
        previousOrderId,
        currentUser: command.currentUser,
        requestId: command.requestId,
        before: { ...mapPaymentRow(existing) },
        after: { ...payment },
      });

      return { payment, order: orderSummary ?? (await recalculateOrderPaymentState(tx, nextOrder)) };
    });
  }

  deletePayment(command: DeletePaymentCommand): Promise<DeletePaymentResponseDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const existing = await loadPaymentForUpdate(tx, command.paymentId);
      if (!existing) {
        throw new PaymentNotFoundError(command.paymentId);
      }

      const orderId = toNumber(existing.order_id);
      const orders = await loadOrdersForUpdate(tx, [orderId]);
      const order = requireLockedOrder(orders, orderId);
      this.assertPaymentScope(command.currentUser, 'delete', command.paymentId, order);
      await tx.query('DELETE FROM payments WHERE payment_id = $1', [command.paymentId]);
      const orderSummary = await recalculateOrderPaymentState(tx, order);
      await writeAudit(tx, {
        action: 'payments.delete',
        paymentId: command.paymentId,
        orderId,
        currentUser: command.currentUser,
        requestId: command.requestId,
        before: { ...mapPaymentRow(existing) },
      });

      return { paymentId: command.paymentId, order: orderSummary, deleted: true };
    });
  }

  private assertPaymentScope(
    currentUser: CurrentUser,
    action: 'create' | 'update' | 'delete',
    paymentId: number,
    order: LockedOrder,
  ): void {
    const subject = {
      paymentId,
      order: order.policySubject,
    };
    const allowed =
      action === 'create'
        ? this.paymentAccessPolicy.canCreate(currentUser, subject)
        : action === 'update'
          ? this.paymentAccessPolicy.canUpdate(currentUser, subject)
          : this.paymentAccessPolicy.canDelete(currentUser, subject);

    if (!allowed) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [`payments.${action}`],
      });
    }
  }
}

function buildUpdateAssignments(dto: UpdatePaymentRequestDto): {
  assignments: string;
  params: (paymentId: number) => unknown[];
} {
  const values: unknown[] = [];
  const assignments: string[] = [];

  addAssignment('orderId', 'order_id', dto.orderId);
  addAssignment('amount', 'amount', dto.amount);
  addAssignment('paymentDate', 'payment_date', dto.paymentDate);
  addAssignment('typePaidId', 'type_paid_id', dto.typePaidId);
  addAssignment('notes', 'notes', dto.notes);
  addAssignment('refKey1c', 'ref_key_1c', dto.refKey1c);

  assignments.push('version = version + 1');

  return {
    assignments: assignments.join(', '),
    params(paymentId: number) {
      return [paymentId, ...values];
    },
  };

  function addAssignment(
    dtoKey: keyof UpdatePaymentRequestDto,
    column: string,
    value: unknown,
  ): void {
    if (!Object.prototype.hasOwnProperty.call(dto, dtoKey)) {
      return;
    }
    const index = values.push(value);
    assignments.push(`${column} = $${index + 1}`);
  }
}

async function setSessionUser(tx: TransactionClient, userId: string): Promise<void> {
  await tx.query('SELECT set_session_user($1)', [userId]);
}

async function loadPaymentForUpdate(
  tx: TransactionClient,
  paymentId: number,
): Promise<PaymentRow | null> {
  const result = await tx.query<PaymentRow>(
    `
    SELECT
      payment_id, order_id, type_paid_id, amount, payment_date, notes, ref_key_1c,
      created_by, edited_by, created_at, updated_at
    FROM payments
    WHERE payment_id = $1
    FOR UPDATE
    `,
    [paymentId],
  );

  return result.rows[0] ?? null;
}

async function loadOrdersForUpdate(
  tx: TransactionClient,
  orderIds: readonly number[],
): Promise<Map<number, LockedOrder>> {
  const result = await tx.query<LockedOrderRow>(
    `
    SELECT order_id, final_amount, payment_status_id, version, created_by, manager_id
    FROM orders
    WHERE order_id = ANY($1::bigint[]) AND delete_flag = false
    ORDER BY order_id
    FOR UPDATE
    `,
    [orderIds],
  );

  return new Map(result.rows.map((row) => [toNumber(row.order_id), mapLockedOrder(row)]));
}

async function recalculateOrderPaymentState(
  tx: TransactionClient,
  order: LockedOrder,
): Promise<PaymentOrderSummaryDto> {
  const totalsResult = await tx.query<PaymentTotalsRow>(
    `
    SELECT
      COALESCE(SUM(amount), 0) AS paid_amount,
      MAX(payment_date) AS payment_date
    FROM payments
    WHERE order_id = $1 AND delete_flag = false
    `,
    [order.orderId],
  );
  const totals = totalsResult.rows[0];
  const paidAmount = sumMoney([toNumber(totals?.paid_amount ?? 0)]);
  const paymentDate = toDateOnly(totals?.payment_date ?? null);
  const paymentStatusId = calculatePaymentStatusId(
    order.paymentStatusId,
    order.finalAmount,
    paidAmount,
  );
  const nextVersion = order.version + 1;

  await tx.query(
    `
    UPDATE orders
    SET paid_amount = $2,
        payment_date = $3,
        payment_status_id = $4,
        version = $5
    WHERE order_id = $1
    `,
    [order.orderId, paidAmount, paymentDate, paymentStatusId, nextVersion],
  );

  return {
    orderId: order.orderId,
    paidAmount,
    debtAmount: roundMoney(order.finalAmount - paidAmount),
    paymentDate,
    paymentStatusId,
    version: nextVersion,
  };
}

async function writeAudit(
  tx: TransactionClient,
  event: {
    action: 'payments.create' | 'payments.update' | 'payments.delete';
    paymentId: number;
    orderId: number;
    previousOrderId?: number;
    currentUser: CurrentUser;
    requestId?: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  },
): Promise<void> {
  await auditService.record(tx, {
    event: event.action,
    entityType: 'payment',
    entityId: event.paymentId,
    actorUserId: event.currentUser.id,
    actorUsername: event.currentUser.username,
    actorRole: event.currentUser.role,
    requestId: event.requestId ?? 'payment-command',
    source: 'backend-payments-command',
    relatedOrderId: event.orderId,
    relatedPaymentId: event.paymentId,
    before: event.before ?? null,
    after: event.after ?? null,
    metadata: { previousOrderId: event.previousOrderId ?? null },
  });
}

interface LockedOrder {
  orderId: number;
  finalAmount: number;
  paymentStatusId: number;
  version: number;
  policySubject: ScopedEntity;
}

function mapLockedOrder(row: LockedOrderRow): LockedOrder {
  return {
    orderId: toNumber(row.order_id),
    finalAmount: toNumber(row.final_amount ?? 0),
    paymentStatusId: toNumber(row.payment_status_id),
    version: toNumber(row.version),
    policySubject: {
      createdByUserId: toNullableString(row.created_by),
      managerUserId: toNullableString(row.manager_id),
    },
  };
}

function requireLockedOrder(orders: Map<number, LockedOrder>, orderId: number): LockedOrder {
  const order = orders.get(orderId);
  if (!order) {
    throw new PaymentOrderNotFoundError(orderId);
  }

  return order;
}

function mapPaymentRow(row: PaymentRow): PaymentDto {
  return {
    paymentId: toNumber(row.payment_id),
    orderId: toNumber(row.order_id),
    typePaidId: toNumber(row.type_paid_id),
    amount: toNumber(row.amount),
    paymentDate: toDateOnly(row.payment_date) ?? '',
    notes: row.notes,
    refKey1c: row.ref_key_1c,
    createdBy: toNullableNumber(row.created_by),
    editedBy: toNullableNumber(row.edited_by),
    createdAt: toIso(row.created_at) ?? '',
    updatedAt: toIso(row.updated_at),
  };
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)];
}

function toNumber(value: string | number): number {
  return Number(value);
}

function toNullableNumber(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function toNullableString(value: string | number | null): string | null {
  return value === null ? null : String(value);
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
