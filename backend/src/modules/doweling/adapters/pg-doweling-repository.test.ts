import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
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
      insertedDoweling: { doweling_order_id: 555, doweling_order_name: 'Тест присадка', version: 0 },
    });
    const repo = new PgDowelingRepository(database.service);

    const res = await repo.createDowelingOrder({ currentUser: currentUser(), requestId: 'r', dto });

    expect(res.dowelingOrder).toMatchObject({ dowelingOrderId: 555, dowelingOrderName: 'Тест присадка', version: 0 });
    const sql = normalizedSql(database.queries);
    expect(sql).toContain('SELECT set_session_user($1)');
    expect(sql).toContain('INSERT INTO command_idempotency_keys');
    expect(sql).toContain('INSERT INTO doweling_orders');
    expect(sql).not.toContain('order_doweling_links'); // create-only: never links
    expect(sql.match(/INSERT INTO audit_log/g)).toHaveLength(1);
    expect(sql.match(/INSERT INTO outbox_events/g)).toHaveLength(1);
    expect(sql).toContain('UPDATE command_idempotency_keys SET status =');
  });

  it('audit row carries doweling dims via centralized auditService.record path', async () => {
    const database = createDatabase({
      insertedDoweling: { doweling_order_id: 555, doweling_order_name: 'x', version: 0 },
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
    const base = createDatabase({ insertedDoweling: { doweling_order_id: 1, doweling_order_name: 'x', version: 0 } });
    await new PgDowelingRepository(base.service).createDowelingOrder({ currentUser: currentUser(), requestId: 'r', dto });

    const changed = createDatabase({ insertedDoweling: { doweling_order_id: 2, doweling_order_name: 'x', version: 0 } });
    await new PgDowelingRepository(changed.service).createDowelingOrder({
      currentUser: currentUser(),
      requestId: 'r',
      dto: { ...dto, partsCount: 5 },
    });

    expect(idempotencyHash(base.queries)).not.toBe(idempotencyHash(changed.queries));
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
  } = {},
) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
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

      if (normalized.startsWith('INSERT INTO audit_log')) {
        auditId += 1;
        return { rows: [{ audit_id: `audit-id-${auditId}` }], rowCount: 1 };
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

function currentUser(role: CurrentUser['role'] = 'manager'): CurrentUser {
  return { id: '1', username: role, role, roleId: 1, permissions: getPermissionsForRole(role) };
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
