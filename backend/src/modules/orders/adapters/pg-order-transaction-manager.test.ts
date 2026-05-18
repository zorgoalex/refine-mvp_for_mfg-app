import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import { PgOrderTransactionManager } from './pg-order-transaction-manager';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type {
  CalculatedOrderDetailDto,
  NormalizedSaveOrderDowelingLinkDto,
  NormalizedSaveOrderHeaderDto,
  NormalizedSaveOrderPaymentDto,
  NormalizedSaveOrderRequirementDto,
  NormalizedSaveOrderWorkshopDto,
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

  it('persists operational child workflow rows and doweling engineer side effect', async () => {
    const database = createDatabase({ restoredRowCount: 0 });
    const manager = new PgOrderTransactionManager(database.service);

    await manager.runInTransaction(async (uow) => {
      await uow.upsertWorkshops(100, [
        workshop({ id: 31, workshopId: 7, productionStatusId: 8 }),
        workshop({ workshopId: 9, productionStatusId: 10, notes: 'new workshop' }),
      ]);
      await uow.deleteWorkshops(100, [32]);
      await uow.upsertRequirements(100, [
        requirement({ id: 41, resourceType: 'material', materialId: 4 }),
        requirement({ resourceType: 'film', filmId: 5, requiredQuantity: 2 }),
      ]);
      await uow.deleteRequirements(100, [42]);
      await uow.upsertDowelingLinks(100, [
        dowelingLink({ id: 51, dowelingOrderId: 44, designEngineerId: 7 }),
        dowelingLink({ dowelingOrderId: 45, refKey1c: 'new-link' }),
      ]);
      await uow.deleteDowelingLinks(100, [52]);
    });

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).toContain('UPDATE order_workshops SET workshop_id = $3');
    expect(sql).toContain('INSERT INTO order_workshops');
    expect(sql).toContain('DELETE FROM order_workshops');
    expect(sql).toContain('UPDATE order_resource_requirements SET resource_type = $3');
    expect(sql).toContain('INSERT INTO order_resource_requirements');
    expect(sql).toContain('DELETE FROM order_resource_requirements');
    expect(sql).toContain('UPDATE order_doweling_links SET doweling_order_id = $3');
    expect(sql).toContain('INSERT INTO order_doweling_links');
    expect(sql).toContain('UPDATE doweling_orders SET design_engineer_id = $2');
    expect(sql).toContain('DELETE FROM order_doweling_links');
    expect(database.queries.some((query) => query.params.includes('new workshop'))).toBe(true);
    expect(database.queries.some((query) => query.params.includes('new-link'))).toBe(true);
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

  it('soft-deletes orders with idempotency, queryable audit, outbox and completion', async () => {
    const database = createDatabase();
    const manager = new PgOrderTransactionManager(database.service);

    await manager.runInTransaction(async (uow) => {
      await uow.setSessionUser('42');
      await expect(
        uow.reconcileOrderDeleteIdempotency({
          currentUser: currentUser(),
          orderId: 100,
          version: 2,
          idempotencyKey: 'order-delete-key-1',
          requestId: 'request-delete-1',
        }),
      ).resolves.toEqual({});
      const lockedOrder = await uow.loadOrderForDelete(100);
      expect(lockedOrder).toMatchObject({
        orderId: 100,
        orderName: 'A-100',
        clientId: 5,
        version: 2,
      });
      const nextVersion = await uow.softDeleteOrder({ orderId: 100, previousVersion: 2 });
      expect(nextVersion).toBe(3);
      const auditId = await uow.writeOrderDeleteAudit({
        currentUser: currentUser(),
        requestId: 'request-delete-1',
        order: lockedOrder!,
        nextVersion,
      });
      await uow.enqueueOrderDeleteOutbox({
        currentUser: currentUser(),
        requestId: 'request-delete-1',
        order: lockedOrder!,
        nextVersion,
        auditId,
        idempotencyKey: 'order-delete-key-1',
      });
      await uow.completeOrderDeleteIdempotency('order-delete-key-1', {
        success: true,
        orderId: 100,
        auditId,
        requestId: 'request-delete-1',
      });
    });

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    const allParams = JSON.stringify(database.queries.map((query) => query.params));
    expect(sql).toContain('INSERT INTO command_idempotency_keys');
    expect(sql).toContain('SELECT order_id, order_name, client_id, version, created_by, manager_id FROM orders');
    expect(sql).toContain('UPDATE orders SET delete_flag = true, version = $2');
    expect(sql).toContain('INSERT INTO audit_log');
    expect(sql).toContain('related_order_id, related_client_id');
    expect(sql).toContain('INSERT INTO outbox_events');
    expect(sql).toContain('UPDATE command_idempotency_keys SET status =');
    const outboxPayload = JSON.parse(
      database.queries.find((query) => query.params[0] === 'order.deleted')?.params[2] as string,
    );
    expect(allParams).toContain('orders.delete');
    expect(allParams).toContain('order.deleted');
    expect(allParams).toContain('request-delete-1');
    expect(allParams).toContain('order-delete-key-1:order.deleted');
    expect(outboxPayload.idempotencyKey).toBe('order-delete-key-1');
    expect(outboxPayload.outboxIdempotencyKey).toBe('order-delete-key-1:order.deleted');
    expect(outboxPayload.actorUserId).toBe('42');
    expect(outboxPayload.requestId).toBe('request-delete-1');
    expect(outboxPayload.previousVersion).toBe(2);
    expect(outboxPayload.version).toBe(3);
    expect(allParams).toContain('previousVersion');
    expect(allParams).toContain('actorUserId');
  });

  it('rejects reused order delete idempotency keys before loading the order', async () => {
    const database = createDatabase({ idempotencyHashMismatch: true });
    const manager = new PgOrderTransactionManager(database.service);

    await expect(
      manager.runInTransaction((uow) =>
        uow.reconcileOrderDeleteIdempotency({
          currentUser: currentUser(),
          orderId: 100,
          version: 2,
          idempotencyKey: 'order-delete-key-1',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      statusCode: 409,
    });

    expect(normalizedSql(database.queries)).not.toContain('FROM orders WHERE order_id');
  });
});

function createDatabase(
  options: {
    childCount?: number;
    idempotencyHashMismatch?: boolean;
    restoredRowCount?: number;
  } = {},
) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  let lastRequestHash: unknown = 'hash';
  const tx = {
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });
      const normalized = normalizeSql(text);

      if (normalized.startsWith('INSERT INTO command_idempotency_keys')) {
        lastRequestHash = params[3];
        return options.idempotencyHashMismatch
          ? { rows: [], rowCount: 0 }
          : {
              rows: [
                {
                  idempotency_key: params[0],
                  request_hash: params[3],
                  response_json: null,
                  status: 'processing',
                },
              ],
              rowCount: 1,
            };
      }

      if (normalized.startsWith('SELECT idempotency_key, request_hash')) {
        return {
          rows: [
            {
              idempotency_key: params[0],
              request_hash: options.idempotencyHashMismatch ? 'different-hash' : lastRequestHash,
              response_json: null,
              status: 'completed',
            },
          ],
          rowCount: 1,
        };
      }

      if (text.includes('SELECT order_id, version')) {
        return { rows: [{ order_id: 100, version: 2 }], rowCount: 1 };
      }

      if (normalized.startsWith('SELECT order_id, order_name')) {
        return {
          rows: [
            {
              order_id: 100,
              order_name: 'A-100',
              client_id: 5,
              version: 2,
              created_by: 42,
              manager_id: 42,
            },
          ],
          rowCount: 1,
        };
      }

      if (text.includes('COUNT(*)::int AS count')) {
        return { rows: [{ count: options.childCount ?? 1 }], rowCount: 1 };
      }

      if (text.includes('RETURNING order_id')) {
        return { rows: [{ order_id: 100 }], rowCount: 1 };
      }

      if (normalized.startsWith('UPDATE orders SET delete_flag')) {
        return { rows: [{ version: params[1] }], rowCount: 1 };
      }

      if (normalized.startsWith('INSERT INTO audit_log')) {
        return { rows: [{ audit_id: 'audit-delete-1' }], rowCount: 1 };
      }

      if (normalized.startsWith('UPDATE order_workshops SET delete_flag = false')) {
        return { rows: [], rowCount: options.restoredRowCount ?? 1 };
      }

      if (normalized.startsWith('UPDATE order_doweling_links SET delete_flag = false')) {
        return { rows: [], rowCount: options.restoredRowCount ?? 1 };
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

function normalizedSql(databaseQueries: Array<{ text: string }>): string {
  return databaseQueries.map((query) => normalizeSql(query.text)).join('\n');
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

function workshop(
  overrides: Partial<NormalizedSaveOrderWorkshopDto> = {},
): NormalizedSaveOrderWorkshopDto {
  return {
    id: overrides.id,
    clientKey: overrides.clientKey,
    workshopId: overrides.workshopId ?? 7,
    productionStatusId: overrides.productionStatusId ?? 8,
    receivedDate: overrides.receivedDate ?? null,
    startedDate: overrides.startedDate ?? null,
    completedDate: overrides.completedDate ?? null,
    plannedCompletionDate: overrides.plannedCompletionDate ?? null,
    sequenceOrder: overrides.sequenceOrder ?? null,
    responsibleEmployeeId: overrides.responsibleEmployeeId ?? null,
    notes: overrides.notes ?? null,
    refKey1c: overrides.refKey1c ?? null,
  };
}

function requirement(
  overrides: Partial<NormalizedSaveOrderRequirementDto> = {},
): NormalizedSaveOrderRequirementDto {
  return {
    id: overrides.id,
    clientKey: overrides.clientKey,
    resourceType: overrides.resourceType ?? 'material',
    materialId: overrides.materialId ?? null,
    filmId: overrides.filmId ?? null,
    edgeTypeId: overrides.edgeTypeId ?? null,
    requiredQuantity: overrides.requiredQuantity ?? 1,
    unitId: overrides.unitId ?? 1,
    wastePercentage: overrides.wastePercentage ?? null,
    finalQuantity: overrides.finalQuantity ?? null,
    requirementStatusId: overrides.requirementStatusId ?? 2,
    supplierId: overrides.supplierId ?? null,
    purchasePrice: overrides.purchasePrice ?? null,
    requisitionId: overrides.requisitionId ?? null,
    warehouseId: overrides.warehouseId ?? null,
    reservedAt: overrides.reservedAt ?? null,
    consumedAt: overrides.consumedAt ?? null,
    notes: overrides.notes ?? null,
    calculationDetails: overrides.calculationDetails ?? null,
    refKey1c: overrides.refKey1c ?? null,
  };
}

function dowelingLink(
  overrides: Partial<NormalizedSaveOrderDowelingLinkDto> = {},
): NormalizedSaveOrderDowelingLinkDto {
  return {
    id: overrides.id,
    clientKey: overrides.clientKey,
    dowelingOrderId: overrides.dowelingOrderId ?? 44,
    designEngineerId: overrides.designEngineerId ?? null,
    refKey1c: overrides.refKey1c ?? null,
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
