import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { PgProjectsRepository } from './pg-projects-repository';

describe('PgProjectsRepository.update', () => {
  it('locks the project row FOR UPDATE, writes exactly one audit row, and returns the updated dto', async () => {
    const database = createDatabase({
      beforeRow: {
        project_id: 5,
        code: 'ФК25',
        name: 'Старая кухня',
        client_id: 9,
        notes: 'old',
        version: 2,
        delete_flag: false,
      },
      updatedRow: {
        project_id: 5,
        code: 'ФК26',
        name: 'Новая кухня',
        client_id: 9,
        notes: null,
        version: 3,
      },
    });

    const result = await new PgProjectsRepository(database.service).update({
      currentUser: currentUser(),
      projectId: 5,
      dto: { code: 'ФК26', name: 'Новая кухня', notes: null },
      expectedVersion: 2,
      requestId: 'req-1',
    });

    expect(result).toMatchObject({
      projectId: 5,
      code: 'ФК26',
      name: 'Новая кухня',
      clientId: 9,
      notes: null,
      version: 3,
    });

    const sql = normalizedSql(database.queries);
    expect(sql).toContain('SELECT set_session_user($1)');
    expect(sql).toContain('FROM projects WHERE project_id = $1 FOR UPDATE');
    expect(sql).toContain('UPDATE projects SET');
    expect(database.queries.filter((query) => normalizeSql(query.text).startsWith('INSERT INTO audit_log (')).length).toBe(1);

    const audit = database.queries.find((query) => normalizeSql(query.text).startsWith('INSERT INTO audit_log'));
    expect(audit).toBeDefined();
    expect(audit?.params[0]).toBe('project.updated');
    expect(audit?.params[1]).toBe('project');
    expect(audit?.params[2]).toBe('5');
    expect(audit?.params[9]).toBe(9);
    expect(audit?.params[22]).toContain('"projectId":5');
    expect(audit?.params[22]).toContain('"action":"project_update"');
  });

  it('maps stale version to 409 VERSION_CONFLICT before update', async () => {
    const database = createDatabase({
      beforeRow: {
        project_id: 5,
        code: 'ФК25',
        name: 'Старая кухня',
        client_id: 9,
        notes: 'old',
        version: 3,
        delete_flag: false,
      },
    });

    await expect(
      new PgProjectsRepository(database.service).update({
        currentUser: currentUser(),
        projectId: 5,
        dto: { code: 'ФК26' },
        expectedVersion: 2,
        requestId: 'req-1',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'VERSION_CONFLICT' });

    const sql = normalizedSql(database.queries);
    expect(sql).not.toContain('UPDATE projects SET');
    expect(sql).not.toContain('INSERT INTO audit_log');
  });

  it('maps unique violation 23505 to 409 PROJECT_CODE_TAKEN', async () => {
    const database = createDatabase({
      beforeRow: {
        project_id: 5,
        code: 'ФК25',
        name: 'Старая кухня',
        client_id: 9,
        notes: 'old',
        version: 2,
        delete_flag: false,
      },
      throwOnUpdate: { code: '23505' },
    });

    await expect(
      new PgProjectsRepository(database.service).update({
        currentUser: currentUser(),
        projectId: 5,
        dto: { code: 'ФК26' },
        expectedVersion: 2,
        requestId: 'req-1',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PROJECT_CODE_TAKEN' });

    expect(normalizedSql(database.queries)).not.toContain('INSERT INTO audit_log');
  });
});

describe('PgProjectsRepository.moveOrder', () => {
  it('moves order, bumps order version, archives emptied source with own audit event', async () => {
    const database = createDatabase({
      lockedOrderRow: {
        order_id: 10,
        order_name: '1258',
        client_id: 2,
        project_id: 100,
      },
      targetProjectRow: {
        project_id: 200,
        client_id: 2,
        delete_flag: false,
        code: 'ФК26',
      },
      sourceOrderCount: 0,
    });

    const result = await new PgProjectsRepository(database.service).moveOrder({
      currentUser: currentUser(),
      orderId: 10,
      targetProjectId: 200,
      idempotencyKey: 'move-order-key-1',
      requestId: 'req-move-1',
    });

    expect(result).toMatchObject({
      orderId: 10,
      projectId: 200,
      code: 'ФК26',
      archivedSourceProjectId: 100,
      requestId: 'req-move-1',
    });
    expect(result.auditId).toBeTypeOf('number');

    const sql = normalizedSql(database.queries);
    expect(sql).toContain('SELECT set_session_user($1)');
    expect(sql).toContain('INSERT INTO command_idempotency_keys');
    expect(sql).toContain('command_name, actor_user_id, entity_type, entity_id, request_hash, status');
    expect(sql).toContain('FROM orders o WHERE o.order_id = $1 AND o.delete_flag = false FOR UPDATE');
    expect(sql).toContain('UPDATE orders SET project_id = $2, version = version + 1');
    expect(sql).toContain('SELECT COUNT(*) AS c FROM orders WHERE project_id = $1');
    expect(sql).toContain('UPDATE projects SET delete_flag = true, version = version + 1');
    expect(sql).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
    expect(sql).toContain("UPDATE command_idempotency_keys SET status = 'completed'");

    const auditEvents = database.queries
      .filter((query) => normalizeSql(query.text).startsWith('INSERT INTO audit_log ('))
      .map((query) => query.params[0]);
    expect(auditEvents).toEqual(['project.archived', 'project.order_moved']);

    const outboxKeys = database.outboxRows.map((row) => row.idempotencyKey);
    expect(outboxKeys).toEqual(['move-order-key-1:archived', 'move-order-key-1']);
    expect(database.outboxRows.map((row) => row.eventType)).toEqual(['project.archived', 'project.order_moved']);
  });

  it('soft-deleted order → 404, source with remaining deleted orders NOT archived', async () => {
    const missingOrderDb = createDatabase({
      lockedOrderRow: null,
    });

    await expect(
      new PgProjectsRepository(missingOrderDb.service).moveOrder({
        currentUser: currentUser(),
        orderId: 10,
        targetProjectId: 200,
        idempotencyKey: 'move-order-key-404',
        requestId: 'req-move-404',
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'ORDER_NOT_FOUND' });

    expect(normalizedSql(missingOrderDb.queries)).not.toContain('UPDATE orders SET project_id = $2');

    const database = createDatabase({
      lockedOrderRow: {
        order_id: 10,
        order_name: '1258',
        client_id: 2,
        project_id: 100,
      },
      targetProjectRow: {
        project_id: 200,
        client_id: 2,
        delete_flag: false,
        code: 'ФК26',
      },
      sourceOrderCount: 1,
    });

    const result = await new PgProjectsRepository(database.service).moveOrder({
      currentUser: currentUser(),
      orderId: 10,
      targetProjectId: 200,
      idempotencyKey: 'move-order-key-remaining',
      requestId: 'req-move-remaining',
    });

    expect(result.archivedSourceProjectId).toBeNull();
    expect(database.queries.map((query) => normalizeSql(query.text)).join('\n')).not.toContain(
      'UPDATE projects SET delete_flag = true, version = version + 1',
    );
    expect(database.outboxRows.map((row) => row.eventType)).toEqual(['project.order_moved']);
  });

  it('createNew=true mints МП-N root and moves there', async () => {
    const database = createDatabase({
      lockedOrderRow: {
        order_id: 10,
        order_name: '1258',
        client_id: 2,
        project_id: 100,
      },
      sourceOrderCount: 1,
      autoRootRow: {
        project_id: 301,
        code: 'МП-301',
      },
    });

    const result = await new PgProjectsRepository(database.service).moveOrder({
      currentUser: currentUser(),
      orderId: 10,
      createNew: true,
      idempotencyKey: 'move-order-key-new-root',
      requestId: 'req-move-root',
    });

    expect(result).toMatchObject({
      orderId: 10,
      projectId: 301,
      code: 'МП-301',
      archivedSourceProjectId: null,
    });

    const auditEvents = database.queries
      .filter((query) => normalizeSql(query.text).startsWith('INSERT INTO audit_log ('))
      .map((query) => query.params[0]);
    expect(auditEvents).toEqual(['project.created', 'project.order_moved']);
    expect(database.outboxRows.map((row) => row.idempotencyKey)).toEqual(['project.created:301', 'move-order-key-new-root']);
    expect(normalizedSql(database.queries)).toContain("WITH next_project AS ( SELECT nextval(pg_get_serial_sequence('public.projects', 'project_id')) AS project_id )");
  });

  it('client mismatch → 422; replay with same idempotency key returns cached response without second UPDATE', async () => {
    const mismatchDb = createDatabase({
      lockedOrderRow: {
        order_id: 10,
        order_name: '1258',
        client_id: 2,
        project_id: 100,
      },
      targetProjectRow: {
        project_id: 200,
        client_id: 9,
        delete_flag: false,
        code: 'ФК26',
      },
    });

    await expect(
      new PgProjectsRepository(mismatchDb.service).moveOrder({
        currentUser: currentUser(),
        orderId: 10,
        targetProjectId: 200,
        idempotencyKey: 'move-order-key-mismatch',
        requestId: 'req-move-mismatch',
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'PROJECT_CLIENT_MISMATCH' });

    expect(normalizedSql(mismatchDb.queries)).not.toContain('UPDATE orders SET project_id = $2, version = version + 1');

    const replayDb = createDatabase({
      lockedOrderRow: {
        order_id: 10,
        order_name: '1258',
        client_id: 2,
        project_id: 100,
      },
      targetProjectRow: {
        project_id: 200,
        client_id: 2,
        delete_flag: false,
        code: 'ФК26',
      },
      sourceOrderCount: 1,
    });

    const repo = new PgProjectsRepository(replayDb.service);
    const command = {
      currentUser: currentUser(),
      orderId: 10,
      targetProjectId: 200,
      idempotencyKey: 'move-order-key-replay',
      requestId: 'req-move-replay',
    };

    const first = await repo.moveOrder(command);
    const second = await repo.moveOrder(command);

    expect(second).toEqual(first);
    expect(
      replayDb.queries.filter((query) =>
        normalizeSql(query.text).startsWith('UPDATE orders SET project_id = $2, version = version + 1'),
      ),
    ).toHaveLength(1);
  });
});

function createDatabase(
  options: {
    beforeRow?: Record<string, unknown>;
    updatedRow?: Record<string, unknown>;
    throwOnUpdate?: { code: string };
    lockedOrderRow?: Record<string, unknown> | null;
    targetProjectRow?: Record<string, unknown> | null;
    sourceOrderCount?: number;
    autoRootRow?: Record<string, unknown>;
  } = {},
) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  const outboxRows: Array<{ eventType: string; aggregateId: string; payload: unknown; idempotencyKey: string }> = [];
  const idempotency = new Map<
    string,
    {
      requestHash: string;
      status: 'processing' | 'completed' | 'failed';
      responseJson: unknown;
    }
  >();
  let auditId = 100;
  const tx = {
    raw: {} as never,
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });
      const normalized = normalizeSql(text);

      if (normalized.startsWith('SELECT project_id, code, name, client_id, notes, version, delete_flag FROM projects')) {
        return { rows: options.beforeRow ? [options.beforeRow] : [], rowCount: options.beforeRow ? 1 : 0 };
      }

      if (normalized.startsWith('UPDATE projects SET')) {
        if (options.throwOnUpdate) {
          throw options.throwOnUpdate;
        }
        return { rows: options.updatedRow ? [options.updatedRow] : [], rowCount: options.updatedRow ? 1 : 0 };
      }

      if (normalized.startsWith('INSERT INTO command_idempotency_keys')) {
        const key = String(params[0]);
        const requestHash = String(params[5]);
        if (idempotency.has(key)) {
          return { rows: [], rowCount: 0 };
        }
        idempotency.set(key, {
          requestHash,
          status: 'processing',
          responseJson: null,
        });
        return {
          rows: [{ idempotency_key: key, request_hash: requestHash, response_json: null, status: 'processing' }],
          rowCount: 1,
        };
      }

      if (normalized.startsWith('SELECT idempotency_key, request_hash, response_json, status FROM command_idempotency_keys')) {
        const key = String(params[0]);
        const row = idempotency.get(key);
        return {
          rows: row
            ? [{
                idempotency_key: key,
                request_hash: row.requestHash,
                response_json: row.responseJson,
                status: row.status,
              }]
            : [],
          rowCount: row ? 1 : 0,
        };
      }

      if (normalized.startsWith("UPDATE command_idempotency_keys SET status = 'completed'")) {
        const key = String(params[0]);
        const row = idempotency.get(key);
        if (row) {
          row.status = 'completed';
          row.responseJson = JSON.parse(String(params[1]));
        }
        return { rows: [], rowCount: 1 };
      }

      if (
        normalized.startsWith(
          'SELECT o.order_id, o.order_name, o.client_id, o.project_id FROM orders o WHERE o.order_id = $1 AND o.delete_flag = false FOR UPDATE',
        )
      ) {
        return {
          rows: options.lockedOrderRow === null ? [] : [options.lockedOrderRow ?? {
            order_id: 10,
            order_name: '1258',
            client_id: 2,
            project_id: 100,
          }],
          rowCount: options.lockedOrderRow === null ? 0 : 1,
        };
      }

      if (
        normalized.startsWith('SELECT project_id, client_id, delete_flag, code FROM projects WHERE project_id = $1 FOR UPDATE')
      ) {
        return {
          rows: options.targetProjectRow === null ? [] : [options.targetProjectRow ?? {
            project_id: 200,
            client_id: 2,
            delete_flag: false,
            code: 'ФК26',
          }],
          rowCount: options.targetProjectRow === null ? 0 : 1,
        };
      }

      if (
        normalized.startsWith(
          "WITH next_project AS ( SELECT nextval(pg_get_serial_sequence('public.projects', 'project_id')) AS project_id ) INSERT INTO projects",
        )
      ) {
        return {
          rows: [options.autoRootRow ?? { project_id: 301, code: 'МП-301' }],
          rowCount: 1,
        };
      }

      if (normalized.startsWith('UPDATE orders SET project_id = $2, version = version + 1')) {
        return { rows: [], rowCount: 1 };
      }

      if (normalized.startsWith('SELECT COUNT(*) AS c FROM orders WHERE project_id = $1')) {
        return { rows: [{ c: String(options.sourceOrderCount ?? 0) }], rowCount: 1 };
      }

      if (normalized.startsWith('INSERT INTO audit_log')) {
        auditId += 1;
        return { rows: [{ audit_id: String(auditId) }], rowCount: 1 };
      }

      if (normalized.startsWith('INSERT INTO outbox_events')) {
        const eventType = String(params[0]);
        const usesLiteralAggregateType = typeof params[1] === 'string' && typeof params[2] === 'string' && String(params[2]).startsWith('{');
        const aggregateId = String(usesLiteralAggregateType ? params[1] : params[2]);
        const payloadParam = usesLiteralAggregateType ? params[2] : params[3];
        const payload = typeof payloadParam === 'string' ? JSON.parse(payloadParam) : payloadParam;
        const idempotencyKey = String(usesLiteralAggregateType ? params[3] : params[4]);
        if (!outboxRows.some((row) => row.idempotencyKey === idempotencyKey)) {
          outboxRows.push({ eventType, aggregateId, payload, idempotencyKey });
        }
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 1 };
    },
  };

  return {
    queries,
    outboxRows,
    service: {
      async transaction<T>(handler: (client: typeof tx) => Promise<T>) {
        return handler(tx);
      },
    } as unknown as DatabaseService,
  };
}

function currentUser(role: CurrentUser['role'] = 'manager'): CurrentUser {
  return {
    id: '7',
    username: role,
    role,
    roleId: 10,
    permissions: getPermissionsForRole(role),
  };
}

function normalizedSql(queries: Array<{ text: string }>): string {
  return queries.map((query) => normalizeSql(query.text)).join('\n');
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}
