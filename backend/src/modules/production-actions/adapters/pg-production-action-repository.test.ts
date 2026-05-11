import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { PgProductionActionRepository } from './pg-production-action-repository';

describe('PgProductionActionRepository', () => {
  it('moves calendar date with idempotency, audit, outbox, and deadline sync boundary', async () => {
    const database = createDatabase();
    const repository = new PgProductionActionRepository(database.service);

    const result = await repository.moveCalendarDate({
      currentUser: currentUser(),
      orderId: 15,
      dto: {
        plannedCompletionDate: '2026-05-20',
        version: 3,
        idempotencyKey: 'move-key-1',
      },
      requestId: 'request-1',
    });

    expect(result).toMatchObject({
      order: { orderId: 15, plannedCompletionDate: '2026-05-20', version: 4 },
      auditId: 'audit-id-1',
      requestId: 'request-1',
    });
    const sql = normalizedSql(database.queries);
    expect(sql).toContain('SELECT set_session_user($1)');
    expect(sql).toContain('INSERT INTO command_idempotency_keys');
    expect(sql).toContain('FROM orders WHERE order_id = $1 AND delete_flag = false FOR UPDATE');
    expect(sql).toContain('UPDATE orders SET planned_completion_date = $2, version = version + 1');
    expect(sql).toContain('INSERT INTO audit_log');
    expect(sql).toContain('INSERT INTO outbox_events');
    expect(JSON.stringify(database.queries.map((query) => query.params))).toContain(
      'deadline.order_sync_requested',
    );
    expect(sql.indexOf('deadline.order_sync_requested')).toBe(-1);
    expect(sql).toContain('UPDATE command_idempotency_keys SET status =');
  });

  it('returns stored idempotent response before stale version checks', async () => {
    const database = createDatabase({
      idempotencyCompletedResponse: {
        order: { orderId: 15, plannedCompletionDate: '2026-05-20', version: 4 },
        requestId: 'request-1',
      },
    });
    const repository = new PgProductionActionRepository(database.service);

    await expect(
      repository.moveCalendarDate({
        currentUser: currentUser(),
        orderId: 15,
        dto: {
          plannedCompletionDate: '2026-05-20',
          version: 999,
          idempotencyKey: 'move-key-1',
        },
        requestId: 'request-1',
      }),
    ).resolves.toMatchObject({
      order: { orderId: 15, version: 4 },
    });
    expect(normalizedSql(database.queries)).not.toContain('FROM orders WHERE order_id');
  });

  it('rejects stale versions after idempotency reservation and before mutation', async () => {
    const database = createDatabase({ orderVersion: 5 });
    const repository = new PgProductionActionRepository(database.service);

    await expect(
      repository.changeOrderStatus({
        currentUser: currentUser(),
        orderId: 15,
        dto: { orderStatusId: 7, version: 3, idempotencyKey: 'status-key-1' },
        requestId: 'request-2',
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'VERSION_CONFLICT',
    });
    const sql = normalizedSql(database.queries);
    expect(sql).toContain('INSERT INTO command_idempotency_keys');
    expect(sql).not.toContain('UPDATE orders SET order_status_id');
  });

  it('activates a production stage with event, order version, audit, and outbox', async () => {
    const database = createDatabase({ existingProductionEventId: null });
    const repository = new PgProductionActionRepository(database.service);

    const result = await repository.activateProductionStage({
      currentUser: currentUser(),
      orderId: 15,
      productionStatusId: 4,
      dto: { version: 3, idempotencyKey: 'stage-on-key-1' },
      requestId: 'request-3',
    });

    expect(result).toMatchObject({
      order: { orderId: 15, version: 4 },
      event: { productionEventId: 42, productionStatusId: 4, active: true },
    });
    const sql = normalizedSql(database.queries);
    expect(sql).toContain('INSERT INTO production_status_events');
    expect(sql).toContain('UPDATE orders SET version = version + 1');
    expect(sql).toContain('INSERT INTO audit_log');
    expect(JSON.stringify(database.queries.map((query) => query.params))).toContain(
      'production.stage_activated',
    );
  });

  it('denies manager actions outside own order scope before mutation', async () => {
    const database = createDatabase({ orderCreatedByUserId: 1, orderManagerUserId: null });
    const repository = new PgProductionActionRepository(database.service);

    await expect(
      repository.changeOrderStatus({
        currentUser: currentUser('manager', '99'),
        orderId: 15,
        dto: { orderStatusId: 7, version: 3, idempotencyKey: 'status-key-2' },
        requestId: 'request-denied',
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    });
    expect(normalizedSql(database.queries)).not.toContain('UPDATE orders SET order_status_id');
  });
});

function createDatabase(options: {
  orderVersion?: number;
  orderCreatedByUserId?: number;
  orderManagerUserId?: number | null;
  existingProductionEventId?: number | null;
  idempotencyCompletedResponse?: unknown;
} = {}) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  let lastRequestHash: unknown = 'hash';
  const tx = {
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });
      const normalized = normalizeSql(text);

      if (normalized.startsWith('INSERT INTO command_idempotency_keys')) {
        lastRequestHash = params[5];
        if (options.idempotencyCompletedResponse) {
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: [
            {
              idempotency_key: params[0],
              request_hash: params[5],
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
              request_hash: lastRequestHash,
              response_json: options.idempotencyCompletedResponse,
              status: 'completed',
            },
          ],
          rowCount: 1,
        };
      }

      if (normalized.startsWith('SELECT order_id, client_id')) {
        return {
          rows: [
            {
              order_id: 15,
              client_id: 969,
              order_date: '2026-05-01',
              planned_completion_date: '2026-05-10',
              order_status_id: 5,
              version: options.orderVersion ?? 3,
              created_by: options.orderCreatedByUserId ?? 1,
              manager_id: options.orderManagerUserId ?? null,
            },
          ],
          rowCount: 1,
        };
      }

      if (normalized.startsWith('SELECT order_status_id, order_status_name')) {
        return { rows: [{ order_status_id: params[0], order_status_name: 'Выдан' }], rowCount: 1 };
      }

      if (normalized.startsWith('SELECT production_status_id')) {
        return {
          rows: [
            {
              production_status_id: params[0],
              production_status_name: 'Крой',
              production_status_code: 'cut',
            },
          ],
          rowCount: 1,
        };
      }

      if (normalized.startsWith('SELECT event_id FROM production_status_events')) {
        return {
          rows:
            options.existingProductionEventId === null
              ? []
              : [{ event_id: options.existingProductionEventId ?? 42 }],
          rowCount: options.existingProductionEventId === null ? 0 : 1,
        };
      }

      if (normalized.startsWith('INSERT INTO production_status_events')) {
        return { rows: [{ event_id: 42 }], rowCount: 1 };
      }

      if (
        normalized.startsWith('UPDATE orders SET planned_completion_date') ||
        normalized.startsWith('UPDATE orders SET order_status_id') ||
        normalized.startsWith('UPDATE orders SET version = version + 1')
      ) {
        return { rows: [{ version: 4 }], rowCount: 1 };
      }

      if (normalized.startsWith('INSERT INTO audit_log')) {
        return { rows: [{ audit_id: 'audit-id-1' }], rowCount: 1 };
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

function currentUser(role: CurrentUser['role'] = 'admin', id = '1'): CurrentUser {
  return {
    id,
    username: role,
    role,
    roleId: 1,
    permissions: getPermissionsForRole(role),
  };
}

function normalizedSql(queries: Array<{ text: string }>): string {
  return queries.map((query) => normalizeSql(query.text)).join('\n');
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}
