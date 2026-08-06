import { describe, expect, it } from 'vitest';
import type { QueryResultRow } from 'pg';
import type { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { OrderRefreshService } from './order-refresh.service';

interface CapturedQuery {
  text: string;
  params: readonly unknown[];
}

describe('OrderRefreshService', () => {
  it('atomically forces doweling, bumps version and records query-ready audit/outbox', async () => {
    const fake = createDatabase(({ text }) => {
      if (text.includes('FROM orders') && text.includes('FOR UPDATE')) {
        return [{ order_id: 42, version: 5, created_by: 7, manager_id: 7 }];
      }
      if (text.includes('INSERT INTO command_idempotency_keys')) return [{ request_hash: 'new', status: 'processing' }];
      if (text.includes('WITH candidates AS')) {
        return [
          { detail_id: 10, previous_doweling: false },
          { detail_id: 11, previous_doweling: null },
        ];
      }
      if (text.includes('UPDATE orders')) return [{ version: 6 }];
      if (text.includes('INSERT INTO audit_log (')) return [{ audit_id: 'audit-refresh-1' }];
      return [];
    });
    const service = new OrderRefreshService({ database: fake.service });

    await expect(service.refresh({
      currentUser: manager(),
      orderId: 42,
      expectedVersion: 5,
      idempotencyKey: 'order-refresh-key-1',
      requestId: 'request-refresh-1',
    })).resolves.toMatchObject({
      baseVersion: 5,
      version: 6,
      updatedDowelingDetailIds: [10, 11],
      auditId: 'audit-refresh-1',
      requestId: 'request-refresh-1',
    });

    const update = findQuery(fake.queries, 'WITH candidates AS');
    expect(update.text).toContain('doweling IS DISTINCT FROM true');
    expect(update.text).toContain("COALESCE(note, '') ~* $2");
    expect(update.params[1]).toBe('(^|[^[:alnum:]_])присадка($|[^[:alnum:]_])');

    const audit = findQuery(fake.queries, 'INSERT INTO audit_log (');
    expect(audit.params.slice(0, 9)).toEqual([
      'orders.details_doweling_auto_set',
      'order',
      '42',
      '7',
      'manager',
      'manager',
      'request-refresh-1',
      'backend-orders-command',
      42,
    ]);
    expect(String(audit.params[19])).not.toContain('Присадка');
    expect(String(audit.params[20])).not.toContain('Присадка');

    const related = fake.queries.filter((query) => query.text.includes('INSERT INTO audit_log_related_entity'));
    expect(related.map((query) => query.params.slice(1))).toEqual([
      ['order', 42],
      ['order_detail', 10],
      ['order_detail', 11],
    ]);

    const outbox = findQuery(fake.queries, 'INSERT INTO outbox_events');
    expect(outbox.params[0]).toBe('order.details_doweling_auto_set');
    expect(outbox.params[1]).toBe('42');
    expect(outbox.params[3]).toBe('order-refresh-key-1:order.details_doweling_auto_set');

    const completed = findQuery(fake.queries, "SET status = 'completed'");
    const cached = JSON.parse(String(completed.params[1]));
    expect(cached).not.toHaveProperty('order');
    expect(cached).toMatchObject({ version: 6, updatedDowelingDetailIds: [10, 11] });
  });

  it('does not bump version or emit audit/outbox for a no-op refresh', async () => {
    const fake = createDatabase(({ text }) => {
      if (text.includes('FROM orders') && text.includes('FOR UPDATE')) {
        return [{ order_id: 42, version: 5, created_by: 7, manager_id: 7 }];
      }
      if (text.includes('INSERT INTO command_idempotency_keys')) return [{ request_hash: 'new', status: 'processing' }];
      return [];
    });
    const service = new OrderRefreshService({ database: fake.service });

    await expect(service.refresh({
      currentUser: manager(),
      orderId: 42,
      expectedVersion: 5,
      idempotencyKey: 'order-refresh-key-2',
    })).resolves.toMatchObject({ version: 5, updatedDowelingDetailIds: [], auditId: null });

    expect(fake.queries.some((query) => query.text.includes('UPDATE orders'))).toBe(false);
    expect(fake.queries.some((query) => query.text.includes('INSERT INTO audit_log ('))).toBe(false);
    expect(fake.queries.some((query) => query.text.includes('INSERT INTO outbox_events'))).toBe(false);
  });

  it('replays mutation metadata without rerunning mutation even when current order is newer', async () => {
    let requestHash = '';
    const replay = {
      baseVersion: 5,
      version: 6,
      updatedDowelingDetailIds: [10],
      auditId: 'audit-refresh-1',
      refreshedAt: '2026-08-06T09:00:00.000Z',
      requestId: 'request-refresh-1',
    };
    const fake = createDatabase(({ text, params }) => {
      if (text.includes('FROM orders') && text.includes('FOR UPDATE')) {
        return [{ order_id: 42, version: 9, created_by: 7, manager_id: 7 }];
      }
      if (text.includes('INSERT INTO command_idempotency_keys')) {
        requestHash = String(params[4]);
        return [];
      }
      if (text.includes('FROM command_idempotency_keys')) {
        return [{ request_hash: requestHash, response_json: replay, status: 'completed' }];
      }
      return [];
    });
    const service = new OrderRefreshService({ database: fake.service });

    await expect(service.refresh({
      currentUser: manager(),
      orderId: 42,
      expectedVersion: 5,
      idempotencyKey: 'order-refresh-key-1',
      requestId: 'retry-request',
    })).resolves.toEqual(replay);
    expect(fake.queries.some((query) => query.text.includes('WITH candidates AS'))).toBe(false);
  });

  it('requires both view and update permissions before opening a transaction', async () => {
    const fake = createDatabase(() => []);
    const service = new OrderRefreshService({
      database: fake.service,
      permissions: { canUser: (_user, permission) => permission === 'orders.view' },
    });

    await expect(service.refresh({
      currentUser: manager(),
      orderId: 42,
      expectedVersion: 5,
      idempotencyKey: 'order-refresh-key-permission',
    })).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    expect(fake.queries).toHaveLength(0);
  });

  it('enforces canonical row scope before idempotency or mutation work', async () => {
    const fake = createDatabase(({ text }) => {
      if (text.includes('FROM orders') && text.includes('FOR UPDATE')) {
        return [{ order_id: 42, version: 5, created_by: 99, manager_id: 99 }];
      }
      return [];
    });
    const service = new OrderRefreshService({ database: fake.service });

    await expect(service.refresh({
      currentUser: manager(),
      orderId: 42,
      expectedVersion: 5,
      idempotencyKey: 'order-refresh-key-scope',
    })).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    expect(fake.queries.some((query) => query.text.includes('command_idempotency_keys'))).toBe(false);
  });

  it('rejects a stale order version before changing details', async () => {
    const fake = createDatabase(({ text }) => {
      if (text.includes('FROM orders') && text.includes('FOR UPDATE')) {
        return [{ order_id: 42, version: 6, created_by: 7, manager_id: 7 }];
      }
      if (text.includes('INSERT INTO command_idempotency_keys')) {
        return [{ request_hash: 'new', status: 'processing' }];
      }
      return [];
    });
    const service = new OrderRefreshService({ database: fake.service });

    await expect(service.refresh({
      currentUser: manager(),
      orderId: 42,
      expectedVersion: 5,
      idempotencyKey: 'order-refresh-key-version',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'ORDER_VERSION_CONFLICT',
      details: { currentVersion: 6, clientVersion: 5 },
    });
    expect(fake.queries.some((query) => query.text.includes('WITH candidates AS'))).toBe(false);
  });

  it('rejects an idempotency key reused for a different refresh request', async () => {
    const fake = createDatabase(({ text }) => {
      if (text.includes('FROM orders') && text.includes('FOR UPDATE')) {
        return [{ order_id: 42, version: 5, created_by: 7, manager_id: 7 }];
      }
      if (text.includes('INSERT INTO command_idempotency_keys')) return [];
      if (text.includes('FROM command_idempotency_keys')) {
        return [{ request_hash: 'different-request-hash', response_json: null, status: 'processing' }];
      }
      return [];
    });
    const service = new OrderRefreshService({ database: fake.service });

    await expect(service.refresh({
      currentUser: manager(),
      orderId: 42,
      expectedVersion: 5,
      idempotencyKey: 'order-refresh-key-reused',
    })).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(fake.queries.some((query) => query.text.includes('WITH candidates AS'))).toBe(false);
  });
});

function createDatabase(
  resolver: (query: CapturedQuery) => QueryResultRow[],
): { service: DatabaseService; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];
  const client = {
    async query(text: string, params: readonly unknown[] = []) {
      const query = { text, params };
      queries.push(query);
      return { rows: resolver(query) };
    },
  } as unknown as TransactionClient;
  const service = {
    async transaction<T>(handler: (tx: TransactionClient) => Promise<T>): Promise<T> {
      return handler(client);
    },
  } as DatabaseService;
  return { service, queries };
}

function findQuery(queries: CapturedQuery[], fragment: string): CapturedQuery {
  const query = queries.find((candidate) => candidate.text.includes(fragment));
  if (!query) throw new Error(`Missing query: ${fragment}`);
  return query;
}

function manager(): CurrentUser {
  return {
    id: '7',
    username: 'manager',
    role: 'manager',
    roleId: 10,
    permissions: getPermissionsForRole('manager'),
  };
}
