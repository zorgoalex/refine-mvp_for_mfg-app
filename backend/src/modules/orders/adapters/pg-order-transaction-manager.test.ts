import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import { PgOrderTransactionManager } from './pg-order-transaction-manager';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import {
  ProjectArchivedError,
  ProjectClientMismatchError,
  ProjectNotFoundError,
} from '../../projects/errors/projects.errors';
import type {
  CalculatedOrderDetailDto,
  NormalizedSaveOrderDowelingLinkDto,
  NormalizedSaveOrderHeaderDto,
  NormalizedSaveOrderPaymentDto,
  NormalizedSaveOrderRequirementDto,
  NormalizedSaveOrderWorkshopDto,
  OrderTotalsDto,
  SaveOrderDto,
} from '../dto/save-order.dto';

describe('PgOrderTransactionManager', () => {
  it('lockOrderName takes the advisory lock on the normalized name (first, no data reads)', async () => {
    const database = createDatabase();
    const manager = new PgOrderTransactionManager(database.service);

    await manager.runInTransaction(async (uow) => {
      await uow.lockOrderName('  2558 ');
    });

    const lockQuery = database.queries.find((query) => query.text.includes('pg_advisory_xact_lock'));
    expect(lockQuery).toBeDefined();
    expect(lockQuery?.params?.[0]).toBe('2558');
  });

  it('assertOrderNameAvailable passes when no live duplicate exists', async () => {
    const database = createDatabase({ duplicateNameRow: null });
    const manager = new PgOrderTransactionManager(database.service);

    await manager.runInTransaction(async (uow) => {
      await expect(uow.assertOrderNameAvailable({ orderName: '2558' })).resolves.toBeUndefined();
    });

    const dupQuery = database.queries.find((query) => normalizeSql(query.text).includes('lower(trim(order_name))'));
    expect(normalizeSql(dupQuery?.text ?? '')).toContain('delete_flag = false');
    expect(dupQuery?.params).toEqual(['2558', null]);
  });

  it('assertOrderNameAvailable excludes the order being renamed and throws 409 with the suggestion', async () => {
    const database = createDatabase({
      duplicateNameRow: { order_id: 77, order_name: '2558' },
      suggestedNextName: '2600',
    });
    const manager = new PgOrderTransactionManager(database.service);

    await expect(
      manager.runInTransaction(async (uow) => {
        await uow.assertOrderNameAvailable({ orderName: ' 2558 ', excludeOrderId: 42 });
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'ORDER_NAME_DUPLICATE',
      details: { existingOrderId: 77, orderName: '2558', suggestedOrderName: '2600' },
    });

    const dupQuery = database.queries.find((query) => normalizeSql(query.text).includes('lower(trim(order_name))'));
    expect(dupQuery?.params).toEqual(['2558', 42]);
    // Предложение считается по ЧИСЛОВЫМ именам с защитой от bigint-переполнения
    // и ТОЛЬКО по продакшн-эпохе (order_date >= 2025-12-01): легаси-имена вида
    // 230725 (даты до go-live) не должны задирать следующий номер серии.
    const suggestQuery = database.queries.find((query) => normalizeSql(query.text).includes('AS next'));
    expect(suggestQuery?.text).toContain("^\\d{1,15}$");
    expect(suggestQuery?.text).toContain("2025-12-01");
  });

  it('runs order writes through the Postgres unit of work', async () => {
    const database = createDatabase();
    const manager = new PgOrderTransactionManager(database.service);

    await manager.runInTransaction(async (uow) => {
      await uow.setSessionUser('42');
      await expect(uow.loadOrderForUpdate(100)).resolves.toEqual({
        orderId: 100,
      orderName: 'A-100',
        version: 2,
        createdByUserId: '42',
        managerUserId: '42',
      });
      await uow.assertChildOwnership(100, [{ entityType: 'detail', id: 200 }]);
      const orderId = await uow.createOrderHeader({
        header: header(),
        totals: totals(),
        projectId: 501,
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
    expect(sql).toContain('SELECT order_id, order_name, version, created_by, manager_id FROM orders');
    expect(sql).toContain('INSERT INTO orders');
    expect(sql).toContain('project_id');
    expect(sql).toContain('INSERT INTO order_details');
    const detailInsert = database.queries.find((query) => normalizeSql(query.text).startsWith('INSERT INTO order_details'));
    // Column tail: ..., basis_product, doweling (migration 063).
    expect(detailInsert?.params.at(-2)).toBe('Прихожка');
    expect(detailInsert?.params.at(-1)).toBe(false);
    expect(sql).toContain('INSERT INTO payments');
    expect(sql).toContain('DELETE FROM order_details');
    expect(sql).toContain('INSERT INTO audit_log');
  });

  it('exposes the same transaction client through getTransactionClient()', async () => {
    const database = createDatabase();
    const manager = new PgOrderTransactionManager(database.service);

    await manager.runInTransaction(async (uow) => {
      expect(uow.getTransactionClient()).toBe(database.tx);
    });
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
        requirement({ id: 41, resourceType: 'material', materialId: 4, finalQuantity: 1.25 }),
        requirement({ resourceType: 'film', filmId: 5, requiredQuantity: 2, finalQuantity: 2.5 }),
      ]);
      await uow.deleteRequirements(100, [42]);
      await uow.upsertDowelingLinks(100, [
        dowelingLink({ id: 51, dowelingOrderId: 44, designEngineerId: 7 }),
        dowelingLink({ dowelingOrderId: 45, designEngineerId: null, refKey1c: 'new-link' }),
      ]);
      await uow.deleteDowelingLinks(100, [52]);
    });

    const sql = database.queries.map((query) => normalizeSql(query.text)).join('\n');
    expect(sql).toContain('UPDATE order_workshops SET workshop_id = $3');
    expect(sql).toContain('ref_key_1c = $12, delete_flag = false');
    expectScopedUpdate(database.queries, {
      startsWith: 'UPDATE order_workshops SET workshop_id = $3',
      whereClause: 'WHERE order_workshop_id = $1 AND order_id = $2',
      params: [31, 100],
    });
    expect(sql).toContain('INSERT INTO order_workshops');
    expect(sql).toContain('UPDATE order_workshops SET delete_flag = true');
    expectScopedUpdate(database.queries, {
      startsWith: 'UPDATE order_workshops SET delete_flag = true',
      whereClause: 'WHERE order_workshop_id = ANY($1::bigint[]) AND order_id = $2',
      params: [[32], 100],
    });
    expect(sql).not.toContain('DELETE FROM order_workshops');
    expect(sql).toContain('UPDATE order_resource_requirements SET resource_type = $3');
    expect(sql).toContain('waste_percentage = $9, final_quantity = $10');
    expect(sql).toContain('requirement_status_id = $11');
    expect(sql).toContain('INSERT INTO order_resource_requirements');
    expect(sql).toContain(
      'unit_id, waste_percentage, final_quantity, requirement_status_id, supplier_id',
    );
    expect(sql).toContain('$7, $8, $9, $10, $11');
    expect(sql).toContain('UPDATE order_resource_requirements SET is_active = false');
    expectScopedUpdate(database.queries, {
      startsWith: 'UPDATE order_resource_requirements SET resource_type = $3',
      whereClause: 'WHERE requirement_id = $1 AND order_id = $2',
      params: [41, 100],
    });
    expectScopedUpdate(database.queries, {
      startsWith: 'UPDATE order_resource_requirements SET is_active = false',
      whereClause: 'WHERE requirement_id = ANY($1::bigint[]) AND order_id = $2',
      params: [[42], 100],
    });
    const requirementUpdate = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('UPDATE order_resource_requirements SET resource_type'),
    );
    const requirementInsert = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO order_resource_requirements'),
    );
    expect(requirementUpdate?.params[9]).toBe(1.25);
    expect(requirementInsert?.params[8]).toBe(2.5);
    expect(sql).not.toContain('DELETE FROM order_resource_requirements');
    expect(sql).toContain('UPDATE order_doweling_links SET doweling_order_id = $3');
    expect(sql).toContain('ref_key_1c = $4, delete_flag = false');
    expectScopedUpdate(database.queries, {
      startsWith: 'UPDATE order_doweling_links SET doweling_order_id = $3',
      whereClause: 'WHERE order_doweling_link_id = $1 AND order_id = $2',
      params: [51, 100],
    });
    expect(sql).toContain('INSERT INTO order_doweling_links');
    expect(sql).toContain('UPDATE doweling_orders d SET design_engineer_id = $3');
    expect(sql).toContain('d.delete_flag = false');
    expect(sql).toContain('odl.order_id = $1');
    expect(sql).toContain('odl.doweling_order_id = d.doweling_order_id');
    expect(sql).toContain('odl.delete_flag = false');
    expect(sql).toContain('UPDATE order_doweling_links SET delete_flag = true');
    expectScopedUpdate(database.queries, {
      startsWith: 'UPDATE order_doweling_links SET delete_flag = true',
      whereClause: 'WHERE order_doweling_link_id = ANY($1::bigint[]) AND order_id = $2',
      params: [[52], 100],
    });
    expect(sql).not.toContain('DELETE FROM order_doweling_links');
    expect(
      database.queries.some(
        (query) =>
          normalizeSql(query.text).startsWith('UPDATE doweling_orders d SET design_engineer_id') &&
          query.params[0] === 100 &&
          query.params[1] === 45 &&
          query.params[2] === null,
      ),
    ).toBe(true);
    expect(database.queries.some((query) => query.params.includes('new workshop'))).toBe(true);
    expect(database.queries.some((query) => query.params.includes('new-link'))).toBe(true);
  });

  it('does not update doweling engineer when designEngineerId is omitted', async () => {
    const database = createDatabase();
    const manager = new PgOrderTransactionManager(database.service);
    const linkWithoutEngineer: NormalizedSaveOrderDowelingLinkDto = {
      dowelingOrderId: 46,
      refKey1c: 'omitted-engineer',
    };

    await manager.runInTransaction((uow) => uow.upsertDowelingLinks(100, [linkWithoutEngineer]));

    expect(
      database.queries.some((query) =>
        normalizeSql(query.text).startsWith('UPDATE doweling_orders d SET design_engineer_id'),
      ),
    ).toBe(false);
  });

  it('rejects doweling engineer updates when the active order link is missing', async () => {
    const database = createDatabase({ dowelingEngineerRowCount: 0 });
    const manager = new PgOrderTransactionManager(database.service);

    await expect(
      manager.runInTransaction((uow) =>
        uow.upsertDowelingLinks(100, [dowelingLink({ dowelingOrderId: 46, designEngineerId: 9 })]),
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'DOWELING_ORDER_NOT_LINKED',
    });
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

    // After removing the flag from UPDATE, discount shifts from $13 to $12
    expect(normalizeSql(updateQuery?.text ?? '')).toContain(
      'discount = $12, surcharge = $13, total_amount = $14, final_amount = $15',
    );
    expect(updateQuery?.params[11]).toBe(20);  // discount at bind index 11 ($12)
    expect(updateQuery?.params[13]).toBe(120); // totalAmount at bind index 13 ($14)
    expect(updateQuery?.params[14]).toBe(100); // finalAmount at bind index 14 ($15)
  });

  it('updateOrderHeader does not include production_status_from_details_enabled in UPDATE SQL', async () => {
    const database = createDatabase();
    const manager = new PgOrderTransactionManager(database.service);
    // Pass productionStatusFromDetailsEnabled: false — must NOT appear in the UPDATE params or SQL
    const headerWithFlagFalse = { ...header(), productionStatusFromDetailsEnabled: false };

    await manager.runInTransaction((uow) =>
      uow.updateOrderHeader({
        orderId: 100,
        header: headerWithFlagFalse,
        totals: totals(),
        currentUser: currentUser(),
      }),
    );

    const updateQuery = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('UPDATE orders SET order_name'),
    );

    expect(updateQuery).toBeDefined();
    // Flag must NOT appear in the SQL
    expect(normalizeSql(updateQuery!.text)).not.toContain('production_status_from_details_enabled');
    // Params: $1=orderId + 25 SET fields = 26 total; highest placeholder is $26
    // (SP3 added sheet_material_type_id = $26).
    expect(updateQuery!.params).toHaveLength(26);
    expect(normalizeSql(updateQuery!.text)).toContain('ref_key_1c = $25');
    expect(normalizeSql(updateQuery!.text)).toContain('sheet_material_type_id = $26');
    // Flag value (false) must not appear in bind params (boolean false could be ambiguous, check no flag column)
  });

  it('createOrderHeader INSERT still includes production_status_from_details_enabled', async () => {
    const database = createDatabase();
    const manager = new PgOrderTransactionManager(database.service);
    const headerWithFlag = { ...header(), productionStatusFromDetailsEnabled: true };

    await manager.runInTransaction((uow) =>
      uow.createOrderHeader({
        header: headerWithFlag,
        totals: totals(),
        projectId: 501,
        currentUser: currentUser(),
      }),
    );

    const insertQuery = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO orders'),
    );

    expect(insertQuery).toBeDefined();
    expect(normalizeSql(insertQuery!.text)).toContain('production_status_from_details_enabled');
    expect(normalizeSql(insertQuery!.text)).toContain('project_id');
    // Flag is at $9 in the INSERT, bind index 8
    expect(insertQuery!.params[8]).toBe(true);
  });

  it('auto-creates a project root when create-order omits projectId', async () => {
    const database = createDatabase();
    const manager = new PgOrderTransactionManager(database.service);

    await manager.runInTransaction(async (uow) => {
      await expect(
        uow.resolveProjectForCreate({
          projectId: null,
          clientId: 5,
          orderName: 'Тестовый заказ',
          currentUser: currentUser(),
          requestId: 'req-project-auto-1',
        }),
      ).resolves.toEqual({
        projectId: 501,
        created: true,
        code: 'МП-501',
      });
    });

    const sql = normalizedSql(database.queries);
    const projectInsert = database.queries.find((query) =>
      normalizeSql(query.text).includes('INSERT INTO projects'),
    );
    expect(projectInsert).toBeDefined();
    expect(projectInsert?.params[0]).toBe('Тестовый заказ');
    expect(sql).toContain('INSERT INTO projects');
    expect(sql).toContain('INSERT INTO audit_log');
    expect(sql).toContain('INSERT INTO outbox_events');
    expect(sql).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
    const outboxQuery = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('INSERT INTO outbox_events'),
    );
    expect(outboxQuery?.params[0]).toBe('project.created');
  });

  it('validates an explicit project on create-order and surfaces not found/archived/client mismatch', async () => {
    const managerNotFound = new PgOrderTransactionManager(createDatabase({ projectRow: null }).service);
    await expect(
      managerNotFound.runInTransaction((uow) =>
        uow.resolveProjectForCreate({
          projectId: 77,
          clientId: 5,
          orderName: 'Order 77',
          currentUser: currentUser(),
          requestId: 'req-project-77',
        }),
      ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    const managerArchived = new PgOrderTransactionManager(
      createDatabase({
        projectRow: { project_id: 78, client_id: 5, delete_flag: true, code: 'МП-78' },
      }).service,
    );
    await expect(
      managerArchived.runInTransaction((uow) =>
        uow.resolveProjectForCreate({
          projectId: 78,
          clientId: 5,
          orderName: 'Order 78',
          currentUser: currentUser(),
          requestId: 'req-project-78',
        }),
      ),
    ).rejects.toBeInstanceOf(ProjectArchivedError);

    const managerMismatch = new PgOrderTransactionManager(
      createDatabase({
        projectRow: { project_id: 79, client_id: 9, delete_flag: false, code: 'МП-79' },
      }).service,
    );
    await expect(
      managerMismatch.runInTransaction((uow) =>
        uow.resolveProjectForCreate({
          projectId: 79,
          clientId: 5,
          orderName: 'Order 79',
          currentUser: currentUser(),
          requestId: 'req-project-79',
        }),
      ),
    ).rejects.toBeInstanceOf(ProjectClientMismatchError);
  });

  it('countOrdersInProject counts soft-deleted orders too (retarget guard vs FK cascade)', async () => {
    const database = createDatabase({ childCount: 3 });
    const manager = new PgOrderTransactionManager(database.service);
    const count = await manager.runInTransaction((uow) => uow.countOrdersInProject(100));
    expect(count).toBe(3);
    const countQuery = database.queries.find((query) =>
      query.text.includes('COUNT(*)::int AS count'),
    );
    expect(countQuery).toBeDefined();
    expect(countQuery?.text).not.toMatch(/delete_flag/);
  });

  it('replays cached create-idempotency responses without inserting orders or projects', async () => {
    const cachedOrder = createStoredOrderResponse();
    const database = createDatabase({
      idempotencyConflict: true,
      existingIdempotencyResponse: cachedOrder,
    });
    const manager = new PgOrderTransactionManager(database.service);

    await manager.runInTransaction(async (uow) => {
      await expect(
        uow.reconcileOrderCreateIdempotency({
          idempotencyKey: 'create-key-1',
          currentUser: currentUser(),
          dto: createSaveOrderDto(),
        }),
      ).resolves.toEqual({ completedResponse: cachedOrder });
    });

    const sql = normalizedSql(database.queries);
    expect(sql).toContain('INSERT INTO command_idempotency_keys');
    expect(sql).toContain('SELECT idempotency_key, request_hash');
    expect(sql).not.toContain('INSERT INTO orders');
    expect(sql).not.toContain('INSERT INTO projects');
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

  it('writes a query-ready orders.create audit row via AuditService', async () => {
    const { queries, service } = createDatabase();
    const manager = new PgOrderTransactionManager(service);
    await manager.runInTransaction(async (uow) => {
      await uow.writeAuditEvent({
        action: 'orders.create',
        orderId: 77,
        actorUserId: '9',
        actorUsername: 'manager1',
        actorRole: 'manager',
        clientId: 555,
        requestId: 'req_oc',
      });
    });
    const audit = queries.find((q) => /INSERT INTO audit_log/i.test(q.text));
    expect(audit).toBeDefined();
    expect(audit!.text).toMatch(/related_order_id/i);
    expect(audit!.text).toMatch(/source/i);
    expect(audit!.params).toContain('orders.create');
    expect(audit!.params).toContain('backend-orders-command');
    expect(audit!.params).toContain(77);
    expect(audit!.params).toContain(555);
  });

  it('writes a non-null diff_json for orders.create audit when before/after snapshots are provided', async () => {
    const { queries, service } = createDatabase();
    const manager = new PgOrderTransactionManager(service);
    const beforeSnap = null;
    const afterSnap = { orderName: 'New Order', clientId: 5 };
    await manager.runInTransaction(async (uow) => {
      await uow.writeAuditEvent({
        action: 'orders.create',
        orderId: 77,
        actorUserId: '9',
        clientId: 5,
        before: beforeSnap,
        after: afterSnap,
      });
    });
    const audit = queries.find((q) => /INSERT INTO audit_log/i.test(q.text));
    expect(audit).toBeDefined();
    // diff_json is param $22 (index 21). It must be a non-null JSON string containing {from,to} pairs
    const diffJsonParam = audit!.params[21] as string | null;
    expect(diffJsonParam).not.toBeNull();
    const diff = JSON.parse(diffJsonParam!);
    // create: before=null → all after keys appear as from:null, to:<value>
    expect(diff.orderName).toEqual({ from: null, to: 'New Order' });
    expect(diff.clientId).toEqual({ from: null, to: 5 });
  });

  it('loadOrderHeaderSnapshot runs the header SELECT and returns camelCase object', async () => {
    const { queries, service } = createDatabase();
    const manager = new PgOrderTransactionManager(service);
    let snapshot: Record<string, unknown> | null = null;
    await manager.runInTransaction(async (uow) => {
      snapshot = await uow.loadOrderHeaderSnapshot(77);
    });
    // The SELECT must have been issued
    const snapshotQuery = queries.find((q) => /order_name AS "orderName"/i.test(q.text));
    expect(snapshotQuery).toBeDefined();
    expect(snapshotQuery!.params).toContain(77);
    // Fake tx returns a stub row — we just check the key shape is camelCase
    expect(snapshot).not.toBeNull();
    expect(snapshot).toHaveProperty('orderName');
    expect(snapshot).toHaveProperty('clientId');
  });

  it('Variant B: sheet detail INSERT persists material_id = NULL, never calls shadow resolver', async () => {
    // TDD RED target: current code resolves shadow and overrides materialId.
    // GREEN target: effective.materialId is forced to null, no shadow queries issued.
    const database = createDatabase();
    const manager = new PgOrderTransactionManager(database.service);
    const sheetDetail: CalculatedOrderDetailDto = {
      clientKey: 'tmp-sheet-1',
      detailNumber: 1,
      detailName: 'Sheet Side',
      height: 1000,
      width: 500,
      quantity: 1,
      area: 0.5,
      materialId: 99, // caller may supply a materialId but Variant B must ignore it → NULL
      sheetMaterialTypeId: 7,
      millingTypeId: null,
      edgeTypeId: null,
      filmId: null,
      millingCostPerSqm: null,
      detailCost: 80,
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

    await manager.runInTransaction((uow) => uow.upsertDetails(100, [sheetDetail]));

    const insertQuery = database.queries.find((q) =>
      normalizeSql(q.text).startsWith('INSERT INTO order_details'),
    );
    expect(insertQuery).toBeDefined();

    // For INSERT the params are: [$1=orderId, $2=detailNumber, $3=detailName, $4=height,
    // $5=width, $6=quantity, $7=area, $8=materialId, ...] → bind index 7 (0-based)
    expect(insertQuery!.params[7]).toBeNull(); // material_id must be NULL

    // Shadow resolver queries (pg_advisory_xact_lock, SELECT from sheet_material_types,
    // SELECT from materials WHERE shadow_of_...) must NOT have been issued.
    const shadowQueries = database.queries.filter(
      (q) =>
        q.text.includes('pg_advisory_xact_lock') ||
        q.text.includes('shadow_of_sheet_material_type_id'),
    );
    expect(shadowQueries).toHaveLength(0);
  });

  it('Variant B: header CREATE and UPDATE persist material_id = NULL unconditionally', async () => {
    // TDD RED target: current code uses sheetMaterialTypeId != null ? null : materialId ?? null
    // so a header with no sheetMaterialTypeId but a materialId would persist the materialId.
    // GREEN target: material_id is always NULL under Variant B.
    const database = createDatabase();
    const manager = new PgOrderTransactionManager(database.service);

    // Header with a non-null materialId but no sheetMaterialTypeId
    const headerWithMaterial: NormalizedSaveOrderHeaderDto = {
      ...header(),
      materialId: 55,         // legacy material reference — must become NULL under Variant B
      sheetMaterialTypeId: undefined, // no sheet override
    };

    // Test CREATE path
    await manager.runInTransaction((uow) =>
      uow.createOrderHeader({
        header: headerWithMaterial,
        totals: totals(),
        currentUser: currentUser(),
      }),
    );

    const insertQuery = database.queries.find((q) =>
      normalizeSql(q.text).startsWith('INSERT INTO orders'),
    );
    expect(insertQuery).toBeDefined();
    // In INSERT, material_id is at bind position $26 (index 25) — after notes at $25
    const insertMaterialIdParam = insertQuery!.params[25];
    expect(insertMaterialIdParam).toBeNull();

    // Test UPDATE path
    database.queries.length = 0;
    await manager.runInTransaction((uow) =>
      uow.updateOrderHeader({
        orderId: 100,
        header: headerWithMaterial,
        totals: totals(),
        currentUser: currentUser(),
      }),
    );
    const updateQuery = database.queries.find((q) =>
      normalizeSql(q.text).startsWith('UPDATE orders SET order_name'),
    );
    expect(updateQuery).toBeDefined();
    // material_id = $21 in UPDATE → bind index 20
    expect(updateQuery!.params[20]).toBeNull();
  });

  it('orderDeleteDiffJson uses {from,to} shape (not {before,after})', async () => {
    const { queries, service } = createDatabase();
    const manager = new PgOrderTransactionManager(service);
    await manager.runInTransaction(async (uow) => {
      const lockedOrder = await uow.loadOrderForDelete(100);
      const nextVersion = await uow.softDeleteOrder({ orderId: 100, previousVersion: 2 });
      await uow.writeOrderDeleteAudit({
        currentUser: currentUser(),
        requestId: 'req-del-1',
        order: lockedOrder!,
        nextVersion,
      });
    });
    // writeOrderDeleteAudit uses its own INSERT with diff_json at $9 (index 8)
    const audit = queries.find((q) => /INSERT INTO audit_log/i.test(q.text) && q.params.length < 15);
    expect(audit).toBeDefined();
    // $9 = diff_json (index 8 in the delete-specific INSERT)
    const diffJsonParam = audit!.params[8] as string | null;
    expect(diffJsonParam).not.toBeNull();
    const diff = JSON.parse(diffJsonParam!);
    expect(diff.deleteFlag).toEqual({ from: false, to: true });
    expect(diff.version).toEqual({ from: 2, to: 3 });
    // Must NOT use {before,after} keys
    expect(diff.deleteFlag).not.toHaveProperty('before');
    expect(diff.deleteFlag).not.toHaveProperty('after');
  });

  it('softDeleteOrder stamps deleted_at and deleted_by', async () => {
    const database = createDatabase();
    const manager = new PgOrderTransactionManager(database.service);

    await manager.runInTransaction(async (uow) => {
      const nextVersion = await uow.softDeleteOrder({
        orderId: 100,
        previousVersion: 2,
        actorUserId: '42',
      });
      expect(nextVersion).toBe(3);
    });

    const updateQuery = database.queries.find((query) =>
      normalizeSql(query.text).startsWith('UPDATE orders SET delete_flag = true'),
    );
    expect(updateQuery).toBeDefined();
    expect(normalizeSql(updateQuery!.text)).toContain('deleted_at = now()');
    expect(normalizeSql(updateQuery!.text)).toContain('deleted_by = $3');
    expect(updateQuery!.params).toEqual([100, 3, '42']);
  });

  describe('restore path', () => {
    it('loadOrderForRestore locks row without delete_flag filter', async () => {
      const database = createDatabase();
      const manager = new PgOrderTransactionManager(database.service);

      await manager.runInTransaction(async (uow) => {
        await expect(uow.loadOrderForRestore(100)).resolves.toEqual({
          orderId: 100,
          orderName: 'A-100',
          clientId: 5,
          version: 2,
          createdByUserId: '42',
          managerUserId: '42',
          deleteFlag: true,
          deletedAt: '2026-05-02T03:04:05.000Z',
          deletedBy: '42',
        });
      });

      const query = database.queries.find((item) =>
        normalizeSql(item.text).includes('deleted_at, deleted_by'),
      );
      expect(query).toBeDefined();
      expect(normalizeSql(query!.text)).toContain('FOR UPDATE');
      expect(normalizeSql(query!.text)).not.toContain('delete_flag = false');
    });

    it('restoreOrder clears soft-delete state and sets target name', async () => {
      const database = createDatabase();
      const manager = new PgOrderTransactionManager(database.service);

      await manager.runInTransaction(async (uow) => {
        await expect(
          uow.restoreOrder({
            orderId: 100,
            previousVersion: 2,
            targetOrderName: '2561',
            actorUserId: '42',
          }),
        ).resolves.toBe(3);
      });

      const updateQuery = database.queries.find((query) =>
        normalizeSql(query.text).startsWith('UPDATE orders SET delete_flag = false'),
      );
      expect(updateQuery).toBeDefined();
      expect(normalizeSql(updateQuery!.text)).toContain('deleted_at = NULL');
      expect(normalizeSql(updateQuery!.text)).toContain('deleted_by = NULL');
      expect(normalizeSql(updateQuery!.text)).toContain('order_name = $3');
      expect(normalizeSql(updateQuery!.text)).toContain('edited_by = $4');
      expect(updateQuery!.params).toEqual([100, 3, '2561', '42']);
    });

    it('restoreOrder maps unique violations to ORDER_RESTORE_CONFLICT', async () => {
      const database = createDatabase({ restoreOrderErrorCode: '23505' });
      const manager = new PgOrderTransactionManager(database.service);

      await expect(
        manager.runInTransaction((uow) =>
          uow.restoreOrder({
            orderId: 100,
            previousVersion: 2,
            targetOrderName: '2561',
            actorUserId: '42',
          }),
        ),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'ORDER_RESTORE_CONFLICT',
      });
    });

    it('writeOrderRestoreAudit writes orders.restore with before after diff and metadata', async () => {
      const database = createDatabase();
      const manager = new PgOrderTransactionManager(database.service);

      await manager.runInTransaction(async (uow) => {
        const lockedOrder = await uow.loadOrderForRestore(100);
        await expect(
          uow.writeOrderRestoreAudit({
            currentUser: currentUser(),
            requestId: 'request-restore-1',
            order: lockedOrder!,
            targetOrderName: '2561',
            nextVersion: 3,
          }),
        ).resolves.toBe('audit-delete-1');
      });

      const auditQuery = database.queries.find((query) =>
        normalizeSql(query.text).startsWith('INSERT INTO audit_log'),
      );
      expect(auditQuery).toBeDefined();
      expect(auditQuery!.params[0]).toBe('100');
      expect(auditQuery!.text).toContain("'orders.restore'");
      const beforeJson = JSON.parse(String(auditQuery!.params[6]));
      const afterJson = JSON.parse(String(auditQuery!.params[7]));
      const diffJson = JSON.parse(String(auditQuery!.params[8]));
      const metadataJson = JSON.parse(String(auditQuery!.params[9]));
      expect(beforeJson).toMatchObject({
        orderId: 100,
        orderName: 'A-100',
        clientId: 5,
        deleteFlag: true,
        deletedAt: '2026-05-02T03:04:05.000Z',
        deletedBy: '42',
        version: 2,
      });
      expect(afterJson).toMatchObject({
        orderId: 100,
        orderName: '2561',
        clientId: 5,
        deleteFlag: false,
        version: 3,
      });
      expect(diffJson).toMatchObject({
        deleteFlag: { from: true, to: false },
        version: { from: 2, to: 3 },
        orderName: { from: 'A-100', to: '2561' },
      });
      expect(metadataJson).toMatchObject({
        source: 'backend-orders-command',
        commandName: 'orders.restore',
        actorUserId: '42',
        previousVersion: 2,
        version: 3,
      });
    });

    it('enqueueOrderRestoreOutbox uses idempotent key suffix order.restored', async () => {
      const database = createDatabase();
      const manager = new PgOrderTransactionManager(database.service);

      await manager.runInTransaction(async (uow) => {
        const lockedOrder = await uow.loadOrderForRestore(100);
        await uow.enqueueOrderRestoreOutbox({
          currentUser: currentUser(),
          requestId: 'request-restore-1',
          order: lockedOrder!,
          targetOrderName: '2561',
          nextVersion: 3,
          auditId: 'audit-restore-1',
          idempotencyKey: 'order-restore-key-1',
        });
      });

      const outboxQuery = database.queries.find((query) => query.params[0] === 'order.restored');
      expect(outboxQuery).toBeDefined();
      expect(normalizeSql(outboxQuery!.text)).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
      expect(outboxQuery!.params[3]).toBe('order-restore-key-1:order.restored');
      const payload = JSON.parse(String(outboxQuery!.params[2]));
      expect(payload).toMatchObject({
        eventType: 'order.restored',
        idempotencyKey: 'order-restore-key-1',
        outboxIdempotencyKey: 'order-restore-key-1:order.restored',
        orderName: '2561',
        previousOrderName: 'A-100',
        previousVersion: 2,
        version: 3,
      });
    });

    it('reserveOrderRestoreIdempotency inserts processing in its own tx and hashes orderId version and targetName under orders.restore', async () => {
      const first = createDatabase();
      const second = createDatabase();
      const managerA = new PgOrderTransactionManager(first.service);
      const managerB = new PgOrderTransactionManager(second.service);

      await managerA.reserveOrderRestoreIdempotency({
        currentUser: currentUser(),
        orderId: 100,
        version: 2,
        idempotencyKey: 'order-restore-key-1',
        orderName: '2561',
      });
      await managerB.reserveOrderRestoreIdempotency({
        currentUser: currentUser(),
        orderId: 100,
        version: 2,
        idempotencyKey: 'order-restore-key-2',
        orderName: '2562',
      });

      const firstInsert = first.queries.find((query) =>
        normalizeSql(query.text).startsWith('INSERT INTO command_idempotency_keys'),
      );
      const secondInsert = second.queries.find((query) =>
        normalizeSql(query.text).startsWith('INSERT INTO command_idempotency_keys'),
      );
      expect(first.queries[0]?.text).toContain('set_session_user');
      expect(normalizeSql(firstInsert!.text)).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
      expect(firstInsert).toBeDefined();
      expect(secondInsert).toBeDefined();
      expect(firstInsert!.params[3]).not.toBe(secondInsert!.params[3]);
      expect(firstInsert!.params).toContain('100');
      expect(secondInsert!.params).toContain('100');
    });

    it('reserveOrderRestoreIdempotency returns cached response when the key already completed', async () => {
      const database = createDatabase({
        idempotencyConflict: true,
        restoreIdempotencyStatus: 'completed',
        existingRestoreIdempotencyResponse: {
          order: createStoredOrderResponse(),
          auditId: 'audit-restore-1',
          requestId: 'request-restore-1',
        },
      });
      const manager = new PgOrderTransactionManager(database.service);

      await expect(
        manager.reserveOrderRestoreIdempotency({
          currentUser: currentUser(),
          orderId: 100,
          version: 2,
          idempotencyKey: 'order-restore-key-completed',
        }),
      ).resolves.toEqual({
        completedResponse: {
          order: createStoredOrderResponse(),
          auditId: 'audit-restore-1',
          requestId: 'request-restore-1',
        },
      });
    });

    it('reserveOrderRestoreIdempotency surfaces failed status as IDEMPOTENCY_FAILED', async () => {
      const database = createDatabase({ restoreIdempotencyStatus: 'failed', idempotencyConflict: true });
      const manager = new PgOrderTransactionManager(database.service);

      await expect(
        manager.reserveOrderRestoreIdempotency({
          currentUser: currentUser(),
          orderId: 100,
          version: 2,
          idempotencyKey: 'order-restore-key-failed',
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'IDEMPOTENCY_FAILED',
      });
    });

    it('reserveOrderRestoreIdempotency surfaces in-progress status for a live processing row', async () => {
      const database = createDatabase({
        idempotencyConflict: true,
        restoreIdempotencyStatus: 'processing',
        idempotencyCreatedAt: '2099-07-14T23:55:00.000Z',
      });
      const manager = new PgOrderTransactionManager(database.service);

      await expect(
        manager.reserveOrderRestoreIdempotency({
          currentUser: currentUser(),
          orderId: 100,
          version: 2,
          idempotencyKey: 'order-restore-key-processing',
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'IDEMPOTENCY_IN_PROGRESS',
      });
    });

    it('reserveOrderRestoreIdempotency rejects same key with a different request hash', async () => {
      const database = createDatabase({
        idempotencyConflict: true,
        idempotencyHashMismatch: true,
        restoreIdempotencyStatus: 'processing',
      });
      const manager = new PgOrderTransactionManager(database.service);

      await expect(
        manager.reserveOrderRestoreIdempotency({
          currentUser: currentUser(),
          orderId: 100,
          version: 2,
          idempotencyKey: 'order-restore-key-reused',
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    });

    it('reserveOrderRestoreIdempotency marks stale processing as failed and throws retriable 409', async () => {
      const database = createDatabase({
        idempotencyConflict: true,
        restoreIdempotencyStatus: 'processing',
        idempotencyCreatedAt: '2000-01-01T00:00:00.000Z',
      });
      const manager = new PgOrderTransactionManager(database.service);

      await expect(
        manager.reserveOrderRestoreIdempotency({
          currentUser: currentUser(),
          orderId: 100,
          version: 2,
          idempotencyKey: 'order-restore-key-stale',
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'ORDER_RESTORE_IDEMPOTENCY_FAILED',
        message: 'Предыдущее выполнение зависло, повторите с новым ключом',
      });

      const burnQuery = database.queries.find((query) =>
        normalizeSql(query.text).startsWith('UPDATE command_idempotency_keys SET status = \'failed\''),
      );
      expect(burnQuery).toBeDefined();
      expect(normalizeSql(burnQuery!.text)).toContain("WHERE idempotency_key = $1 AND status = 'processing'");
      expect(burnQuery!.params).toEqual(['order-restore-key-stale']);
    });

    it('marks restore idempotency as failed with a guarded update and never inserts', async () => {
      const database = createDatabase();
      const manager = new PgOrderTransactionManager(database.service);

      await manager.markOrderRestoreIdempotencyFailed({
        currentUser: currentUser(),
        orderId: 100,
        version: 2,
        idempotencyKey: 'order-restore-key-burn',
        orderName: '2561',
      });

      const burnQuery = database.queries.find((query) =>
        normalizeSql(query.text).startsWith('UPDATE command_idempotency_keys SET status = \'failed\''),
      );
      expect(burnQuery).toBeDefined();
      expect(normalizeSql(burnQuery!.text)).toContain("WHERE idempotency_key = $1 AND status = 'processing'");
      expect(burnQuery!.params).toEqual(['order-restore-key-burn']);
      expect(
        database.queries.some((query) =>
          normalizeSql(query.text).startsWith('INSERT INTO command_idempotency_keys'),
        ),
      ).toBe(false);
    });
  });

  it('Variant B: sheet order save writes sheet_material_type bridge rows via audit', async () => {
    const { queries, service } = createDatabase();
    const manager = new PgOrderTransactionManager(service);
    await manager.runInTransaction(async (uow) => {
      await uow.writeAuditEvent({
        action: 'orders.create',
        orderId: 77,
        actorUserId: '9',
        actorUsername: 'manager1',
        actorRole: 'manager',
        clientId: 555,
        requestId: 'req_sheet',
        relatedSheetMaterialTypeIds: [3, 7],
      });
    });
    const auditInsert = queries.find((q) => /INSERT INTO audit_log/i.test(q.text));
    expect(auditInsert).toBeDefined();
    // audit_log_related_entity bridge rows must be written for each sheet material type id
    const relatedInserts = queries.filter((q) => /INSERT INTO audit_log_related_entity/i.test(q.text));
    expect(relatedInserts).toHaveLength(2);
    expect(relatedInserts.some((q) => q.params.includes('sheet_material_type') && q.params.includes(3))).toBe(true);
    expect(relatedInserts.some((q) => q.params.includes('sheet_material_type') && q.params.includes(7))).toBe(true);
  });

  it('Variant B: no shadow-material audit rows when sheet order is saved (removed call sites)', async () => {
    // Verify that writeAuditEvent for a sheet order does NOT write any "materials." event
    const { queries, service } = createDatabase();
    const manager = new PgOrderTransactionManager(service);
    await manager.runInTransaction(async (uow) => {
      await uow.writeAuditEvent({
        action: 'orders.create',
        orderId: 77,
        actorUserId: '9',
        relatedSheetMaterialTypeIds: [3],
      });
    });
    const materialAuditEvents = queries.filter(
      (q) => /INSERT INTO audit_log/i.test(q.text) && q.params.some((p) => typeof p === 'string' && p.startsWith('materials.')),
    );
    expect(materialAuditEvents).toHaveLength(0);
  });

  it('Variant B: diff_json carries before/after sheetMaterialTypeId in header', async () => {
    const { queries, service } = createDatabase();
    const manager = new PgOrderTransactionManager(service);
    const before = { orderName: 'A-1', sheetMaterialTypeId: 3, clientId: 5 };
    const after = { orderName: 'A-1', sheetMaterialTypeId: 7, clientId: 5 };
    await manager.runInTransaction(async (uow) => {
      await uow.writeAuditEvent({
        action: 'orders.update',
        orderId: 77,
        actorUserId: '9',
        before,
        after,
        relatedSheetMaterialTypeIds: [3, 7],
      });
    });
    const audit = queries.find((q) => /INSERT INTO audit_log/i.test(q.text));
    expect(audit).toBeDefined();
    const diffParam = audit!.params[21] as string | null;
    expect(diffParam).not.toBeNull();
    const diff = JSON.parse(diffParam!);
    // sheetMaterialTypeId changed from 3 to 7 — must appear in diff
    expect(diff.sheetMaterialTypeId).toEqual({ from: 3, to: 7 });
  });
});

function createDatabase(
  options: {
    childCount?: number;
    dowelingEngineerRowCount?: number;
    existingIdempotencyResponse?: OrderDto;
    existingRestoreIdempotencyResponse?: { order: OrderDto; auditId?: string; requestId: string };
    restoreIdempotencyStatus?: 'completed' | 'failed' | 'processing';
    idempotencyCreatedAt?: string;
    idempotencyConflict?: boolean;
    idempotencyHashMismatch?: boolean;
    projectRow?:
      | {
          project_id: number;
          client_id: number;
          delete_flag: boolean;
          code: string;
        }
      | null;
    restoredRowCount?: number;
    restoreOrderErrorCode?: string;
    duplicateNameRow?: { order_id: number; order_name: string } | null;
    suggestedNextName?: string | null;
  } = {},
) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  let lastRequestHash: unknown = 'hash';
  const tx = {
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });
      const normalized = normalizeSql(text);

      if (normalized.includes('pg_advisory_xact_lock')) {
        return { rows: [], rowCount: 1 };
      }

      if (normalized.includes('lower(trim(order_name))')) {
        const row = options.duplicateNameRow;
        return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }

      if (normalized.includes('AS next')) {
        return { rows: [{ next: options.suggestedNextName ?? null }], rowCount: 1 };
      }

      if (normalized.startsWith('INSERT INTO command_idempotency_keys')) {
        lastRequestHash = params[3];
        return options.idempotencyHashMismatch || options.idempotencyConflict
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
              response_json:
                options.existingIdempotencyResponse ??
                options.existingRestoreIdempotencyResponse ??
                null,
              status: options.restoreIdempotencyStatus ?? 'completed',
              created_at: options.idempotencyCreatedAt ?? '2026-07-14T23:55:00.000Z',
            },
          ],
          rowCount: 1,
        };
      }

      if (normalized.startsWith('SELECT project_id, client_id, delete_flag, code FROM projects')) {
        return {
          rows: options.projectRow === null ? [] : [options.projectRow ?? {
            project_id: 501,
            client_id: 5,
            delete_flag: false,
            code: 'МП-501',
          }],
          rowCount: options.projectRow === null ? 0 : 1,
        };
      }

      if (normalized.startsWith('SELECT order_name AS "orderName"')) {
        return {
          rows: [{
            orderName: 'A-100',
            clientId: 5,
            orderDate: '2026-05-01',
            priority: 100,
            managerId: 42,
            orderStatusId: 1,
            productionStatusId: null,
            plannedCompletionDate: '2026-05-10',
            completionDate: null,
            issueDate: null,
            discount: '0',
            surcharge: '0',
            totalAmount: '120',
            finalAmount: '120',
            linkCuttingFile: null,
            linkCuttingImageFile: null,
            linkCadFile: null,
            linkPdfFile: null,
            notes: null,
            materialId: null,
            millingTypeId: null,
            edgeTypeId: null,
            filmId: null,
            refKey1c: null,
          }],
          rowCount: 1,
        };
      }

      if (text.includes('SELECT order_id, version')) {
        return {
          rows: [{ order_id: 100, version: 2, created_by: 42, manager_id: 42 }],
          rowCount: 1,
        };
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
              delete_flag: true,
              deleted_at: '2026-05-02T03:04:05.000Z',
              deleted_by: 42,
            },
          ],
          rowCount: 1,
        };
      }

      if (text.includes('COUNT(*)::int AS count')) {
        return { rows: [{ count: options.childCount ?? 1 }], rowCount: 1 };
      }

      if (normalized.includes('INSERT INTO projects')) {
        return { rows: [{ project_id: 501, code: 'МП-501' }], rowCount: 1 };
      }

      if (text.includes('RETURNING order_id')) {
        return { rows: [{ order_id: 100 }], rowCount: 1 };
      }

      if (normalized.startsWith('INSERT INTO order_details')) {
        return { rows: [{ detail_id: 200 }], rowCount: 1 };
      }

      if (normalized.startsWith('UPDATE orders SET delete_flag = false')) {
        if (options.restoreOrderErrorCode) {
          throw Object.assign(new Error('restore failed'), { code: options.restoreOrderErrorCode });
        }
        return { rows: [{ version: params[1] }], rowCount: 1 };
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

      if (normalized.startsWith('UPDATE doweling_orders')) {
        return { rows: [], rowCount: options.dowelingEngineerRowCount ?? 1 };
      }

      return { rows: [], rowCount: 1 };
    },
  };

  return {
    queries,
    tx,
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

function createSaveOrderDto(): SaveOrderDto {
  return {
    header: {
      orderName: 'Replay order',
      clientId: 5,
      orderDate: '2026-05-01',
      orderStatusId: 1,
      discount: 0,
      surcharge: 0,
    },
    details: [],
    payments: [],
    workshops: [],
    requirements: [],
    dowelingLinks: [],
    deleted: {},
    idempotencyKey: 'create-key-1',
  };
}

function createStoredOrderResponse(): OrderDto {
  return {
    header: {
      ...header(),
      orderId: 100,
      projectId: 501,
      projectCode: 'МП-501',
      clientName: 'ООО Ромашка',
      paymentStatusId: 2,
      totalAmount: 120,
      finalAmount: 120,
      paidAmount: 50,
      partsCount: 2,
      totalArea: 1,
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
      createdBy: 42,
      editedBy: 42,
      version: 1,
    },
    details: [],
    payments: [],
    workshops: [],
    requirements: [],
    dowelingLinks: [],
    primaryGroup: null,
    groups: [],
    totals: {
      totalAmount: 120,
      finalAmount: 120,
      paidAmount: 50,
      debtAmount: 70,
      partsCount: 2,
      totalArea: 1,
    },
    version: 1,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    createdBy: 42,
    editedBy: 42,
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
    basisProject: '1319',
    basisProduct: 'Прихожка',
    basisData: '1/04/Фасад',
    basisDesignation: '04',
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

function expectScopedUpdate(
  queries: Array<{ text: string; params: readonly unknown[] }>,
  expected: {
    startsWith: string;
    whereClause: string;
    params: readonly unknown[];
  },
): void {
  const query = queries.find((candidate) =>
    normalizeSql(candidate.text).startsWith(expected.startsWith),
  );

  expect(query).toBeDefined();
  expect(normalizeSql(query!.text)).toContain(expected.whereClause);
  expect(query!.params.slice(0, expected.params.length)).toEqual(expected.params);
}
