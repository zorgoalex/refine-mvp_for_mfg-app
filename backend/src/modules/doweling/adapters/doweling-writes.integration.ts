import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { ROLE_POLICIES } from '../../../permissions/policies/role-policies';
import { scopeSetsFromPolicy, type ScopeGrant } from '../../../permissions/policies/scope-sets';
import { upsertDowelingOrders } from '../../orders/adapters/pg-order-snapshot';
import { PgOrderTransactionManager } from '../../orders/adapters/pg-order-transaction-manager';
import type { OrderSnapshotDto } from '../../orders/dto/order-snapshot.dto';
import { assertDowelingOrdersWritable } from './doweling-write-guard';
import type { UpdateDowelingOrderRequestDto } from '../dto/doweling.dto';
import { PgDowelingRepository } from './pg-doweling-repository';

/**
 * Doweling writes against a real PostgreSQL with the ERP schema and migration 256 (DOWELING_INTEGRATION_DATABASE_URL —
 * a scratch database, never stage or prod). Fixtures expected in it: users 1 and 2, employee 1, payment status 1,
 * production orders 101 (user 1), 102 (user 2), 103 (user 1, NULL manager). Every test creates its own doweling orders.
 */
const databaseUrl = process.env.DOWELING_INTEGRATION_DATABASE_URL;
const maybe = databaseUrl ? describe : describe.skip;

maybe('doweling writes on PostgreSQL', () => {
  let pool: Pool;
  let database: DatabaseService;
  let repository: PgDowelingRepository;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl, max: 8, statement_timeout: 15000 });
    database = databaseOn(pool);
    repository = new PgDowelingRepository(database);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function newDoweling(orderIds: number[], legacyOrderId: number | null = null): Promise<number> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_session_user('1')");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO doweling_orders (doweling_order_name, payment_status_id, design_engineer_id, order_id)
         VALUES ($1, 1, 1, $2) RETURNING doweling_order_id AS id`,
        [`E2E-Тест присадка ${randomUUID().slice(0, 8)}`, legacyOrderId],
      );
      const id = Number(inserted.rows[0].id);
      for (const orderId of orderIds) {
        await client.query('INSERT INTO order_doweling_links (order_id, doweling_order_id) VALUES ($1, $2)', [orderId, id]);
      }
      await client.query('COMMIT');
      return id;
    } finally {
      client.release();
    }
  }

  async function state(id: number) {
    const row = (await pool.query('SELECT version, delete_flag, order_id FROM doweling_orders WHERE doweling_order_id = $1', [id])).rows[0];
    const links = (await pool.query(
      'SELECT order_doweling_link_id AS id, order_id, delete_flag FROM order_doweling_links WHERE doweling_order_id = $1 ORDER BY order_id',
      [id],
    )).rows.map((link) => ({ id: Number(link.id), orderId: Number(link.order_id), active: !link.delete_flag }));
    return {
      version: Number(row.version),
      active: !row.delete_flag,
      legacyOrderId: row.order_id === null ? null : Number(row.order_id),
      activeOrderIds: links.filter((link) => link.active).map((link) => link.orderId),
      links,
    };
  }

  function body(version: number, patch: Partial<UpdateDowelingOrderRequestDto> = {}): Omit<UpdateDowelingOrderRequestDto, 'baseOrderIds'> & { baseOrderIds?: number[] } {
    return {
      expectedVersion: version,
      dowelingOrderName: `E2E-Тест присадка ${randomUUID().slice(0, 8)}`,
      dowelingOrderDate: '2026-10-15',
      paymentStatusId: 1,
      designEngineerId: 1,
      productionStatusId: null,
      operatorId: null,
      issueDate: null,
      paymentDate: null,
      partsCount: 0,
      totalAmount: null,
      finalAmount: null,
      discount: 0,
      surcharge: 0,
      paidAmount: 0,
      linkCadFile: null,
      linkPdfFile: null,
      refKey1c: null,
      isActive: true,
      orderIds: [],
      ...patch,
    };
  }

  // The card sends the orders it showed; by default the current ones (active links ∪ legacy order_id).
  async function currentOrderIds(id: number): Promise<number[]> {
    const s = await state(id);
    return [...new Set([...s.activeOrderIds, ...(s.legacyOrderId === null ? [] : [s.legacyOrderId])])].sort((a, b) => a - b);
  }

  const update = async (id: number, dto: Omit<UpdateDowelingOrderRequestDto, 'baseOrderIds'> & { baseOrderIds?: number[] }, user: CurrentUser = admin(), requestId = randomUUID()) =>
    repository.updateDowelingOrder({
      currentUser: user,
      dowelingOrderId: id,
      dto: { ...dto, baseOrderIds: dto.baseOrderIds ?? (await currentOrderIds(id)) },
      requestId,
    });

  it('links and unlinks orders, revives a removed link, moves the version by one per save, audits each save', async () => {
    const id = await newDoweling([101]);
    const requestId = randomUUID();
    const first = await update(id, body(0, { orderIds: [101, 103], discount: 0 }), admin(), requestId);
    expect(first).toMatchObject({ changed: true, dowelingOrder: { version: 1, isActive: true } });
    expect(first.links.map((link) => link.orderId)).toEqual([101, 103]);

    const audit = (await pool.query(
      'SELECT audit_id, event, diff_json, metadata_json FROM audit_log WHERE request_id = $1',
      [requestId],
    )).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].event).toBe('doweling.updated');
    expect(audit[0].diff_json.orderIds).toEqual({ from: [101], to: [101, 103] });
    const related = (await pool.query('SELECT entity_type, entity_id FROM audit_log_related_entity WHERE audit_id = $1 ORDER BY 1, 2', [audit[0].audit_id])).rows;
    expect(related.map((row) => `${row.entity_type}:${row.entity_id}`)).toEqual([`doweling_order:${id}`, 'order:101', 'order:103']);
    const outbox = (await pool.query('SELECT payload_json FROM outbox_events WHERE idempotency_key = $1', [`doweling_order.updated:${id}:v1`])).rows;
    expect(outbox).toHaveLength(1);
    expect(outbox[0].payload_json).toMatchObject({ action: 'doweling_updated', addedOrderIds: [103], removedOrderIds: [], previousVersion: 0, version: 1 });

    const link101 = (await state(id)).links.find((link) => link.orderId === 101)!.id;
    await update(id, body(1, { orderIds: [103] }));
    expect(await state(id)).toMatchObject({ version: 2, activeOrderIds: [103] });
    const revived = await update(id, body(2, { orderIds: [101, 103] }));
    expect(revived.links.find((link) => link.orderId === 101)!.orderDowelingLinkId).toBe(link101);
    expect(await state(id)).toMatchObject({ version: 3, activeOrderIds: [101, 103] });
  });

  it('a save without changes writes nothing', async () => {
    const id = await newDoweling([101]);
    const name = 'E2E-Тест без изменений ' + randomUUID().slice(0, 8);
    await update(id, body(0, { dowelingOrderName: name, orderIds: [101] }));
    const requestId = randomUUID();
    const again = await update(id, body(1, { dowelingOrderName: name, orderIds: [101] }), admin(), requestId);
    expect(again).toMatchObject({ changed: false, dowelingOrder: { version: 1 } });
    expect((await pool.query('SELECT 1 FROM audit_log WHERE request_id = $1', [requestId])).rowCount).toBe(0);
  });

  it('a stale version is a 409 — also when another writer (order save, Hasura) changed only a link', async () => {
    const id = await newDoweling([101]);
    await expect(update(id, body(5, { orderIds: [101] }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'DOWELING_VERSION_CONFLICT',
      details: { currentVersion: 0 },
    });
    // Another writer adds a link directly (the version trigger of migration 256 moves the version).
    await pool.query("SELECT set_session_user('1'); INSERT INTO order_doweling_links (order_id, doweling_order_id) VALUES (103, $1)".replace('$1', String(id)));
    expect((await state(id)).version).toBe(1);
    await expect(update(id, body(0, { orderIds: [101] }))).rejects.toMatchObject({ statusCode: 409, code: 'DOWELING_VERSION_CONFLICT' });
  });

  it('own-scope manager: foreign linked order → 403 with a durable denied-audit row; foreign order to add → 403 / 404', async () => {
    const shared = await newDoweling([101, 102]);
    const requestId = randomUUID();
    await expect(update(shared, body(0, { orderIds: [101] }), manager({ update: ['own'], view: ['all'] }), requestId)).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { orderIds: [102] },
    });
    const denied = (await pool.query('SELECT event, related_order_id, metadata_json FROM audit_log WHERE request_id = $1', [requestId])).rows;
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ event: 'doweling.update_denied', related_order_id: '102' });
    expect((await state(shared)).version).toBe(0);

    const own = await newDoweling([101]);
    await expect(update(own, body(0, { orderIds: [101, 102] }), manager({ update: ['own'], view: ['all'] }))).rejects.toMatchObject({ statusCode: 403 });
    // A reader of own orders only does not learn that order 102 exists.
    await expect(update(own, body(0, { orderIds: [101, 102] }), manager({ update: ['own'], view: ['own'] }))).rejects.toMatchObject({
      statusCode: 404,
      code: 'ORDER_NOT_FOUND',
    });
    // …and does not learn that a doweling order of a foreign order exists, nor its version.
    await expect(update(shared, body(99, { orderIds: [101] }), manager({ update: ['own'], view: ['own'] }))).rejects.toMatchObject({
      statusCode: 404,
      code: 'DOWELING_ORDER_NOT_FOUND',
    });
    // NULL manager_id: the author still owns order 103.
    await expect(update(own, body(0, { orderIds: [101, 103] }), manager({ update: ['own'], view: ['own'] }))).resolves.toMatchObject({ changed: true });
  });

  it('the orders the card showed must be the current ones (a link added meanwhile is not dropped)', async () => {
    const id = await newDoweling([101]);
    // Another writer adds 103 and an unrelated field change moves the version: a card that read the new version but
    // the old links sends base [101].
    await pool.query(`SELECT set_session_user('1'); INSERT INTO order_doweling_links (order_id, doweling_order_id) VALUES (103, ${id})`);
    await expect(update(id, body(1, { orderIds: [101], baseOrderIds: [101] }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'DOWELING_LINKS_CONFLICT',
      details: { currentOrderIds: [101, 103] },
    });
    expect((await state(id)).activeOrderIds).toEqual([101, 103]);
  });

  it('a legacy-only order (order_id without a link) stays when kept and needs no new link', async () => {
    const id = await newDoweling([], 103);
    const saved = await update(id, body(0, { orderIds: [103], partsCount: 2 }));
    expect(saved).toMatchObject({ changed: true });
    expect(await state(id)).toMatchObject({ legacyOrderId: 103, activeOrderIds: [] });
    await update(id, body(1, { orderIds: [] }));
    expect(await state(id)).toMatchObject({ legacyOrderId: null, version: 2 });
  });

  it('version trigger: a no-op update does not hide a later change; a rolled-back savepoint takes its bump with it', async () => {
    const id = await newDoweling([]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_session_user('1')");
      await client.query('UPDATE doweling_orders SET parts_count = parts_count WHERE doweling_order_id = $1', [id]);
      await client.query('UPDATE doweling_orders SET parts_count = 7 WHERE doweling_order_id = $1', [id]);
      await client.query('COMMIT');
      expect((await state(id)).version).toBe(1);

      await client.query('BEGIN');
      await client.query("SELECT set_session_user('1')");
      await client.query('SAVEPOINT s1');
      await client.query('UPDATE doweling_orders SET parts_count = 8 WHERE doweling_order_id = $1', [id]);
      await client.query('ROLLBACK TO SAVEPOINT s1');
      await client.query('INSERT INTO order_doweling_links (order_id, doweling_order_id) VALUES (101, $1)', [id]);
      await client.query('COMMIT');
      expect(await state(id)).toMatchObject({ version: 2, activeOrderIds: [101] });
    } finally {
      client.release();
    }
  });

  it('legacy order_id stays when still linked and is cleared otherwise; deactivation unlinks everything', async () => {
    const id = await newDoweling([101, 103], 101);
    await update(id, body(0, { orderIds: [101] }));
    expect(await state(id)).toMatchObject({ legacyOrderId: 101, activeOrderIds: [101] });
    await update(id, body(1, { orderIds: [103] }));
    expect(await state(id)).toMatchObject({ legacyOrderId: null, activeOrderIds: [103] });
    const requestId = randomUUID();
    await update(id, body(2, { isActive: false, orderIds: [] }), admin(), requestId);
    expect(await state(id)).toMatchObject({ active: false, activeOrderIds: [], version: 3 });
    const audit = (await pool.query('SELECT event, status_code FROM audit_log WHERE request_id = $1', [requestId])).rows;
    expect(audit[0]).toMatchObject({ event: 'doweling.deactivated', status_code: 'deactivated' });
  });

  it('inconsistent amounts are a 422 with the reason, not a 500', async () => {
    const id = await newDoweling([]);
    await expect(update(id, body(0, { totalAmount: 1000, discount: 100, finalAmount: 950 }))).rejects.toMatchObject({
      statusCode: 422,
      code: 'DOWELING_AMOUNTS_INVALID',
      details: { constraint: 'chk_doweling_orders_final_amount_consistent' },
    });
    await expect(update(id, body(0, { totalAmount: 1000, discount: 100, finalAmount: 900 }))).resolves.toMatchObject({ changed: true });
  });

  it('a save without the money group keeps the money and the payment status (access groups «финансы»)', async () => {
    const id = await newDoweling([]);
    await update(id, body(0, { totalAmount: 1000, discount: 100, finalAmount: 900, paidAmount: 300, paymentStatusId: 2, paymentDate: '2026-10-16' }));
    const { paymentStatusId, paymentDate, totalAmount, finalAmount, discount, surcharge, paidAmount, ...withoutMoney } = body(1, { partsCount: 7 });
    void [paymentStatusId, paymentDate, totalAmount, finalAmount, discount, surcharge, paidAmount];
    await expect(update(id, withoutMoney as UpdateDowelingOrderRequestDto)).resolves.toMatchObject({ changed: true });
    const row = (await pool.query(
      `SELECT payment_status_id, to_char(payment_date, 'YYYY-MM-DD') AS payment_date, total_amount::text, final_amount::text,
              discount::text, paid_amount::text, parts_count, version FROM doweling_orders WHERE doweling_order_id = $1`,
      [id],
    )).rows[0];
    expect(row).toMatchObject({ payment_status_id: 2, payment_date: '2026-10-16', total_amount: '1000.00', final_amount: '900.00',
      discount: '100.00', paid_amount: '300.00', parts_count: 7, version: 2 });
  });

  it('money from a user without orders.view_financials: 403 and a durable denied audit, nothing changes', async () => {
    const id = await newDoweling([]);
    const operator: CurrentUser = { id: '1', username: 'e2e-test-operator', role: 'operator', roleId: 2, permissions: getPermissionsForRole('operator') };
    const requestId = randomUUID();
    await expect(update(id, body(0, { totalAmount: 5 }), operator, requestId)).rejects.toMatchObject({
      statusCode: 403, code: 'PERMISSION_DENIED', details: { requiredPermissions: ['orders.view_financials'] },
    });
    const audit = (await pool.query('SELECT event, metadata_json::text AS metadata FROM audit_log WHERE request_id = $1', [requestId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].event).toBe('doweling.update_denied');
    expect(audit[0].metadata).toContain('FINANCIALS_PERMISSION_REQUIRED');
    expect((await state(id)).version).toBe(0);
  });

  it('a create without the payment status gets the status with code unpaid', async () => {
    const created = await repository.createDowelingOrder({
      currentUser: admin(),
      requestId: randomUUID(),
      dto: { dowelingOrderName: `E2E-Тест ${randomUUID().slice(0, 8)}`, designEngineerId: 1, idempotencyKey: `e2e-${randomUUID()}` },
    });
    const status = (await pool.query(
      `SELECT ps.payment_status_code FROM doweling_orders d JOIN payment_statuses ps USING (payment_status_id) WHERE d.doweling_order_id = $1`,
      [created.dowelingOrder.dowelingOrderId],
    )).rows[0];
    expect(status.payment_status_code).toBe('unpaid');
  });

  it('quick-create from an order links in the same transaction; a foreign order is refused and nothing is created', async () => {
    const created = await repository.createDowelingOrder({
      currentUser: manager({ update: ['own'], view: ['own'] }),
      requestId: randomUUID(),
      dto: { dowelingOrderName: `E2E-Тест ${randomUUID().slice(0, 8)}`, designEngineerId: 1, paymentStatusId: 1, orderId: 101, idempotencyKey: `e2e-${randomUUID()}` },
    });
    expect(created.link).toMatchObject({ orderId: 101 });
    expect(await state(created.dowelingOrder.dowelingOrderId)).toMatchObject({ version: 0, activeOrderIds: [101] });

    const name = `E2E-Тест ${randomUUID().slice(0, 8)}`;
    await expect(
      repository.createDowelingOrder({
        currentUser: manager({ update: ['own'], view: ['all'] }),
        requestId: randomUUID(),
        dto: { dowelingOrderName: name, designEngineerId: 1, paymentStatusId: 1, orderId: 102, idempotencyKey: `e2e-${randomUUID()}` },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await pool.query('SELECT 1 FROM doweling_orders WHERE doweling_order_name = $1', [name])).rowCount).toBe(0);
  });

  it('order save: attaching, detaching or re-assigning a doweling order shared with a foreign order needs update access to it', async () => {
    const manager = new PgOrderTransactionManager(database);
    const ownManager = managerUser({ update: ['own'], view: ['all'] });
    const shared = await newDoweling([102]);
    const standalone = await newDoweling([]);
    const guard = (links: Array<{ id?: number; dowelingOrderId: number; designEngineerId?: number }>, deletedLinkIds: number[] = []) =>
      manager.runInTransaction(async (uow) => {
        await uow.setSessionUser('1');
        await uow.assertDowelingLinkChangesAllowed({
          orderId: 101,
          links: links.map((link) => ({ ...link, refKey1c: null })),
          deletedLinkIds,
          currentUser: ownManager,
          requestId: randomUUID(),
        });
      });

    await expect(guard([{ dowelingOrderId: shared }])).rejects.toMatchObject({ statusCode: 403, details: { orderIds: [102] } });
    await expect(guard([{ dowelingOrderId: standalone }])).resolves.toBeUndefined();

    const linkedBoth = await newDoweling([101, 102]);
    const link = (await state(linkedBoth)).links.find((row) => row.orderId === 101)!.id;
    // Unchanged link: nothing to check. Engineer change or removal: the foreign order 102 decides.
    await expect(guard([{ id: link, dowelingOrderId: linkedBoth, designEngineerId: 1 }])).resolves.toBeUndefined();
    await expect(guard([{ id: link, dowelingOrderId: linkedBoth, designEngineerId: 2 }])).rejects.toMatchObject({ statusCode: 403 });
    await expect(guard([], [link])).rejects.toMatchObject({ statusCode: 403 });
  });

  it('PATCH waits for an order save that holds the order and then sees its change (409), no deadlock', async () => {
    const id = await newDoweling([101]);
    const save = await pool.connect();
    try {
      await save.query('BEGIN');
      await save.query("SELECT set_session_user('1')");
      await save.query('SELECT order_id FROM orders WHERE order_id = 101 FOR UPDATE'); // the order save's lock
      let patchSettled = false;
      const patch = update(id, body(0, { orderIds: [101, 103] })).finally(() => {
        patchSettled = true;
      });
      await sleep(500);
      expect(patchSettled).toBe(false); // blocked on the order lock (FOR KEY SHARE vs FOR UPDATE)
      await save.query('INSERT INTO order_doweling_links (order_id, doweling_order_id) VALUES (103, $1)', [id]);
      await save.query('COMMIT');
      await expect(patch).rejects.toMatchObject({ statusCode: 409, code: 'DOWELING_VERSION_CONFLICT' });
    } finally {
      save.release();
    }
  });

  it('two order saves attaching the same two doweling orders in opposite order do not deadlock', async () => {
    const d1 = await newDoweling([]);
    const d2 = await newDoweling([]);
    const transactions = new PgOrderTransactionManager(database);
    const owner = managerUser({ update: ['own'], view: ['all'] });
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = (orderId: number, dowelingOrderIds: number[]) =>
      transactions.runInTransaction(async (uow) => {
        const tx = uow.getTransactionClient();
        await uow.setSessionUser('1');
        await tx.query('SELECT order_id FROM orders WHERE order_id = $1 FOR UPDATE', [orderId]);
        arrivals += 1;
        if (arrivals === 2) release();
        await barrier;
        const links = dowelingOrderIds.map((dowelingOrderId) => ({ dowelingOrderId, refKey1c: null }));
        await uow.assertDowelingLinkChangesAllowed({ orderId, links, deletedLinkIds: [], currentUser: owner, requestId: randomUUID() });
        await uow.upsertDowelingLinks(orderId, links);
      });
    const results = await Promise.allSettled([save(101, [d1, d2]), save(103, [d2, d1])]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect((await state(d1)).activeOrderIds).toEqual([101, 103]);
  });

  it('an «unchanged engineer» decision cannot go stale: the doweling order is locked before the comparison', async () => {
    const id = await newDoweling([101, 102]);
    const transactions = new PgOrderTransactionManager(database);
    const link = (await state(id)).links.find((row) => row.orderId === 101)!.id;
    const other = await pool.connect();
    try {
      // An authorized writer changes the engineer and keeps the doweling order locked.
      await other.query('BEGIN');
      await other.query("SELECT set_session_user('2')");
      await other.query('UPDATE doweling_orders SET design_engineer_id = 2 WHERE doweling_order_id = $1', [id]);
      let settled = false;
      const restricted = transactions
        .runInTransaction(async (uow) => {
          await uow.setSessionUser('1');
          await uow.getTransactionClient().query('SELECT order_id FROM orders WHERE order_id = 101 FOR UPDATE');
          // The form still shows engineer 1: unchanged for the stale read, a change after the other writer commits.
          const links = [{ id: link, dowelingOrderId: id, designEngineerId: 1, refKey1c: null }];
          await uow.assertDowelingLinkChangesAllowed({ orderId: 101, links, deletedLinkIds: [], currentUser: managerUser({ update: ['own'], view: ['all'] }), requestId: randomUUID() });
          await uow.upsertDowelingLinks(101, links);
        })
        .finally(() => {
          settled = true;
        });
      await sleep(400);
      expect(settled).toBe(false); // waits for the doweling row lock
      await other.query('COMMIT');
      await expect(restricted).rejects.toMatchObject({ statusCode: 403 });
      const engineer = (await pool.query('SELECT design_engineer_id FROM doweling_orders WHERE doweling_order_id = $1', [id])).rows[0];
      expect(Number(engineer.design_engineer_id)).toBe(2);
    } finally {
      other.release();
    }
  });

  // Order snapshot import of existing doweling orders (found by their 1C key).
  async function withRefKey(id: number): Promise<string> {
    const key = randomUUID();
    await pool.query(`SELECT set_session_user('1'); UPDATE doweling_orders SET ref_key_1c = '${key}' WHERE doweling_order_id = ${id}`);
    return key;
  }

  function importDoweling(refKeys: string[], user: CurrentUser, name: string) {
    const snapshot = {
      source: { sourceInstanceId: `e2e-${randomUUID()}` },
      data: {
        dowelingOrders: refKeys.map((refKey1c, index) => ({
          sourceId: `src-${index}-${refKey1c}`, dowelingOrderName: `${name} ${index} ${refKey1c.slice(0, 8)}`, dowelingOrderDate: '2026-10-15', orderSourceId: null,
          paymentStatusId: 1, productionStatusId: null, issueDate: null, totalAmount: null, finalAmount: null, discount: 0,
          surcharge: 0, paidAmount: 0, paymentDate: null, partsCount: 0, linkCadFile: null, linkPdfFile: null, refKey1c,
          designEngineerId: 1, operatorId: null,
        })),
      },
    } as unknown as OrderSnapshotDto;
    return database.transaction(async (tx) => {
      await tx.query("SELECT set_session_user('1')");
      return upsertDowelingOrders(tx, snapshot, 101, 'e2e-hash', (dowelingOrderIds) =>
        assertDowelingOrdersWritable({ database, tx, currentUser: user, requestId: randomUUID(), action: 'order_snapshot_import', dowelingOrderIds, ownOrderId: 101 }));
    });
  }

  it('snapshot import authorizes an existing doweling order only under its lock (a foreign link committed meanwhile refuses)', async () => {
    const id = await newDoweling([]);
    const key = await withRefKey(id);
    const before = (await pool.query('SELECT doweling_order_name FROM doweling_orders WHERE doweling_order_id = $1', [id])).rows[0].doweling_order_name;
    const other = await pool.connect();
    try {
      await other.query('BEGIN');
      await other.query("SELECT set_session_user('2')");
      await other.query('SELECT 1 FROM doweling_orders WHERE doweling_order_id = $1 FOR UPDATE', [id]);
      await other.query('INSERT INTO order_doweling_links (order_id, doweling_order_id) VALUES (102, $1)', [id]);
      let settled = false;
      const imported = importDoweling([key], managerUser({ update: ['own'], view: ['all'] }), 'E2E-Тест импорт').finally(() => {
        settled = true;
      });
      await sleep(400);
      expect(settled).toBe(false); // waits for the doweling row lock before authorizing
      await other.query('COMMIT');
      await expect(imported).rejects.toMatchObject({ statusCode: 403, details: { orderIds: [102] } });
      const after = (await pool.query('SELECT doweling_order_name FROM doweling_orders WHERE doweling_order_id = $1', [id])).rows[0].doweling_order_name;
      expect(after).toBe(before);
    } finally {
      other.release();
    }
  });

  it('snapshot import locks its existing doweling orders in id order (no deadlock with a writer locking them ascending)', async () => {
    const d1 = await newDoweling([]);
    const d2 = await newDoweling([]);
    const [k1, k2] = [await withRefKey(d1), await withRefKey(d2)];
    const other = await pool.connect();
    try {
      await other.query('BEGIN');
      await other.query('SELECT 1 FROM doweling_orders WHERE doweling_order_id = $1 FOR UPDATE', [d1]);
      // The payload lists D2 first; the import must still lock D1 first (and wait), holding nothing.
      const imported = importDoweling([k2, k1], admin(), 'E2E-Тест импорт порядок');
      await sleep(400);
      await other.query('SELECT 1 FROM doweling_orders WHERE doweling_order_id = $1 FOR UPDATE', [d2]); // would deadlock if the import held D2
      await other.query('COMMIT');
      const result = await imported;
      expect([...result.values()].sort((a, b) => a - b)).toEqual([d1, d2].sort((a, b) => a - b));
    } finally {
      other.release();
    }
  });

  it('two order saves of orders sharing a doweling order do not deadlock (other orders are read without a lock)', async () => {
    const id = await newDoweling([101, 103]);
    const transactions = new PgOrderTransactionManager(database);
    const owner = managerUser({ update: ['own'], view: ['all'] });
    const saveOf = (orderId: number, other: number, barrier: Promise<void>, arrived: () => void) =>
      transactions.runInTransaction(async (uow) => {
        const tx = uow.getTransactionClient();
        await uow.setSessionUser('1');
        await tx.query('SELECT order_id FROM orders WHERE order_id = $1 FOR UPDATE', [orderId]);
        arrived();
        await barrier; // both hold their own order now
        const link = (await tx.query('SELECT order_doweling_link_id FROM order_doweling_links WHERE order_id = $1 AND doweling_order_id = $2', [orderId, id])).rows[0];
        await uow.assertDowelingLinkChangesAllowed({
          orderId,
          links: [{ id: Number(link.order_doweling_link_id), dowelingOrderId: id, designEngineerId: orderId === 101 ? 2 : 1, refKey1c: null }],
          deletedLinkIds: [],
          currentUser: owner,
          requestId: randomUUID(),
        });
        await uow.upsertDowelingLinks(orderId, [{ id: Number(link.order_doweling_link_id), dowelingOrderId: id, designEngineerId: orderId === 101 ? 2 : 1, refKey1c: null }]);
        return other;
      });
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const arrived = () => {
      arrivals += 1;
      if (arrivals === 2) release();
    };
    const results = await Promise.allSettled([saveOf(101, 103, barrier, arrived), saveOf(103, 101, barrier, arrived)]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    // One bump per committed transaction that changed something: the second save sees the first one's engineer
    // under the doweling lock, so it changes it back (2 bumps) or finds it unchanged (1 bump) depending on who won.
    expect([1, 2]).toContain((await state(id)).version);
  });
});

function databaseOn(pool: Pool): DatabaseService {
  return {
    isConfigured: true,
    query: (text: string, params: readonly unknown[] = []) => pool.query(text, [...params]),
    async transaction<T>(handler: (tx: { query: PoolClient['query']; raw: PoolClient }) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await handler({ query: ((text: string, params?: unknown[]) => client.query(text, params)) as PoolClient['query'], raw: client });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  } as unknown as DatabaseService;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function admin(): CurrentUser {
  return { id: '1', username: 'e2e_owner', role: 'admin', roleId: 1, permissions: getPermissionsForRole('admin'), policyScopeSets: scopeSetsFromPolicy(ROLE_POLICIES.admin) };
}

function manager(scopes: { update: ScopeGrant[]; view: ScopeGrant[] }): CurrentUser {
  return managerUser(scopes);
}

function managerUser(scopes: { update: ScopeGrant[]; view: ScopeGrant[] }): CurrentUser {
  const sets = scopeSetsFromPolicy(ROLE_POLICIES.manager);
  return {
    id: '1',
    username: 'e2e_owner',
    role: 'manager',
    roleId: 10,
    permissions: getPermissionsForRole('manager'),
    policyScopeSets: { ...sets, orders: { ...sets.orders, update: scopes.update, view: scopes.view } },
  };
}
