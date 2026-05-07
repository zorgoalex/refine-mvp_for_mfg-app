import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import { PgOrderTransactionManager } from './pg-order-transaction-manager';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type {
  CalculatedOrderDetailDto,
  NormalizedSaveOrderHeaderDto,
  NormalizedSaveOrderPaymentDto,
  OrderTotalsDto,
} from '../dto/save-order.dto';

describe('PgOrderTransactionManager', () => {
  it('runs order writes through the Postgres unit of work', async () => {
    const database = createDatabase();
    const manager = new PgOrderTransactionManager(database.service);

    await manager.runInTransaction(async (uow) => {
      await uow.setSessionUser('42');
      await expect(uow.loadOrderForUpdate(100)).resolves.toEqual({ orderId: 100, version: 2 });
      await uow.assertChildOwnership(100, [{ entityType: 'detail', id: 200 }]);
      const orderId = await uow.createOrderHeader({
        header: header(),
        totals: totals(),
        currentUser: currentUser(),
      });
      await uow.upsertDetails(orderId, [detail()]);
      await uow.upsertPayments(orderId, [payment()]);
      await uow.deleteDetails(orderId, [200]);
      await expect(
        uow.updateOrderTotalsAndVersion({
          orderId,
          totals: totals(),
          previousVersion: 2,
          currentUser: currentUser(),
        }),
      ).resolves.toBe(3);
      await uow.writeAuditEvent({
        action: 'orders.update',
        orderId,
        actorUserId: '42',
      });
    });

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).toContain('SELECT set_session_user($1)');
    expect(sql).toContain('SELECT order_id, version FROM orders');
    expect(sql).toContain('INSERT INTO orders');
    expect(sql).toContain('INSERT INTO order_details');
    expect(sql).toContain('INSERT INTO payments');
    expect(sql).toContain('DELETE FROM order_details');
    expect(sql).toContain('INSERT INTO audit_log');
  });

  it('rejects child ids from another order before mutation', async () => {
    const database = createDatabase({ childCount: 0 });
    const manager = new PgOrderTransactionManager(database.service);

    await expect(
      manager.runInTransaction((uow) =>
        uow.assertChildOwnership(100, [{ entityType: 'detail', id: 999 }]),
      ),
    ).rejects.toMatchObject({
      code: 'CHILD_ENTITY_NOT_OWNED',
    });
  });

  it('updates discount and final amount in the same header statement', async () => {
    const database = createDatabase();
    const manager = new PgOrderTransactionManager(database.service);
    const discountedHeader = { ...header(), discount: 20 };
    const discountedTotals = { ...totals(), discount: 20, finalAmount: 100, debtAmount: 50 };

    await manager.runInTransaction((uow) =>
      uow.updateOrderHeader({
        orderId: 100,
        header: discountedHeader,
        totals: discountedTotals,
        currentUser: currentUser(),
      }),
    );

    const updateQuery = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('UPDATE orders SET order_name'),
    );

    expect(normalizeSql(updateQuery?.text ?? '')).toContain(
      'discount = $13, surcharge = $14, total_amount = $15, final_amount = $16',
    );
    expect(updateQuery?.params[12]).toBe(20);
    expect(updateQuery?.params[14]).toBe(120);
    expect(updateQuery?.params[15]).toBe(100);
  });
});

function createDatabase(options: { childCount?: number } = {}) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  const tx = {
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });

      if (text.includes('SELECT order_id, version')) {
        return { rows: [{ order_id: 100, version: 2 }], rowCount: 1 };
      }

      if (text.includes('COUNT(*)::int AS count')) {
        return { rows: [{ count: options.childCount ?? 1 }], rowCount: 1 };
      }

      if (text.includes('RETURNING order_id')) {
        return { rows: [{ order_id: 100 }], rowCount: 1 };
      }

      return { rows: [], rowCount: 1 };
    },
  };

  return {
    queries,
    service: {
      async transaction<T>(handler: (client: typeof tx) => Promise<T>) {
        return handler(tx);
      },
    } as unknown as DatabaseService,
  };
}

function header(): NormalizedSaveOrderHeaderDto {
  return {
    orderName: 'A-100',
    clientId: 5,
    orderDate: '2026-05-01',
    priority: 100,
    managerId: 42,
    orderStatusId: 1,
    paymentStatusId: 2,
    productionStatusId: null,
    productionStatusFromDetailsEnabled: false,
    plannedCompletionDate: '2026-05-10',
    completionDate: null,
    issueDate: null,
    paymentDate: null,
    discount: 0,
    surcharge: 0,
    linkCuttingFile: null,
    linkCuttingImageFile: null,
    linkCadFile: null,
    linkPdfFile: null,
    notes: null,
    refKey1c: null,
    materialId: null,
    millingTypeId: null,
    edgeTypeId: null,
    filmId: null,
  };
}

function totals(): OrderTotalsDto {
  return {
    positionsCount: 1,
    partsCount: 2,
    totalArea: 1,
    totalAmount: 120,
    discount: 0,
    surcharge: 0,
    finalAmount: 120,
    paidAmount: 50,
    debtAmount: 70,
    paymentDate: '2026-05-01',
    paymentStatusId: 2,
  };
}

function detail(): CalculatedOrderDetailDto {
  return {
    clientKey: 'tmp-1',
    detailNumber: 1,
    detailName: 'Side',
    height: 1000,
    width: 500,
    quantity: 2,
    area: 1,
    materialId: 10,
    millingTypeId: 1,
    edgeTypeId: 1,
    filmId: null,
    millingCostPerSqm: null,
    detailCost: 120,
    priority: 100,
    productionStatusId: null,
    jointOrderId: null,
    note: null,
    linkCuttingFile: null,
    linkCuttingImageFile: null,
    linkCadFile: null,
    linkPdfFile: null,
    refKey1c: null,
  };
}

function payment(): NormalizedSaveOrderPaymentDto {
  return {
    clientKey: 'tmp-pay-1',
    typePaidId: 1,
    amount: 50,
    paymentDate: '2026-05-01',
    notes: null,
    refKey1c: null,
  };
}

function currentUser(): CurrentUser {
  return {
    id: '42',
    username: 'manager',
    role: 'manager',
    roleId: 10,
    permissions: getPermissionsForRole('manager'),
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}
