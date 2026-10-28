import { randomUUID } from 'node:crypto';
import { Pool, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import type { DatabaseClient } from '../../database/database.types';
import type { CurrentUser } from '../../permissions/current-user';
import type { PermissionName } from '../../permissions/permissions';
import { ROLE_POLICIES } from '../../permissions/policies/role-policies';
import { PgClientPaymentsRepository } from './adapters/pg-client-payments-repository';
import { ClientPaymentsService } from './application/client-payments.service';

// Real PostgreSQL in an isolated schema: set TEST_DATABASE_URL.
const databaseUrl = process.env.TEST_DATABASE_URL;
const FULL: PermissionName[] = ['clients.view', 'orders.view', 'payments.view', 'orders.view_financials'];
const user = (id: number, role: 'admin' | 'manager', permissions: PermissionName[] = FULL): CurrentUser =>
  ({ id: String(id), username: `client-payments-${id}`, role, roleId: role === 'admin' ? 1 : 10, permissions, policyScopes: ROLE_POLICIES[role] });

describe.skipIf(!databaseUrl)('payments of a client for the client card (PostgreSQL, isolated schema)', () => {
  const schema = `e2e_client_payments_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let service: ClientPaymentsService;

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
      CREATE TABLE "${schema}".orders(order_id bigint PRIMARY KEY, order_name varchar(200), client_id bigint, project_id bigint, order_date date,
        manager_id bigint, created_by bigint, delete_flag boolean NOT NULL DEFAULT false, order_kind text NOT NULL DEFAULT 'production_order');
      CREATE TABLE "${schema}".payment_types(type_paid_id smallint PRIMARY KEY, type_paid_name varchar(50));
      CREATE TABLE "${schema}".payments(payment_id bigint PRIMARY KEY, order_id bigint NOT NULL, amount numeric(12,2) NOT NULL, payment_date date NOT NULL,
        type_paid_id smallint NOT NULL, notes text, delete_flag boolean NOT NULL DEFAULT false, ref_key_1c uuid);
      CREATE TABLE "${schema}".users(user_id bigint PRIMARY KEY, employee_id bigint, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE "${schema}".order_workshops(order_id bigint, responsible_employee_id bigint, delete_flag boolean NOT NULL DEFAULT false);
      INSERT INTO "${schema}".clients VALUES (1, 'Тест Клиент'), (2, 'Тест Другой');
      INSERT INTO "${schema}".projects VALUES (7, 'П-7');
      INSERT INTO "${schema}".payment_types VALUES (1, 'Наличные'), (2, 'Kaspi');
      INSERT INTO "${schema}".users VALUES (15, 501);
      -- Client 1: order 1 of manager 12, order 2 of manager 13 (worked on by user 15), order 3 created by 12 for manager 13,
      -- a deleted order 4 and a CRM request 5 of manager 12; client 2: order 6 of manager 12.
      INSERT INTO "${schema}".orders VALUES
        (1, 'E2E-Тест-свой', 1, 7, '2026-10-01', 12, 11, false, 'production_order'),
        (2, 'E2E-Тест-чужой', 1, NULL, '2026-10-02', 13, 13, false, 'production_order'),
        (3, 'E2E-Тест-автор', 1, 7, '2026-10-03', 13, 12, false, 'production_order'),
        (4, 'E2E-Тест-удалён', 1, 7, '2026-10-04', 12, 12, true, 'production_order'),
        (5, 'E2E-Тест-заявка', 1, 7, '2026-10-05', 12, 12, false, 'crm_request'),
        (6, 'E2E-Тест-клиент-2', 2, 7, '2026-10-06', 12, 12, false, 'production_order');
      INSERT INTO "${schema}".order_workshops VALUES (2, 501);
      -- 25 payments of order 1 (10 each), 2 of order 2 (1000 each), one of order 3 (500, from 1C), a deleted payment of
      -- order 1, payments of the deleted order, the CRM request and the other client.
      INSERT INTO "${schema}".payments SELECT n, 1, 10, DATE '2026-10-01' + n::int, 1, 'E2E-Тест-' || n, false, NULL FROM generate_series(1, 25) n;
      INSERT INTO "${schema}".payments VALUES (101, 2, 1000, '2026-11-01', 2, NULL, false, NULL), (102, 2, 1000, '2026-11-02', 2, NULL, false, NULL),
        (103, 3, 500, '2026-11-03', 2, NULL, false, gen_random_uuid()), (104, 1, 7000, '2026-11-04', 1, NULL, true, NULL),
        (105, 4, 9000, '2026-11-05', 1, NULL, false, NULL), (106, 5, 9000, '2026-11-06', 1, NULL, false, NULL),
        (107, 6, 50, '2026-11-07', 1, NULL, false, NULL);`);
    const database = { query: <T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) => pool.query<T>(text, [...params]) } as unknown as DatabaseClient;
    service = new ClientPaymentsService({ read: new PgClientPaymentsRepository(database), auditClient: database });
  }, 60_000);

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool?.end();
  });

  const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: unknown) => (error instanceof ApiError ? error.code : String(error)));
  const withScopes = (base: CurrentUser, orders: 'all' | 'own' | 'assigned' | 'none', payments: 'all' | 'own' | 'assigned' | 'none'): CurrentUser => ({
    ...base,
    policyScopes: { ...ROLE_POLICIES.manager, orders: { ...ROLE_POLICIES.manager.orders, view: orders },
      payments: { ...ROLE_POLICIES.manager.payments, view: payments } },
  });

  it('a user who sees all orders and payments gets every payment of the real orders of the client, with the sum over all pages', async () => {
    const first = await service.list(user(11, 'admin'), 1, 1, 20, 'req-all');
    expect(first.scope).toBe('all');
    expect(first.pagination).toEqual({ page: 1, pageSize: 20, total: 28, totalPages: 2 });
    expect(first.summary).toEqual({ amount: 25 * 10 + 2000 + 500 });
    // Newest first; the deleted payment, the deleted order, the CRM request and the other client are not here.
    expect(first.data[0]).toEqual({ paymentId: 103, paymentDate: '2026-11-03', amount: 500, typePaidName: 'Kaspi', notes: null, fromOnec: true,
      order: { orderId: 3, orderName: 'E2E-Тест-автор', fullNumber: 'П-7-E2E-Тест-автор' } });
    expect(first.data[1]).toMatchObject({ paymentId: 102, fromOnec: false, order: { orderId: 2, fullNumber: null } });
    const second = await service.list(user(11, 'admin'), 1, 2, 20, 'req-all-2');
    expect(second.data).toHaveLength(8);
    expect(second.summary).toEqual(first.summary);
    expect([...first.data, ...second.data].map((p) => p.paymentId)).not.toEqual(expect.arrayContaining([104, 105, 106, 107]));
    // Count, sum and page come from one statement: a page past the end still has the totals.
    const past = await service.list(user(11, 'admin'), 1, 9, 20, 'req-all-past');
    expect(past.data).toEqual([]);
    expect(past.pagination.total).toBe(28);
    expect(past.summary).toEqual(first.summary);
  });

  it('a manager limited to his own orders never gets a payment of another manager\'s order — on any page, nor in the sum', async () => {
    const pages = [await service.list(user(12, 'manager'), 1, 1, 20, 'req-own'), await service.list(user(12, 'manager'), 1, 2, 20, 'req-own-2')];
    expect(pages[0].scope).toBe('own');
    // His order 1 (manager) and order 3 (creator); order 2 of manager 13 is not his.
    expect(pages[0].pagination.total).toBe(26);
    const ids = pages.flatMap((page) => page.data.map((p) => p.paymentId));
    expect(ids).toHaveLength(26);
    expect(ids).not.toContain(101);
    expect(ids).toContain(103);
    for (const page of pages) expect(page.summary).toEqual({ amount: 250 + 500 });
    const other = await service.list(user(13, 'manager'), 1, 1, 20, 'req-other');
    expect(other.data.map((p) => p.paymentId)).toEqual([103, 102, 101]);
    expect((await service.list(user(12, 'manager'), 2, 1, 20, 'req-c2')).data.map((p) => p.paymentId)).toEqual([107]);
  });

  it('the payment visibility narrows what the order visibility allows: own payments of all orders, assigned payments', async () => {
    // Orders unrestricted, payments only of his own orders.
    const own = await service.list(withScopes(user(12, 'manager'), 'all', 'own'), 1, 1, 50, 'req-pay-own');
    expect(own.scope).toBe('own');
    expect(own.pagination.total).toBe(26);
    // Payments of the orders the user works on (assigned): user 15 works on order 2 only.
    const assigned = await service.list(withScopes(user(15, 'manager'), 'all', 'assigned'), 1, 1, 50, 'req-pay-assigned');
    expect(assigned.data.map((p) => p.paymentId)).toEqual([102, 101]);
    expect(assigned.summary).toEqual({ amount: 2000 });
    // Order 2 belongs to another manager: this is not «your orders», the answer says it is otherwise restricted.
    expect(assigned.scope).toBe('restricted');
  });

  it('refuses without any of the four rights or with a visibility that grants nothing (audited), and an unknown client', async () => {
    const without = (right: PermissionName) => FULL.filter((permission) => permission !== right);
    expect(await code(service.list(user(12, 'manager', without('clients.view')), 1, 1, 20, 'req-no-clients'))).toBe('PERMISSION_DENIED');
    expect(await code(service.list(user(12, 'manager', without('orders.view')), 1, 1, 20, 'req-no-orders'))).toBe('PERMISSION_DENIED');
    expect(await code(service.list(user(12, 'manager', without('payments.view')), 1, 1, 20, 'req-no-payments'))).toBe('PERMISSION_DENIED');
    // Payment amounts are money of orders: without the right to see order financials nothing is given (Hasura rule too).
    expect(await code(service.list(user(12, 'manager', without('orders.view_financials')), 1, 1, 20, 'req-no-financials'))).toBe('PERMISSION_DENIED');
    expect(await code(service.list(withScopes(user(14, 'manager'), 'none', 'all'), 1, 1, 20, 'req-no-order-grant'))).toBe('PERMISSION_DENIED');
    expect(await code(service.list(withScopes(user(14, 'manager'), 'all', 'none'), 1, 1, 20, 'req-no-payment-grant'))).toBe('PERMISSION_DENIED');
    const denied = (await pool.query(`SELECT request_id, related_client_id, status_code, metadata_json->'missingPermissions' missing,
        metadata_json->>'orderScope' order_scope, metadata_json->>'paymentScope' payment_scope FROM "${schema}".audit_log
      WHERE event = 'clients.payments_denied' AND related_client_id = 1 ORDER BY request_id`)).rows;
    expect(denied).toEqual([
      { request_id: 'req-no-clients', related_client_id: '1', status_code: 'missing_permission', missing: ['clients.view'], order_scope: 'own', payment_scope: 'own' },
      { request_id: 'req-no-financials', related_client_id: '1', status_code: 'missing_permission', missing: ['orders.view_financials'], order_scope: 'own', payment_scope: 'own' },
      { request_id: 'req-no-order-grant', related_client_id: '1', status_code: 'scope_not_allowed', missing: [], order_scope: 'none', payment_scope: 'all' },
      { request_id: 'req-no-orders', related_client_id: '1', status_code: 'missing_permission', missing: ['orders.view'], order_scope: 'own', payment_scope: 'own' },
      { request_id: 'req-no-payment-grant', related_client_id: '1', status_code: 'scope_not_allowed', missing: [], order_scope: 'all', payment_scope: 'none' },
      { request_id: 'req-no-payments', related_client_id: '1', status_code: 'missing_permission', missing: ['payments.view'], order_scope: 'own', payment_scope: 'own' },
    ]);
    expect(await code(service.list(user(11, 'admin'), 999, 1, 20, 'req-missing'))).toBe('CLIENT_NOT_FOUND');
  });
});
