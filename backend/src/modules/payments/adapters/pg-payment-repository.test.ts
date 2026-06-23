import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { auditService } from '../../../common/audit/audit.service';
import { PgPaymentRepository } from './pg-payment-repository';

describe('PgPaymentRepository', () => {
  it('creates a payment, recalculates parent order, and writes audit in one transaction', async () => {
    const database = createDatabase();
    const repository = new PgPaymentRepository(database.service);

    const result = await repository.createPayment({
      currentUser: currentUser(),
      dto: {
        orderId: 15,
        typePaidId: 1,
        amount: 250,
        paymentDate: '2026-05-01',
        notes: 'cash',
      },
      requestId: 'request-1',
    });

    expect(result.payment).toMatchObject({
      paymentId: 30,
      orderId: 15,
      amount: 250,
      paymentDate: '2026-05-01',
    });
    expect(result.order).toMatchObject({
      orderId: 15,
      paidAmount: 250,
      debtAmount: 750,
      paymentStatusId: 2,
      version: 4,
    });
    const sql = normalizedSql(database.queries);
    expect(sql).toContain('SELECT set_session_user($1)');
    expect(sql).toContain('INSERT INTO payments');
    expect(sql).toContain('SELECT COALESCE(SUM(amount), 0) AS paid_amount');
    expect(sql).toContain('UPDATE orders SET paid_amount');
    expect(sql).toContain('INSERT INTO audit_log');
  });

  it('updates a payment and recalculates both old and new order when order changes', async () => {
    const database = createDatabase({
      paymentOrderId: 15,
      orderTotals: {
        15: { paidAmount: 0, paymentDate: null },
        16: { paidAmount: 400, paymentDate: '2026-05-02' },
      },
    });
    const repository = new PgPaymentRepository(database.service);

    const result = await repository.updatePayment({
      currentUser: currentUser(),
      paymentId: 30,
      dto: { orderId: 16, amount: 400, paymentDate: '2026-05-02' },
      requestId: 'request-2',
    });

    expect(result.payment).toMatchObject({
      paymentId: 30,
      orderId: 16,
      amount: 400,
    });
    expect(result.order).toMatchObject({
      orderId: 16,
      paidAmount: 400,
      debtAmount: 600,
      paymentStatusId: 2,
    });
    const orderUpdates = database.queries.filter((query) =>
      normalizeSql(query.text).startsWith('UPDATE orders SET paid_amount'),
    );
    expect(orderUpdates).toHaveLength(2);

    const auditInsert = database.queries.find(
      (q) => /INSERT INTO audit_log/i.test(q.text) && /related_payment_id/i.test(q.text),
    );
    expect(auditInsert).toBeDefined();
    expect(auditInsert!.params[0]).toBe('payments.update');
    expect(auditInsert!.params[1]).toBe('payment');
    expect(auditInsert!.params[8]).toBe(16);
    expect(auditInsert!.params[10]).toBe(30);
  });

  it('rejects manager payment updates outside their own order scope before mutation', async () => {
    const database = createDatabase({
      orderCreatedByUserId: 1,
      orderManagerUserId: null,
    });
    const repository = new PgPaymentRepository(database.service);

    await expect(
      repository.updatePayment({
        currentUser: currentUser('manager', '99'),
        paymentId: 30,
        dto: { amount: 400 },
        requestId: 'request-denied',
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    });

    expect(normalizedSql(database.queries)).not.toContain('UPDATE payments');
  });

  it('createPayment writes a query-ready audit row with related_payment_id and event', async () => {
    const database = createDatabase();
    const repository = new PgPaymentRepository(database.service);

    await repository.createPayment({
      currentUser: currentUser(),
      dto: {
        orderId: 15,
        typePaidId: 1,
        amount: 250,
        paymentDate: '2026-05-01',
      },
      requestId: 'request-audit',
    });

    const auditInsert = database.queries.find(
      (q) =>
        /INSERT INTO audit_log/i.test(q.text) && /related_payment_id/i.test(q.text),
    );
    expect(auditInsert).toBeDefined();
    expect(auditInsert!.params).toContain('payments.create');
    expect(auditInsert!.params).toContain(15);
  });

  it('captures a before snapshot for payments.update', async () => {
    const database = createDatabase({
      paymentOrderId: 15,
    });
    const repository = new PgPaymentRepository(database.service);

    await repository.updatePayment({
      currentUser: currentUser(),
      requestId: 'req_pu',
      paymentId: 30,
      dto: { amount: 200 },
    });

    const audit = database.queries.find(
      (c) => /INSERT INTO audit_log/i.test(c.text) && JSON.stringify(c.params).includes('payments.update'),
    );
    expect(audit).toBeDefined();
    // params[19] is before_json — a JSON-stringified snapshot of the prior row
    const beforeJson = audit!.params[19] as string;
    expect(beforeJson).toBeDefined();
    expect(beforeJson).not.toBeNull();
    const before = JSON.parse(beforeJson);
    expect(before).toHaveProperty('amount'); // before snapshot carries prior payment fields
  });

  it('denied scope: writes one denied audit row with relatedOrderId to the pool (not tx)', async () => {
    const database = createDatabase({
      orderCreatedByUserId: 1,
      orderManagerUserId: null,
    });
    const repository = new PgPaymentRepository(database.service);

    await expect(
      repository.updatePayment({
        currentUser: currentUser('manager', '99'),
        paymentId: 30,
        dto: { amount: 400 },
        requestId: 'req-denied-pool',
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });

    // The denied audit row must be written to the pool (database.poolQueries), not tx
    const deniedRow = database.poolQueries.find(
      (q) => /INSERT INTO audit_log/i.test(q.text) && /related_payment_id/i.test(q.text),
    );
    expect(deniedRow).toBeDefined();
    // relatedOrderId is param index 9 (0-based) == $9 in the INSERT
    expect(deniedRow!.params[8]).toBe(15); // relatedOrderId = order 15
    // event name
    expect(deniedRow!.params[0]).toBe('payment.permission_denied');
    // status_code carries reason
    expect(deniedRow!.params[17]).toBe('order_scope_denied');
  });

  it('permitted path writes zero denied audit rows', async () => {
    const database = createDatabase({
      orderCreatedByUserId: 1,
      orderManagerUserId: null,
    });
    const repository = new PgPaymentRepository(database.service);

    // admin is always permitted
    await repository.updatePayment({
      currentUser: currentUser('admin', '1'),
      paymentId: 30,
      dto: { amount: 400 },
      requestId: 'req-permitted',
    });

    const deniedRows = database.poolQueries.filter(
      (q) => /INSERT INTO audit_log/i.test(q.text) && /payment\.permission_denied/i.test(JSON.stringify(q.params)),
    );
    expect(deniedRows).toHaveLength(0);
  });

  it('audit-sink throw still yields PERMISSION_DENIED (best-effort containment)', async () => {
    const database = createDatabase({
      orderCreatedByUserId: 1,
      orderManagerUserId: null,
    });
    const repository = new PgPaymentRepository(database.service);

    // Stub recordDenied to reject; the 403 must still be thrown
    const stub = vi.spyOn(auditService, 'recordDenied').mockRejectedValueOnce(new Error('audit sink down'));
    try {
      await expect(
        repository.updatePayment({
          currentUser: currentUser('manager', '99'),
          paymentId: 30,
          dto: { amount: 400 },
          requestId: 'req-sink-fail',
        }),
      ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    } finally {
      stub.mockRestore();
    }
  });

  it('deletes a payment and recalculates the parent order', async () => {
    const database = createDatabase({
      paymentOrderId: 15,
      orderTotals: { 15: { paidAmount: 0, paymentDate: null } },
    });
    const repository = new PgPaymentRepository(database.service);

    const result = await repository.deletePayment({
      currentUser: currentUser(),
      paymentId: 30,
      requestId: 'request-3',
    });

    expect(result).toMatchObject({
      paymentId: 30,
      deleted: true,
      order: {
        orderId: 15,
        paidAmount: 0,
        debtAmount: 1000,
        paymentStatusId: 1,
      },
    });
    expect(normalizedSql(database.queries)).toContain('DELETE FROM payments WHERE payment_id = $1');

    const auditInsert = database.queries.find(
      (q) => /INSERT INTO audit_log/i.test(q.text) && /related_payment_id/i.test(q.text),
    );
    expect(auditInsert).toBeDefined();
    expect(auditInsert!.params[0]).toBe('payments.delete');
    expect(auditInsert!.params[1]).toBe('payment');
    expect(auditInsert!.params[10]).toBe(30);
  });
});

function createDatabase(options: {
  paymentOrderId?: number;
  orderCreatedByUserId?: number;
  orderManagerUserId?: number | null;
  orderTotals?: Record<number, { paidAmount: number; paymentDate: string | null }>;
} = {}) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  // Pool-level queries (used by denied audit path — must survive tx rollback)
  const poolQueries: Array<{ text: string; params: readonly unknown[] }> = [];

  async function handleQuery(text: string, params: readonly unknown[] = [], store: Array<{ text: string; params: readonly unknown[] }>) {
    store.push({ text, params });
    const normalized = normalizeSql(text);

    if (normalized.startsWith('SELECT payment_id, order_id, type_paid_id, amount, payment_date')) {
      return {
        rows: [paymentRow({ order_id: options.paymentOrderId ?? 15 })],
        rowCount: 1,
      };
    }

    if (normalized.startsWith('SELECT order_id, final_amount')) {
      const orderIds = params[0] as number[];
      return {
        rows: orderIds.map((orderId) => ({
          order_id: orderId,
          final_amount: 1000,
          payment_status_id: 1,
          version: 3,
          created_by: options.orderCreatedByUserId ?? 1,
          manager_id: options.orderManagerUserId ?? null,
        })),
        rowCount: orderIds.length,
      };
    }

    if (normalized.startsWith('INSERT INTO payments')) {
      return { rows: [paymentRow({ order_id: params[0], amount: params[1] })], rowCount: 1 };
    }

    if (normalized.startsWith('UPDATE payments')) {
      const orderId = params.includes(16) ? 16 : options.paymentOrderId ?? 15;
      const amount = params.includes(400) ? 400 : 250;
      return { rows: [paymentRow({ order_id: orderId, amount })], rowCount: 1 };
    }

    if (normalized.startsWith('SELECT COALESCE(SUM(amount), 0)')) {
      const orderId = params[0] as number;
      const totals = options.orderTotals?.[orderId] ?? {
        paidAmount: 250,
        paymentDate: '2026-05-01',
      };
      return {
        rows: [{ paid_amount: totals.paidAmount, payment_date: totals.paymentDate }],
        rowCount: 1,
      };
    }

    // INSERT INTO audit_log returns an audit_id
    if (normalized.startsWith('INSERT INTO audit_log')) {
      return { rows: [{ audit_id: 'mock-audit-id' }], rowCount: 1 };
    }

    return { rows: [], rowCount: 1 };
  }

  const tx = {
    async query(text: string, params: readonly unknown[] = []) {
      return handleQuery(text, params, queries);
    },
  };

  const service = {
    // Pool-level query (used by assertPaymentScope denied audit)
    async query(text: string, params: readonly unknown[] = []) {
      return handleQuery(text, params, poolQueries);
    },
    async transaction<T>(handler: (client: typeof tx) => Promise<T>) {
      return handler(tx);
    },
  } as unknown as DatabaseService;

  return {
    queries,
    poolQueries,
    service,
  };
}

function paymentRow(overrides: Record<string, unknown> = {}) {
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

function normalizedSql(queries: Array<{ text: string }>): string {
  return queries.map((query) => normalizeSql(query.text)).join('\n');
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}
