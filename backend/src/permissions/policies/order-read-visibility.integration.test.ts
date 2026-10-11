import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../database/database.service';
import type { CurrentUser } from '../current-user';
import { loadEvaluationUsersWith } from '../user-authorization-snapshot';
import { PgOrderReadRepository } from '../../modules/orders/adapters/pg-order-read-repository';
import { PgDeadlineRepository } from '../../modules/deadlines/adapters/pg-deadline-repository';
import { PgProjectsRepository } from '../../modules/projects/adapters/pg-projects-repository';
import { PgGroupOrderReportRepository } from '../../modules/groups/reporting/group-order-report.repository';

/**
 * Order read visibility (access groups 0A.4) on real data, READ-ONLY: TEST_READ_VISIBILITY_DATABASE_URL points at a
 * database with orders of several managers (stage). Nothing is written.
 */
const databaseUrl = process.env.TEST_READ_VISIBILITY_DATABASE_URL;

describe.skipIf(!databaseUrl)('order read visibility on real data (read-only)', () => {
  let pool: Pool;
  let manager: CurrentUser;
  let topManager: CurrentUser;
  let ownOrderId: number;
  let foreignOrderId: number;

  const database = {
    isConfigured: true,
    query: <T extends QueryResultRow>(text: string, params: readonly unknown[] = []) => pool.query<T>(text, [...params]),
    transaction: async <T>(handler: (tx: PoolClient) => Promise<T>) => {
      const client = await pool.connect();
      try { await client.query('BEGIN READ ONLY'); return await handler(client); } finally { await client.query('ROLLBACK'); client.release(); }
    },
  } as unknown as DatabaseService;
  const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 3 });
    // A manager (orders.view = own) with own orders, and an order of somebody else.
    const pick = await one(`
      SELECT u.user_id, own.order_id AS own_order, foreign_o.order_id AS foreign_order
      FROM users u JOIN roles r ON r.role_id = u.role_id AND r.role_code = 'manager'
      JOIN LATERAL (SELECT o.order_id FROM orders o WHERE o.delete_flag = false AND o.order_kind = 'production_order'
        AND (o.created_by = u.user_id OR o.manager_id = u.user_id) ORDER BY o.order_id DESC LIMIT 1) own ON TRUE
      JOIN LATERAL (SELECT o.order_id FROM orders o WHERE o.delete_flag = false AND o.order_kind = 'production_order'
        AND o.created_by IS DISTINCT FROM u.user_id AND o.manager_id IS DISTINCT FROM u.user_id ORDER BY o.order_id DESC LIMIT 1) foreign_o ON TRUE
      WHERE u.is_active AND NOT u.is_service_account
      ORDER BY u.user_id LIMIT 1`);
    const top = await one(`SELECT u.user_id FROM users u JOIN roles r USING (role_id) WHERE r.role_code = 'top_manager' AND u.is_active ORDER BY u.user_id LIMIT 1`);
    const users = await loadEvaluationUsersWith(pool, [pick.user_id, top.user_id]);
    manager = users.get(String(pick.user_id))!;
    topManager = users.get(String(top.user_id))!;
    ownOrderId = Number(pick.own_order);
    foreignOrderId = Number(pick.foreign_order);
  });

  afterAll(async () => { await pool?.end(); });

  it('order list and search: the manager sees exactly his own orders; the top manager sees all', async () => {
    const repo = new PgOrderReadRepository(pool);
    const query = { page: 1, pageSize: 1, sortBy: 'updatedAt', sortOrder: 'desc' } as never;
    const own = Number((await one(`SELECT count(*) AS n FROM orders o WHERE o.delete_flag = false AND o.order_kind = 'production_order'
      AND (o.created_by = $1 OR o.manager_id = $1)`, [manager.id])).n);
    const all = Number((await one(`SELECT count(*) AS n FROM orders o WHERE o.delete_flag = false AND o.order_kind = 'production_order'`)).n);
    expect((await repo.listOrders({ currentUser: manager, query })).pagination.total).toBe(own);
    expect((await repo.listOrders({ currentUser: topManager, query })).pagination.total).toBe(all);
    expect(own).toBeLessThan(all);
  });

  it('card (and everything built on it: history, audit, CAD, Bazis): foreign order is not found', async () => {
    const repo = new PgOrderReadRepository(pool);
    expect(await repo.getOrderById({ currentUser: manager, orderId: ownOrderId })).not.toBeNull();
    expect(await repo.getOrderById({ currentUser: manager, orderId: foreignOrderId })).toBeNull();
    expect(await repo.getOrderById({ currentUser: topManager, orderId: foreignOrderId })).not.toBeNull();
  });

  it('deadlines list: no deadline of a foreign order', async () => {
    const repo = new PgDeadlineRepository(pool);
    const result = await repo.listDeadlines({ currentUser: manager, query: { page: 1, pageSize: 500, sortBy: 'deadlineAt', sortOrder: 'asc' } } as never);
    const orderIds = [...new Set(result.data.map((d) => d.orderId).filter((id): id is number => id !== null && id !== undefined))];
    if (orderIds.length > 0) {
      const foreign = await one(`SELECT count(*) AS n FROM orders WHERE order_id = ANY($1::bigint[]) AND created_by IS DISTINCT FROM $2 AND manager_id IS DISTINCT FROM $2`, [orderIds, manager.id]);
      expect(Number(foreign.n)).toBe(0);
    }
    const allTotal = (await repo.listDeadlines({ currentUser: topManager, query: { page: 1, pageSize: 1, sortBy: 'deadlineAt', sortOrder: 'asc' } } as never)).total;
    expect(result.total).toBeLessThanOrEqual(allTotal);
  });

  it('project card and totals: only own orders', async () => {
    const project = await one(`SELECT project_id FROM orders WHERE order_id = $1`, [foreignOrderId]);
    if (!project?.project_id) return;
    const repo = new PgProjectsRepository(database);
    const card = await repo.getById(Number(project.project_id), manager);
    const shown = card.orders.map((o: { orderId: number }) => o.orderId);
    expect(shown).not.toContain(foreignOrderId);
    const full = await repo.getById(Number(project.project_id), topManager);
    expect(full.orders.map((o: { orderId: number }) => o.orderId)).toContain(foreignOrderId);
  });

  it('group order report: only own orders', async () => {
    const group = await one(`SELECT group_id FROM group_order_groups WHERE valid_to IS NULL GROUP BY group_id ORDER BY count(*) DESC LIMIT 1`);
    if (!group) return;
    const repo = new PgGroupOrderReportRepository(pool);
    const filter = { mode: 'any', groupIds: [group.group_id], temporal: { mode: 'current' } } as const;
    const mine = await repo.listOrderIds({ page: 1, pageSize: 1000, filter, viewer: manager } as never);
    const ids = mine.data.map((row) => row.orderId);
    if (ids.length > 0) {
      const foreign = await one(`SELECT count(*) AS n FROM orders WHERE order_id = ANY($1::bigint[]) AND created_by IS DISTINCT FROM $2 AND manager_id IS DISTINCT FROM $2`, [ids, manager.id]);
      expect(Number(foreign.n)).toBe(0);
    }
    const everyone = await repo.listOrderIds({ page: 1, pageSize: 1, filter, viewer: topManager } as never);
    expect(mine.pagination.total).toBeLessThanOrEqual(everyone.pagination.total);
  });
});
