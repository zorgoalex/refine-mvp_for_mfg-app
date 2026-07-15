import type { QueryResult, QueryResultRow } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { PgPaymentRepository } from './pg-payment-repository';

const mocks = vi.hoisted(() => ({
  evaluateStatusAutomation: vi.fn(),
  record: vi.fn(),
}));

vi.mock('../../status-automation/application/status-automation-runtime', () => ({
  evaluateStatusAutomation: mocks.evaluateStatusAutomation,
}));

vi.mock('../../../common/audit/audit.service', () => ({
  auditService: {
    record: mocks.record,
    recordDenied: vi.fn(),
  },
}));

describe('PgPaymentRepository status automation events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.record.mockResolvedValue('audit-id');
    mocks.evaluateStatusAutomation.mockResolvedValue(undefined);
  });

  it('emits payment.created with the count after the audit and emits a status change when needed', async () => {
    const database = createDatabase({
      orderStatuses: { 15: 1 },
      orderTotals: { 15: { paidAmount: 250, paymentDate: '2026-05-01' } },
      paymentsCount: 3,
    });
    const repository = new PgPaymentRepository(database.service);
    const actor = currentUser();

    await repository.createPayment({
      currentUser: actor,
      dto: { orderId: 15, typePaidId: 1, amount: 250, paymentDate: '2026-05-01' },
      requestId: 'create-request',
    });

    expect(mocks.evaluateStatusAutomation).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      {
        eventType: 'payment.created',
        origin: 'user',
        orderId: 15,
        actor,
        requestId: 'create-request',
        paymentsCountAfter: 3,
      },
    );
    expect(mocks.evaluateStatusAutomation).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      {
        eventType: 'order.payment_status_changed',
        origin: 'user',
        orderId: 15,
        actor,
        requestId: 'create-request',
        paymentStatusIdBefore: 1,
        paymentStatusIdAfter: 2,
      },
    );
    expect(database.timeline.indexOf('audit')).toBeLessThan(database.timeline.indexOf('automation'));
  });

  it('emits only payment.created when create does not change payment status', async () => {
    const database = createDatabase({
      orderStatuses: { 15: 2 },
      orderTotals: { 15: { paidAmount: 250, paymentDate: '2026-05-01' } },
      paymentsCount: 1,
    });
    const repository = new PgPaymentRepository(database.service);

    await repository.createPayment({
      currentUser: currentUser(),
      dto: { orderId: 15, typePaidId: 1, amount: 250, paymentDate: '2026-05-01' },
    });

    expect(mocks.evaluateStatusAutomation).toHaveBeenCalledTimes(1);
    expect(mocks.evaluateStatusAutomation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'payment.created',
        requestId: 'payment-30',
        paymentsCountAfter: 1,
      }),
    );
  });

  it('emits a status change for each order when an update moves a payment', async () => {
    const database = createDatabase({
      paymentOrderId: 15,
      orderStatuses: { 15: 2, 16: 1 },
      orderTotals: {
        15: { paidAmount: 0, paymentDate: null },
        16: { paidAmount: 400, paymentDate: '2026-05-02' },
      },
    });
    const repository = new PgPaymentRepository(database.service);
    const actor = currentUser();

    await repository.updatePayment({
      currentUser: actor,
      paymentId: 30,
      dto: { orderId: 16, amount: 400, paymentDate: '2026-05-02' },
      requestId: 'update-request',
    });

    expect(mocks.evaluateStatusAutomation).toHaveBeenCalledTimes(2);
    expect(mocks.evaluateStatusAutomation).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        eventType: 'order.payment_status_changed',
        orderId: 15,
        requestId: 'update-request',
        paymentStatusIdBefore: 2,
        paymentStatusIdAfter: 1,
      }),
    );
    expect(mocks.evaluateStatusAutomation).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        eventType: 'order.payment_status_changed',
        orderId: 16,
        requestId: 'update-request',
        paymentStatusIdBefore: 1,
        paymentStatusIdAfter: 2,
      }),
    );
    expect(database.timeline.indexOf('audit')).toBeLessThan(database.timeline.indexOf('automation'));
  });

  it('does not emit update events when neither order changes status', async () => {
    const database = createDatabase({
      paymentOrderId: 15,
      orderStatuses: { 15: 1, 16: 2 },
      orderTotals: {
        15: { paidAmount: 0, paymentDate: null },
        16: { paidAmount: 400, paymentDate: '2026-05-02' },
      },
    });
    const repository = new PgPaymentRepository(database.service);

    await repository.updatePayment({
      currentUser: currentUser(),
      paymentId: 30,
      dto: { orderId: 16, amount: 400, paymentDate: '2026-05-02' },
    });

    expect(mocks.evaluateStatusAutomation).not.toHaveBeenCalled();
  });

  it('emits a delete status change with the payment fallback request id', async () => {
    const database = createDatabase({
      paymentOrderId: 15,
      orderStatuses: { 15: 2 },
      orderTotals: { 15: { paidAmount: 0, paymentDate: null } },
    });
    const repository = new PgPaymentRepository(database.service);
    const actor = currentUser();

    await repository.deletePayment({ currentUser: actor, paymentId: 30 });

    expect(mocks.evaluateStatusAutomation).toHaveBeenCalledTimes(1);
    expect(mocks.evaluateStatusAutomation).toHaveBeenCalledWith(
      expect.anything(),
      {
        eventType: 'order.payment_status_changed',
        origin: 'user',
        orderId: 15,
        actor,
        requestId: 'payment-30',
        paymentStatusIdBefore: 2,
        paymentStatusIdAfter: 1,
      },
    );
    expect(database.timeline.indexOf('audit')).toBeLessThan(database.timeline.indexOf('automation'));
  });
});

interface DatabaseOptions {
  paymentOrderId?: number;
  orderStatuses?: Record<number, number>;
  orderTotals?: Record<number, { paidAmount: number; paymentDate: string | null }>;
  paymentsCount?: number;
}

function createDatabase(options: DatabaseOptions = {}) {
  const timeline: string[] = [];
  const orderStatuses = options.orderStatuses ?? { 15: 1 };
  const query = vi.fn(async (
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<QueryResultRow>> => {
    const normalized = normalizeSql(text);

    if (normalized.startsWith('SELECT payment_id, order_id, type_paid_id, amount, payment_date')) {
      return result([paymentRow({ order_id: options.paymentOrderId ?? 15 })]);
    }

    if (normalized.startsWith('SELECT order_id, final_amount')) {
      const orderIds = params[0] as readonly number[];
      return result(orderIds.map((orderId) => ({
        order_id: orderId,
        final_amount: 1000,
        payment_status_id: orderStatuses[orderId] ?? 1,
        version: 3,
        created_by: 1,
        manager_id: null,
      })));
    }

    if (normalized.startsWith('INSERT INTO payments')) {
      return result([paymentRow({ order_id: params[0], amount: params[1] })]);
    }

    if (normalized.startsWith('UPDATE payments')) {
      const orderId = params.includes(16) ? 16 : options.paymentOrderId ?? 15;
      const amount = params.includes(400) ? 400 : 250;
      return result([paymentRow({ order_id: orderId, amount })]);
    }

    if (normalized.startsWith('SELECT COALESCE(SUM(amount), 0)')) {
      const orderId = params[0] as number;
      const totals = options.orderTotals?.[orderId] ?? {
        paidAmount: 250,
        paymentDate: '2026-05-01',
      };
      return result([{ paid_amount: totals.paidAmount, payment_date: totals.paymentDate }]);
    }

    if (normalized.startsWith('SELECT COUNT(*) AS payments_count')) {
      return result([{ payments_count: options.paymentsCount ?? 0 }]);
    }

    return result([]);
  });

  mocks.record.mockImplementation(async () => {
    timeline.push('audit');
    return 'audit-id';
  });
  mocks.evaluateStatusAutomation.mockImplementation(async () => {
    timeline.push('automation');
  });

  const tx = { query, raw: {} } as unknown as TransactionClient;
  const service = {
    query,
    transaction<T>(handler: (client: TransactionClient) => Promise<T>): Promise<T> {
      return handler(tx);
    },
  } as unknown as DatabaseService;

  return { service, timeline };
}

function result(rows: QueryResultRow[]): QueryResult<QueryResultRow> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

function paymentRow(overrides: Record<string, unknown> = {}): QueryResultRow {
  return {
    payment_id: 30,
    order_id: 15,
    type_paid_id: 1,
    amount: 250,
    payment_date: '2026-05-01',
    notes: null,
    ref_key_1c: null,
    created_by: 1,
    edited_by: null,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: null,
    ...overrides,
  };
}

function currentUser(role: CurrentUser['role'] = 'admin', id = '1'): CurrentUser {
  return {
    id,
    username: role,
    role,
    roleId: 1,
    permissions: getPermissionsForRole(role),
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}
