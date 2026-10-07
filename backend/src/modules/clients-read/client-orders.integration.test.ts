import { randomUUID } from 'node:crypto';
import { Pool, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import type { DatabaseClient } from '../../database/database.types';
import type { CurrentUser } from '../../permissions/current-user';
import type { PermissionName } from '../../permissions/permissions';
import { ROLE_POLICIES } from '../../permissions/policies/role-policies';
import { PgClientOrdersRepository } from './adapters/pg-client-orders-repository';
import { ClientOrdersService } from './application/client-orders.service';

// Real PostgreSQL in an isolated schema: set TEST_DATABASE_URL.
const databaseUrl = process.env.TEST_DATABASE_URL;
const FULL: PermissionName[] = ['clients.view', 'orders.view', 'orders.view_financials'];
const user = (id: number, role: 'admin' | 'manager', permissions: PermissionName[] = FULL): CurrentUser =>
  ({ id: String(id), username: `client-orders-${id}`, role, roleId: role === 'admin' ? 1 : 10, permissions, policyScopes: ROLE_POLICIES[role] });

describe.skipIf(!databaseUrl)('orders of a client for the client card (PostgreSQL, isolated schema)', () => {
  const schema = `e2e_client_orders_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let service: ClientOrdersService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    pool.on('connect', (connection) => { void connection.query(`SET search_path="${schema}",public`); });
    await pool.query(`CREATE SCHEMA "${schema}"; SET search_path="${schema}",public;
      CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
      CREATE TABLE "${schema}".audit_log(audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event text NOT NULL,entity_type text,entity_id text,user_id bigint,
        username text,role_code text,role text,request_id text NOT NULL,source text,related_order_id bigint,related_client_id bigint,related_payment_id bigint,
        related_production_event_id bigint,related_deadline_id bigint,related_user_id bigint,status_field text,status_id bigint,status_name text,status_code text,
        stage_code text,before_json jsonb,after_json jsonb,diff_json jsonb,metadata_json jsonb,created_at timestamptz DEFAULT now());
      CREATE TABLE "${schema}".audit_log_related_entity(audit_id uuid NOT NULL,entity_type text NOT NULL,entity_id bigint NOT NULL,PRIMARY KEY(audit_id,entity_type,entity_id));
      CREATE TABLE "${schema}".clients(client_id bigint PRIMARY KEY, client_name text);
      CREATE TABLE "${schema}".projects(project_id bigint PRIMARY KEY, code text);
      CREATE TABLE "${schema}".order_statuses(order_status_id int PRIMARY KEY, order_status_name text);
      CREATE TABLE "${schema}".production_statuses(production_status_id int PRIMARY KEY, production_status_name text);
      CREATE TABLE "${schema}".payment_statuses(payment_status_id int PRIMARY KEY, payment_status_name text);
      CREATE TABLE "${schema}".orders(order_id bigint PRIMARY KEY, order_name varchar(200), client_id bigint, project_id bigint, order_date date,
        order_status_id int, production_status_id int, payment_status_id int, manager_id bigint, created_by bigint,
        final_amount numeric(14,2), paid_amount numeric(14,2), delete_flag boolean NOT NULL DEFAULT false, order_kind text NOT NULL DEFAULT 'production_order');
      INSERT INTO "${schema}".clients VALUES (1, 'Тест Клиент'), (2, 'Тест Другой');
      INSERT INTO "${schema}".projects VALUES (7, 'П-7');
      INSERT INTO "${schema}".order_statuses VALUES (1, 'В работе'); INSERT INTO "${schema}".production_statuses VALUES (1, 'Раскрой');
      INSERT INTO "${schema}".payment_statuses VALUES (1, 'Частично');
      -- Client 1: 25 orders of manager 12 (100 each, 40 paid), 3 of manager 13 (1000 each, unpaid), one created by 12 for
      -- another manager, one deleted, one CRM request; client 2: one order of manager 12.
      INSERT INTO "${schema}".orders SELECT n, 'E2E-Тест-' || n, 1, 7, DATE '2026-09-01' + n::int, 1, 1, 1, 12, 11, 100, 40 FROM generate_series(1, 25) n;
      INSERT INTO "${schema}".orders SELECT 100 + n, 'E2E-Тест-чужой-' || n, 1, NULL, DATE '2026-10-01' + n::int, 1, 1, 1, 13, 13, 1000, 0 FROM generate_series(1, 3) n;
      INSERT INTO "${schema}".orders VALUES (200, 'E2E-Тест-автор', 1, 7, '2026-10-06', 1, 1, 1, 13, 12, 500, 500);
      INSERT INTO "${schema}".orders VALUES (201, 'E2E-Тест-удалён', 1, 7, '2026-10-07', 1, 1, 1, 12, 12, 7000, 0, true);
      INSERT INTO "${schema}".orders VALUES (202, 'E2E-Тест-заявка', 1, 7, '2026-10-07', 1, 1, 1, 12, 12, 9000, 0, false, 'crm_request');
      INSERT INTO "${schema}".orders VALUES (300, 'E2E-Тест-клиент-2', 2, 7, '2026-10-07', 1, 1, 1, 12, 12, 50, 0);`);
    const database = { query: <T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) => pool.query<T>(text, [...params]) } as unknown as DatabaseClient;
    service = new ClientOrdersService({ read: new PgClientOrdersRepository(database), auditClient: database });
  }, 60_000);

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool?.end();
  });

  const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: unknown) => (error instanceof ApiError ? error.code : String(error)));

  it('a user who sees all orders gets every real order of the client with totals over all pages', async () => {
    const first = await service.list(user(11, 'admin'), 1, 1, 20, 'req-all');
    expect(first.scope).toBe('all');
    expect(first.pagination).toEqual({ page: 1, pageSize: 20, total: 29, totalPages: 2 });
    expect(first.data).toHaveLength(20);
    // Newest first; the deleted order and the CRM request are not orders of the card.
    expect(first.data[0]).toMatchObject({ orderId: 200, fullNumber: 'П-7-E2E-Тест-автор', orderDate: '2026-10-06', orderStatusName: 'В работе',
      productionStatusName: 'Раскрой', paymentStatusName: 'Частично', finalAmount: 500, paidAmount: 500, debtAmount: 0 });
    expect(first.data[1]).toMatchObject({ orderId: 103, fullNumber: null });
    expect(first.summary).toEqual({ finalAmount: 25 * 100 + 3 * 1000 + 500, paidAmount: 25 * 40 + 500, debtAmount: 25 * 60 + 3000 });
    const second = await service.list(user(11, 'admin'), 1, 2, 20, 'req-all-2');
    expect(second.data).toHaveLength(9);
    expect(second.summary).toEqual(first.summary);
  });

  it('a manager limited to his own orders never gets another manager\'s order or its money — on any page', async () => {
    const pages = [await service.list(user(12, 'manager'), 1, 1, 20, 'req-own'), await service.list(user(12, 'manager'), 1, 2, 20, 'req-own-2')];
    expect(pages[0].scope).toBe('own');
    // His 25 as the manager and the one he created for another manager; the 3 orders of manager 13 are not his.
    expect(pages[0].pagination.total).toBe(26);
    const ids = pages.flatMap((page) => page.data.map((order) => order.orderId));
    expect(ids).toHaveLength(26);
    expect(ids.some((id) => id > 100 && id < 200)).toBe(false);
    expect(ids).toContain(200);
    for (const page of pages) expect(page.summary).toEqual({ finalAmount: 25 * 100 + 500, paidAmount: 25 * 40 + 500, debtAmount: 25 * 60 });
    // The other manager sees only his three and the one he manages.
    const other = await service.list(user(13, 'manager'), 1, 1, 20, 'req-other');
    expect(other.data.map((order) => order.orderId).sort()).toEqual([101, 102, 103, 200]);
    expect(other.summary).toEqual({ finalAmount: 3500, paidAmount: 500, debtAmount: 3000 });
    // Another client's orders never mix in.
    expect((await service.list(user(12, 'manager'), 2, 1, 20, 'req-c2')).data.map((order) => order.orderId)).toEqual([300]);
  });

  it('money is absent — not zero — without the right to see order financials', async () => {
    const result = await service.list(user(12, 'manager', ['clients.view', 'orders.view']), 1, 1, 5, 'req-no-money');
    expect(result).not.toHaveProperty('summary');
    expect(result.pagination.total).toBe(26);
    for (const order of result.data) {
      expect(order).not.toHaveProperty('finalAmount');
      expect(order).not.toHaveProperty('paidAmount');
      expect(order).not.toHaveProperty('debtAmount');
    }
  });

  it('refuses without clients.view or orders.view (audited), and for a scope that is neither «all» nor «own»', async () => {
    expect(await code(service.list(user(12, 'manager', ['orders.view']), 1, 1, 20, 'req-no-clients'))).toBe('PERMISSION_DENIED');
    expect(await code(service.list(user(12, 'manager', ['clients.view']), 1, 1, 20, 'req-no-orders'))).toBe('PERMISSION_DENIED');
    const assigned: CurrentUser = { ...user(14, 'manager'), policyScopes: { ...ROLE_POLICIES.manager, orders: { ...ROLE_POLICIES.manager.orders, view: 'assigned' } } };
    expect(await code(service.list(assigned, 1, 1, 20, 'req-assigned'))).toBe('PERMISSION_DENIED');
    // Each refusal is found in the audit by the client, with the exact reason: a missing right or the forbidden scope.
    const denied = (await pool.query(`SELECT request_id, related_client_id, status_code, metadata_json->'missingPermissions' missing,
        metadata_json->>'orderScope' order_scope FROM "${schema}".audit_log
      WHERE event = 'clients.orders_denied' AND related_client_id = 1 ORDER BY request_id`)).rows;
    expect(denied).toEqual([
      { request_id: 'req-assigned', related_client_id: '1', status_code: 'scope_not_allowed', missing: [], order_scope: 'assigned' },
      { request_id: 'req-no-clients', related_client_id: '1', status_code: 'missing_permission', missing: ['clients.view'], order_scope: 'own' },
      { request_id: 'req-no-orders', related_client_id: '1', status_code: 'missing_permission', missing: ['orders.view'], order_scope: 'own' },
    ]);
    expect(await code(service.list(user(11, 'admin'), 999, 1, 20, 'req-missing'))).toBe('CLIENT_NOT_FOUND');
  });
});
