import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../database/database.service';
import type { CurrentUser } from '../current-user';
import { loadEvaluationUsersWith } from '../user-authorization-snapshot';
import { PgOrderReadRepository } from '../../modules/orders/adapters/pg-order-read-repository';
import { PgDeadlineRepository } from '../../modules/deadlines/adapters/pg-deadline-repository';
import { DeadlineQueryService } from '../../modules/deadlines/application/deadline-query.service';
import { PgProjectsRepository } from '../../modules/projects/adapters/pg-projects-repository';
import { PgGroupOrderReportRepository } from '../../modules/groups/reporting/group-order-report.repository';
import { PgGroupEntityLinksRepository } from '../../modules/groups/entity-links/group-entity-links.repository';
import { PgGroupOverviewRepository } from '../../modules/groups/overview/group-overview.repository';
import { parseGroupOverviewQuery } from '../../modules/groups/overview/group-overview.dto';

/**
 * Order read visibility (access groups 0A.4) against a real ERP database (TEST_READ_VISIBILITY_DATABASE_URL, stage).
 * Fixtures — a client, a project with an own and a foreign order, a workshop of the foreign order, deadlines
 * (own order, foreign workshop with order_id NULL, no order), a group with both orders and links to them — live in
 * ONE transaction that is rolled back at the end: nothing stays in the database. Missing preconditions fail.
 */
const databaseUrl = process.env.TEST_READ_VISIBILITY_DATABASE_URL;

describe.skipIf(!databaseUrl)('order read visibility on real data (rolled-back fixtures)', () => {
  let pool: Pool;
  let tx: PoolClient;
  let manager: CurrentUser;
  let topManager: CurrentUser;
  let worker: CurrentUser;
  const f: Record<string, string> = {};

  const database = () => ({
    isConfigured: true,
    query: <T extends QueryResultRow>(text: string, params: readonly unknown[] = []) => tx.query<T>(text, [...params]),
    transaction: async <T>(handler: (client: PoolClient) => Promise<T>) => handler(tx),
  }) as unknown as DatabaseService;
  const one = async (sql: string, params: unknown[] = []) => (await tx.query(sql, params)).rows[0];
  const count = async (sql: string, params: unknown[] = []) => Number((await one(sql, params)).n);

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    tx = await pool.connect();
    await tx.query('BEGIN');
    const ids = await one(`SELECT
      (SELECT u.user_id FROM users u JOIN roles r USING (role_id) WHERE r.role_code = 'manager' AND u.is_active AND NOT u.is_service_account ORDER BY u.user_id LIMIT 1) AS manager,
      (SELECT u.user_id FROM users u JOIN roles r USING (role_id) WHERE r.role_code = 'top_manager' AND u.is_active ORDER BY u.user_id LIMIT 1) AS top,
      (SELECT u.user_id FROM users u JOIN roles r USING (role_id) WHERE r.role_code = 'worker' AND u.is_active ORDER BY u.user_id LIMIT 1) AS worker,
      (SELECT min(order_status_id) FROM order_statuses) AS status, (SELECT min(payment_status_id) FROM payment_statuses) AS pay,
      (SELECT min(workshop_id) FROM workshops) AS workshop, (SELECT min(production_status_id) FROM production_statuses) AS prod`);
    for (const key of ['manager', 'top', 'worker', 'status', 'pay', 'workshop', 'prod']) {
      expect(ids[key], `precondition: ${key}`).not.toBeNull();
    }
    const users = await loadEvaluationUsersWith(tx, [ids.manager, ids.top, ids.worker]);
    manager = users.get(String(ids.manager))!;
    topManager = users.get(String(ids.top))!;
    worker = users.get(String(ids.worker))!;
    const tag = `E2E-Тест-0A4-${Date.now()}`;
    f.client = (await one(`INSERT INTO clients (client_name) VALUES ($1) RETURNING client_id`, [tag])).client_id;
    f.project = (await one(`INSERT INTO projects (code, name, client_id, created_by) VALUES ($1, $2, $3, $4) RETURNING project_id`,
      [`E2E${Date.now() % 1_000_000}`, tag, f.client, ids.top])).project_id;
    const order = async (name: string, owner: string, amount: number) => (await one(
      `INSERT INTO orders (order_name, client_id, order_status_id, payment_status_id, created_by, manager_id, project_id, total_amount, final_amount)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $7) RETURNING order_id`,
      [name, f.client, ids.status, ids.pay, owner, f.project, amount])).order_id;
    f.own = await order(`${tag}-own`, ids.manager, 111);
    f.foreign = await order(`${tag}-foreign`, ids.top, 222);
    f.workshop = (await one(`INSERT INTO order_workshops (order_id, workshop_id, production_status_id, created_by) VALUES ($1, $2, $3, $4) RETURNING order_workshop_id`,
      [f.foreign, ids.workshop, ids.prod, ids.top])).order_workshop_id;
    const deadline = async (orderId: string | null, workshopId: string | null, entityId: string) => (await one(
      `INSERT INTO deadline_instances (entity_type, entity_id, deadline_at, order_id, order_workshop_id)
       VALUES ('order', $1, now() + interval '1 day', $2, $3) RETURNING deadline_id`, [entityId, orderId, workshopId])).deadline_id;
    f.dOwn = await deadline(f.own, null, String(f.own));
    f.dForeignWorkshop = await deadline(null, f.workshop, String(f.foreign));
    f.dFree = await deadline(null, null, `${tag}-free`);
    f.group = (await one(`INSERT INTO group_groups (code, name) VALUES ($1, $2) RETURNING id`, [tag, tag])).id;
    await tx.query(`INSERT INTO group_order_groups (order_id, group_id) VALUES ($1, $3), ($2, $3)`, [f.own, f.foreign, f.group]);
    await tx.query(`INSERT INTO group_entity_links (group_id, entity_type_code, entity_id_text) VALUES
      ($1, 'order', $2), ($1, 'order', $3), ($1, 'deadline_instance', $4), ($1, 'deadline_instance', $5)`,
    [f.group, String(f.own), String(f.foreign), String(f.dOwn), String(f.dForeignWorkshop)]);
  });

  afterAll(async () => {
    await tx?.query('ROLLBACK').catch(() => undefined);
    tx?.release();
    await pool?.end();
  });

  it('order list: exactly own orders for the manager; all for top manager and worker (assigned unrestricted)', async () => {
    const repo = new PgOrderReadRepository(tx);
    const query = { page: 1, pageSize: 1, sortBy: 'updatedAt', sortOrder: 'desc' } as never;
    const own = await count(`SELECT count(*) AS n FROM orders o WHERE o.delete_flag = false AND o.order_kind = 'production_order'
      AND (o.created_by = $1 OR o.manager_id = $1)`, [manager.id]);
    const all = await count(`SELECT count(*) AS n FROM orders o WHERE o.delete_flag = false AND o.order_kind = 'production_order'`);
    expect((await repo.listOrders({ currentUser: manager, query })).pagination.total).toBe(own);
    expect((await repo.listOrders({ currentUser: topManager, query })).pagination.total).toBe(all);
    expect((await repo.listOrders({ currentUser: worker, query })).pagination.total).toBe(all);
  });

  it('order card: own found, foreign not found; top manager sees both', async () => {
    const repo = new PgOrderReadRepository(tx);
    expect(await repo.getOrderById({ currentUser: manager, orderId: Number(f.own) })).not.toBeNull();
    expect(await repo.getOrderById({ currentUser: manager, orderId: Number(f.foreign) })).toBeNull();
    expect(await repo.getOrderById({ currentUser: topManager, orderId: Number(f.foreign) })).not.toBeNull();
  });

  it('deadlines: own and order-less visible; a foreign workshop deadline (order_id NULL) neither listed nor readable', async () => {
    const repo = new PgDeadlineRepository(tx);
    const listed = async (user: CurrentUser) => new Set((await repo.listDeadlines({ currentUser: user,
      query: { page: 1, pageSize: 1000, sortBy: 'deadlineAt', sortOrder: 'asc', entityId: undefined } } as never)).data.map((d) => d.deadlineId));
    const mine = await listed(manager);
    expect(mine.has(f.dOwn)).toBe(true);
    expect(mine.has(f.dFree)).toBe(true);
    expect(mine.has(f.dForeignWorkshop)).toBe(false);
    expect((await listed(topManager)).has(f.dForeignWorkshop)).toBe(true);
    const service = new DeadlineQueryService({ repository: repo, database: tx });
    await expect(service.getById({ currentUser: manager, deadlineId: f.dForeignWorkshop } as never)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.getById({ currentUser: manager, deadlineId: f.dOwn } as never)).resolves.toMatchObject({ deadlineId: f.dOwn });
    await expect(service.listOrderDeadlines({ currentUser: manager, orderId: Number(f.foreign) } as never)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('project card and totals: only the own order and its amount', async () => {
    const repo = new PgProjectsRepository(database());
    const card = await repo.getById(Number(f.project), manager);
    expect(card.orders.map((o) => o.orderId)).toEqual([Number(f.own)]);
    expect(Number(card.ordersCount)).toBe(1);
    expect(Number(card.totalFinalAmount)).toBe(111);
    const full = await repo.getById(Number(f.project), topManager);
    expect(full.orders.map((o) => o.orderId).sort()).toEqual([Number(f.own), Number(f.foreign)].sort());
    expect(Number(full.totalFinalAmount)).toBe(333);
  });

  it('group report, links and overview: only the own order and its deadline', async () => {
    const filter = { mode: 'any', groupIds: [f.group], temporal: { mode: 'current' } } as const;
    const report = new PgGroupOrderReportRepository(tx);
    expect((await report.listOrderIds({ page: 1, pageSize: 10, filter, viewer: manager } as never)).data.map((r) => r.orderId)).toEqual([Number(f.own)]);
    expect((await report.listOrderIds({ page: 1, pageSize: 10, filter, viewer: topManager } as never)).pagination.total).toBe(2);

    const links = new PgGroupEntityLinksRepository(tx);
    const shown = async (user: CurrentUser) => (await links.list({ currentUser: user, groupId: f.group,
      visibleEntityTypes: ['order', 'deadline_instance'] } as never)).links.map((l: { entityType: string; entityId: string }) => `${l.entityType}:${l.entityId}`).sort();
    expect(await shown(manager)).toEqual([`deadline_instance:${f.dOwn}`, `order:${f.own}`].sort());
    expect(await shown(topManager)).toHaveLength(4);

    const overview = new PgGroupOverviewRepository(tx);
    const counts = async (user: CurrentUser) => {
      const result = await overview.getOverview({ groupId: f.group, viewer: user, query: parseGroupOverviewQuery({}),
        visibleEntityTypes: ['order', 'deadline_instance'] } as never);
      return { total: result.orders.totalCount, links: Object.fromEntries(result.linkedEntityCounts.map((c) => [c.entityType, c.currentCount])) };
    };
    expect(await counts(manager)).toEqual({ total: 1, links: { order: 1, deadline_instance: 1 } });
    expect(await counts(topManager)).toEqual({ total: 2, links: { order: 2, deadline_instance: 2 } });
  });
});
