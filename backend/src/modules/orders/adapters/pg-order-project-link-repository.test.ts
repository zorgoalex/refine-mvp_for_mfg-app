import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { PgOrderProjectLinkRepository } from './pg-order-project-link-repository';

describe('PgOrderProjectLinkRepository', () => {
  it('replaces current order project links with idempotency, audit, outbox, and version bump', async () => {
    const database = createDatabase();
    const repository = new PgOrderProjectLinkRepository(database.service);

    const response = await repository.replaceOrderProjects({
      currentUser: currentUser(),
      orderId: 15,
      dto: {
        idempotencyKey: 'order-projects-key-1',
        version: 3,
        primaryProjectId: '11111111-1111-4111-8111-111111111111',
        projects: [
          {
            projectId: '11111111-1111-4111-8111-111111111111',
            relationType: 'main',
            isPrimary: true,
          },
          {
            projectId: '22222222-2222-4222-8222-222222222222',
            relationType: 'secondary',
            isPrimary: false,
          },
        ],
        reason: 'rebalance',
      },
      requestId: 'request-1',
    });

    expect(response).toMatchObject({
      orderId: 15,
      version: 4,
      changed: true,
      primaryProject: { id: '11111111-1111-4111-8111-111111111111' },
      projects: [
        { id: '11111111-1111-4111-8111-111111111111', relationType: 'main', isPrimary: true },
        { id: '22222222-2222-4222-8222-222222222222', relationType: 'secondary', isPrimary: false },
      ],
    });

    const sql = normalizedSql(database.queries);
    expect(sql).toContain('INSERT INTO command_idempotency_keys');
    expect(sql).toContain('FROM orders WHERE order_id = $1 AND delete_flag = false FOR UPDATE');
    expect(sql).toContain('FROM public.project_order_projects pop');
    expect(sql).toContain('valid_to IS NULL');
    expect(sql).toContain('UPDATE public.project_order_projects');
    expect(sql).toContain('INSERT INTO public.project_order_projects');
    expect(sql).toContain('UPDATE orders SET version = version + 1');
    expect(sql).toContain('projects.order_links_changed');
    expect(sql).toContain('UPDATE command_idempotency_keys');
    expect(JSON.stringify(database.queries.map((query) => query.params))).toContain(
      'PROJECT_ORDER_LINKS_CHANGED',
    );
    expect(JSON.stringify(database.queries.map((query) => query.params))).toContain(
      'order-projects-key-1:project_order_links_changed',
    );
  });

  it('replays completed idempotent replace without locking the order again', async () => {
    const database = createDatabase({
      completedResponse: {
        orderId: 15,
        version: 4,
        changed: true,
        primaryProject: null,
        projects: [],
        requestId: 'request-1',
      },
    });
    const repository = new PgOrderProjectLinkRepository(database.service);

    await expect(
      repository.replaceOrderProjects({
        currentUser: currentUser(),
        orderId: 15,
        dto: {
          idempotencyKey: 'order-projects-key-1',
          version: 3,
          primaryProjectId: null,
          projects: [],
          reason: 'same',
        },
        requestId: 'request-1',
      }),
    ).resolves.toMatchObject({ orderId: 15, version: 4 });

    expect(normalizedSql(database.queries)).not.toContain('FROM orders WHERE order_id');
  });
});

interface QueryRecord {
  text: string;
  params: unknown[];
}

function createDatabase(options: { completedResponse?: unknown } = {}) {
  const queries: QueryRecord[] = [];
  let requestHash = '';

  const service = {
    transaction: async <T>(handler: (client: typeof service) => Promise<T>) => handler(service),
    query: async (text: string, params: unknown[] = []) => {
      queries.push({ text, params });
      const normalized = normalizeSql(text);

      if (normalized.startsWith('INSERT INTO command_idempotency_keys')) {
        requestHash = String(params[3]);
        return options.completedResponse ? { rows: [] } : { rows: [{ idempotency_key: params[0], request_hash: requestHash, status: 'processing' }] };
      }
      if (normalized.startsWith('SELECT idempotency_key, request_hash')) {
        return { rows: [{ idempotency_key: params[0], request_hash: requestHash, status: 'completed', response_json: options.completedResponse }] };
      }
      if (normalized.includes('FROM orders WHERE order_id = $1 AND delete_flag = false FOR UPDATE')) {
        return { rows: [{ order_id: 15, version: 3, client_id: 7 }] };
      }
      if (normalized.includes('FROM public.project_order_projects pop')) {
        return {
          rows: [
            {
              link_id: 'old-link',
              project_id: '33333333-3333-4333-8333-333333333333',
              code: 'OLD',
              name: 'Old',
              relation_type: 'main',
              is_primary: true,
              valid_from: '2026-05-01T00:00:00.000Z',
            },
          ],
        };
      }
      if (normalized.startsWith('UPDATE orders SET version = version + 1')) {
        return { rows: [{ version: 4 }] };
      }
      if (normalized.startsWith('INSERT INTO public.project_order_projects')) {
        const projectId = String(params[1]);
        return {
          rows: [{
            link_id: `link-${projectId.slice(0, 4)}`,
            project_id: projectId,
            code: projectId.startsWith('1111') ? 'P1' : 'P2',
            name: projectId.startsWith('1111') ? 'Project 1' : 'Project 2',
            relation_type: params[2],
            is_primary: params[3],
            valid_from: '2026-05-27T00:00:00.000Z',
          }],
        };
      }
      if (normalized.startsWith('INSERT INTO audit_log')) {
        return { rows: [{ audit_id: 'audit-id-1' }] };
      }
      return { rows: [] };
    },
  } as unknown as DatabaseService;

  return { service, queries };
}

function currentUser(): CurrentUser {
  return {
    id: '1',
    username: 'admin',
    role: 'admin',
    roleId: 1,
    permissions: getPermissionsForRole('admin'),
  };
}

function normalizedSql(queries: QueryRecord[]): string {
  return queries.map((query) => normalizeSql(query.text)).join('\n');
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}
