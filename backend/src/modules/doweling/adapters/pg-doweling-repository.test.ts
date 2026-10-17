import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { ROLE_POLICIES } from '../../../permissions/policies/role-policies';
import { scopeSetsFromPolicy } from '../../../permissions/policies/scope-sets';
import { PgDowelingRepository } from './pg-doweling-repository';

const dto = {
  dowelingOrderName: 'Тест присадка',
  designEngineerId: 3,
  paymentStatusId: 1,
  idempotencyKey: 'dwl-key-0001',
};

describe('PgDowelingRepository.createDowelingOrder', () => {
  it('inserts doweling_orders + ONE audit_log + ONE outbox, no order_doweling_links', async () => {
    const database = createDatabase({
      insertedDoweling: { doweling_order_id: 555, doweling_order_name: 'Тест присадка', version: 0, payment_status_id: 1 },
    });
    const repo = new PgDowelingRepository(database.service);

    const res = await repo.createDowelingOrder({ currentUser: currentUser(), requestId: 'r', dto });

    expect(res.dowelingOrder).toMatchObject({ dowelingOrderId: 555, dowelingOrderName: 'Тест присадка', version: 0 });
    const sql = normalizedSql(database.queries);
    expect(sql).toContain('SELECT set_session_user($1)');
    expect(sql).toContain('INSERT INTO command_idempotency_keys');
    expect(sql).toContain('INSERT INTO doweling_orders');
    expect(sql).not.toContain('order_doweling_links'); // create-only: never links
    expect(sql.match(/INSERT INTO audit_log(?!_)/g)).toHaveLength(1);
    expect(sql.match(/INSERT INTO outbox_events/g)).toHaveLength(1);
    expect(sql).toContain('UPDATE command_idempotency_keys SET status =');
  });

  it('audit row carries doweling dims via centralized auditService.record path', async () => {
    const database = createDatabase({
      insertedDoweling: { doweling_order_id: 555, doweling_order_name: 'x', version: 0, payment_status_id: 1 },
    });
    await new PgDowelingRepository(database.service).createDowelingOrder({
      currentUser: currentUser(),
      requestId: 'req-1',
      dto,
    });

    const audit = database.queries.find((q) => normalizeSql(q.text).startsWith('INSERT INTO audit_log'));
    expect(audit).toBeDefined();
    expect(audit!.params[0]).toBe('doweling.created'); // event
    expect(audit!.params[1]).toBe('doweling_order'); // entity_type
    expect(audit!.params[2]).toBe('555'); // entity_id
    expect(audit!.params[6]).toBe('req-1'); // request_id
    expect(audit!.params[7]).toBe('backend-doweling-command'); // source
    const meta = audit!.params[22] as string; // metadata_json
    expect(meta).toContain('"dowelingOrderId":555');
    expect(meta).toContain('"designEngineerId":3');
    expect(meta).toContain('"paymentStatusId":1');
  });

  it('replays idempotently: cached response, no second doweling_orders AND no second outbox insert', async () => {
    const database = createDatabase({
      idempotencyCompletedResponse: {
        dowelingOrder: { dowelingOrderId: 555, dowelingOrderName: 'x', version: 0 },
        requestId: 'r',
      },
    });
    const res = await new PgDowelingRepository(database.service).createDowelingOrder({
      currentUser: currentUser(),
      requestId: 'r',
      dto,
    });

    expect(res.dowelingOrder.dowelingOrderId).toBe(555);
    const sql = normalizedSql(database.queries);
    expect(sql).not.toContain('INSERT INTO doweling_orders');
    expect(sql).not.toContain('INSERT INTO outbox_events'); // no duplicate domain event on replay
  });

  it('idempotency request hash covers optional fields (changing partsCount changes the stored hash)', async () => {
    const base = createDatabase({ insertedDoweling: { doweling_order_id: 1, doweling_order_name: 'x', version: 0, payment_status_id: 1 } });
    await new PgDowelingRepository(base.service).createDowelingOrder({ currentUser: currentUser(), requestId: 'r', dto });

    const changed = createDatabase({ insertedDoweling: { doweling_order_id: 2, doweling_order_name: 'x', version: 0, payment_status_id: 1 } });
    await new PgDowelingRepository(changed.service).createDowelingOrder({
      currentUser: currentUser(),
      requestId: 'r',
      dto: { ...dto, partsCount: 5 },
    });

    expect(idempotencyHash(base.queries)).not.toBe(idempotencyHash(changed.queries));
  });

  it('quick-create from an order: links the new doweling order in the same transaction, audits the order', async () => {
    const database = createDatabase({
      insertedDoweling: { doweling_order_id: 555, doweling_order_name: 'Тест присадка', version: 0, payment_status_id: 1 },
      orders: [{ order_id: 101, created_by: 1, manager_id: 1, delete_flag: false, order_kind: 'production_order' }],
    });
    const res = await new PgDowelingRepository(database.service).createDowelingOrder({
      currentUser: currentUser(),
      requestId: 'r',
      dto: { ...dto, orderId: 101 },
    });

    expect(res.link).toEqual({ orderDowelingLinkId: 9001, orderId: 101 });
    const sql = normalizedSql(database.queries);
    expect(sql).toContain('FOR KEY SHARE');
    expect(sql.indexOf('FOR KEY SHARE')).toBeLessThan(sql.indexOf('INSERT INTO doweling_orders'));
    expect(sql).toContain('INSERT INTO order_doweling_links');
    expect(sql).toContain('SET CONSTRAINTS ALL IMMEDIATE');
    const auditRow = database.queries.find((q) => normalizeSql(q.text).startsWith('INSERT INTO audit_log ('));
    expect(auditRow!.params[22] as string).toContain('"orderId":101');
    const outbox = database.queries.find((q) => normalizeSql(q.text).startsWith('INSERT INTO outbox_events'));
    expect(String(outbox!.params[3])).toContain('"orderIds":[101]');
  });

  it('quick-create into a foreign order of an own-scope manager: 403, durable denied audit, nothing inserted', async () => {
    const database = createDatabase({
      insertedDoweling: { doweling_order_id: 555, doweling_order_name: 'x', version: 0, payment_status_id: 1 },
      orders: [{ order_id: 102, created_by: 2, manager_id: 2, delete_flag: false, order_kind: 'production_order' }],
    });
    await expect(
      new PgDowelingRepository(database.service).createDowelingOrder({
        currentUser: ownScopeManager(),
        requestId: 'r',
        dto: { ...dto, orderId: 102 },
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    expect(normalizedSql(database.queries)).not.toContain('INSERT INTO doweling_orders');
    expect(database.audit.some((q) => q.params[0] === 'doweling.create_denied')).toBe(true);
  });

  it('a payment status from a user without orders.view_financials: 403, durable denied audit, nothing inserted', async () => {
    const database = createDatabase({ insertedDoweling: { doweling_order_id: 555, doweling_order_name: 'x', version: 0, payment_status_id: 1 } });
    const operator = { id: '7', username: 'operator', role: 'operator', roleId: 3, permissions: getPermissionsForRole('operator') } as CurrentUser;
    expect(operator.permissions).not.toContain('orders.view_financials');
    await expect(
      new PgDowelingRepository(database.service).createDowelingOrder({ currentUser: operator, requestId: 'r', dto }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED', details: { requiredPermissions: ['orders.view_financials'] } });
    expect(normalizedSql(database.queries)).not.toContain('INSERT INTO doweling_orders');
    const denied = database.audit.find((q) => q.params[0] === 'doweling.create_denied');
    expect(denied).toBeDefined();
    expect(JSON.stringify(denied?.params)).toContain('FINANCIALS_PERMISSION_REQUIRED');
    expect(JSON.stringify(denied?.params)).toContain('orders.view_financials');
  });

  it('without a payment status the same user creates (the server sets «Не оплачен» by code)', async () => {
    const database = createDatabase({ insertedDoweling: { doweling_order_id: 556, doweling_order_name: 'x', version: 0, payment_status_id: 1 } });
    const operator = { id: '7', username: 'operator', role: 'operator', roleId: 3, permissions: getPermissionsForRole('operator') } as CurrentUser;
    const { paymentStatusId, ...withoutStatus } = dto;
    void paymentStatusId;
    await new PgDowelingRepository(database.service).createDowelingOrder({ currentUser: operator, requestId: 'r', dto: withoutStatus });
    expect(normalizedSql(database.queries)).toContain("payment_status_code = 'unpaid'");
  });

  it('quick-create into a missing or non-production order is 404 ORDER_NOT_FOUND', async () => {
    const database = createDatabase({
      orders: [{ order_id: 105, created_by: 1, manager_id: 1, delete_flag: false, order_kind: 'template' }],
    });
    for (const orderId of [105, 999]) {
      await expect(
        new PgDowelingRepository(database.service).createDowelingOrder({ currentUser: currentUser(), requestId: 'r', dto: { ...dto, orderId } }),
      ).rejects.toMatchObject({ statusCode: 404, code: 'ORDER_NOT_FOUND' });
    }
  });

  it('a standalone create keeps the request-hash shape of the earlier release (stored keys still replay)', async () => {
    const database = createDatabase({ insertedDoweling: { doweling_order_id: 1, doweling_order_name: 'x', version: 0, payment_status_id: 1 } });
    await new PgDowelingRepository(database.service).createDowelingOrder({ currentUser: currentUser(), requestId: 'r', dto });
    // sha256 of the stable JSON of the 0.5.24 request shape (no orderId key).
    const { createHash } = await import('node:crypto');
    const legacyShape = {
      actorUserId: '1', commandName: 'doweling.create', designEngineerId: 3, dowelingOrderDate: null,
      dowelingOrderName: 'Тест присадка', linkCadFile: null, linkPdfFile: null, operatorId: null, partsCount: null,
      paymentStatusId: 1, productionStatusId: null,
    };
    const stable = `{${Object.keys(legacyShape).sort().map((key) => `${JSON.stringify(key)}:${JSON.stringify((legacyShape as Record<string, unknown>)[key])}`).join(',')}}`;
    expect(idempotencyHash(database.queries)).toBe(createHash('sha256').update(stable).digest('hex'));
  });

  it('the idempotency hash covers the order to link', async () => {
    const orders = [
      { order_id: 101, created_by: 1, manager_id: 1, delete_flag: false, order_kind: 'production_order' },
      { order_id: 103, created_by: 1, manager_id: 1, delete_flag: false, order_kind: 'production_order' },
    ];
    const a = createDatabase({ insertedDoweling: { doweling_order_id: 1, doweling_order_name: 'x', version: 0, payment_status_id: 1 }, orders });
    await new PgDowelingRepository(a.service).createDowelingOrder({ currentUser: currentUser(), requestId: 'r', dto: { ...dto, orderId: 101 } });
    const b = createDatabase({ insertedDoweling: { doweling_order_id: 2, doweling_order_name: 'x', version: 0, payment_status_id: 1 }, orders });
    await new PgDowelingRepository(b.service).createDowelingOrder({ currentUser: currentUser(), requestId: 'r', dto: { ...dto, orderId: 103 } });
    expect(idempotencyHash(a.queries)).not.toBe(idempotencyHash(b.queries));
  });

  it('maps FK violation (23503) to 404 DOWELING_REFERENCE_NOT_FOUND', async () => {
    const database = createDatabase({ throwOnDowelingInsert: { code: '23503' } });
    await expect(
      new PgDowelingRepository(database.service).createDowelingOrder({
        currentUser: currentUser(),
        requestId: 'r',
        dto,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'DOWELING_REFERENCE_NOT_FOUND' });
  });
});

function createDatabase(
  options: {
    insertedDoweling?: { doweling_order_id: number; doweling_order_name: string; version: number };
    idempotencyCompletedResponse?: unknown;
    throwOnDowelingInsert?: { code: string };
    orders?: Array<{ order_id: number; created_by: number; manager_id: number | null; delete_flag: boolean; order_kind: string }>;
  } = {},
) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  const audit: Array<{ text: string; params: readonly unknown[] }> = [];
  let lastRequestHash: unknown = 'hash';
  let auditId = 0;
  const tx = {
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });
      const normalized = normalizeSql(text);

      if (normalized.startsWith('INSERT INTO command_idempotency_keys')) {
        lastRequestHash = params[5];
        if (options.idempotencyCompletedResponse) {
          return { rows: [], rowCount: 0 }; // conflict → existing key
        }
        return {
          rows: [{ idempotency_key: params[0], request_hash: params[5], response_json: null, status: 'processing' }],
          rowCount: 1,
        };
      }

      if (normalized.startsWith('SELECT idempotency_key, request_hash')) {
        return {
          rows: [
            {
              idempotency_key: params[0],
              request_hash: lastRequestHash,
              response_json: options.idempotencyCompletedResponse,
              status: 'completed',
            },
          ],
          rowCount: 1,
        };
      }

      if (normalized.startsWith('INSERT INTO doweling_orders')) {
        if (options.throwOnDowelingInsert) {
          throw options.throwOnDowelingInsert;
        }
        return { rows: [options.insertedDoweling], rowCount: 1 };
      }

      if (normalized.startsWith('INSERT INTO audit_log (') || normalized.startsWith('INSERT INTO audit_log(')) {
        auditId += 1;
        return { rows: [{ audit_id: `audit-id-${auditId}` }], rowCount: 1 };
      }

      if (normalized.startsWith('SELECT order_id, created_by, manager_id, delete_flag, order_kind FROM orders')) {
        const rows = (options.orders ?? []).filter((row) => (params[0] as number[]).includes(row.order_id));
        return { rows, rowCount: rows.length };
      }

      if (normalized.startsWith('SELECT o.order_id FROM orders o WHERE o.order_id = ANY')) {
        // Read visibility of an own-scope reader: the fixtures' orders authored by user 1.
        const rows = (options.orders ?? []).filter((row) => (params[0] as number[]).includes(row.order_id) && row.created_by === 1);
        return { rows, rowCount: rows.length };
      }

      if (normalized.startsWith('INSERT INTO order_doweling_links')) {
        return { rows: [{ order_doweling_link_id: 9001 }], rowCount: 1 };
      }

      return { rows: [], rowCount: 1 };
    },
  };

  return {
    queries,
    audit,
    service: {
      async transaction<T>(handler: (client: typeof tx) => Promise<T>) {
        return handler(tx);
      },
      // Pool-backed writes outside the transaction (denied audit).
      async query(text: string, params: readonly unknown[] = []) {
        audit.push({ text, params });
        return { rows: [{ audit_id: 'denied-audit' }], rowCount: 1 };
      },
    } as unknown as DatabaseService,
  };
}

function currentUser(role: CurrentUser['role'] = 'manager'): CurrentUser {
  return { id: '1', username: role, role, roleId: 1, permissions: getPermissionsForRole(role) };
}

function ownScopeManager(): CurrentUser {
  const user = currentUser();
  const sets = scopeSetsFromPolicy(ROLE_POLICIES.manager);
  return { ...user, policyScopeSets: { ...sets, orders: { ...sets.orders, view: ['all'], update: ['own'] } } };
}

function idempotencyHash(queries: Array<{ text: string; params: readonly unknown[] }>): unknown {
  const insert = queries.find((q) => normalizeSql(q.text).startsWith('INSERT INTO command_idempotency_keys'));
  return insert?.params[5]; // request_hash column
}

function normalizedSql(queries: Array<{ text: string }>): string {
  return queries.map((query) => normalizeSql(query.text)).join('\n');
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}
