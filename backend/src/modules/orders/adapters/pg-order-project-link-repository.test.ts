import { describe, expect, it } from 'vitest';
import type { QueryResultRow } from 'pg';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { PgOrderGroupLinkRepository } from './pg-order-group-link-repository';

const PROJECT_1 = '11111111-1111-4111-8111-111111111111';
const PROJECT_2 = '22222222-2222-4222-8222-222222222222';
const PROJECT_OLD = '33333333-3333-4333-8333-333333333333';
const PROJECT_ARCHIVED = '44444444-4444-4444-8444-444444444444';
const PROJECT_MISSING = '55555555-5555-4555-8555-555555555555';
const PROJECT_ALPHA = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const PROJECT_ALPHA_UPPERCASE = PROJECT_ALPHA.toUpperCase();

describe('PgOrderGroupLinkRepository', () => {
  it('rejects stale versions before project validation or domain writes', async () => {
    const database = createDatabase();
    const repository = new PgOrderGroupLinkRepository(database.service);

    await expect(repository.replaceOrderProjects(replaceCommand({
      dto: { version: 2, projects: [{ projectId: PROJECT_1, relationType: 'main', isPrimary: true }], primaryProjectId: PROJECT_1 },
    }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'ORDER_VERSION_CONFLICT',
    });

    expect(database.state.order.version).toBe(3);
    expect(database.domainWrites()).toEqual([]);
    expect(database.queries.some((query) => normalizeSql(query.text).includes('FROM public.group_groups'))).toBe(false);
  });

  it('rejects missing submitted project ids with a controlled error before inserting links', async () => {
    const database = createDatabase();
    const repository = new PgOrderGroupLinkRepository(database.service);

    await expect(repository.replaceOrderProjects(replaceCommand({
      dto: { projects: [{ projectId: PROJECT_MISSING, relationType: 'main', isPrimary: true }], primaryProjectId: PROJECT_MISSING },
    }))).rejects.toMatchObject({
      statusCode: 404,
      code: 'PROJECT_NOT_FOUND',
      details: { projectId: PROJECT_MISSING },
    });

    expect(database.state.order.version).toBe(3);
    expect(database.domainWrites()).toEqual([]);
  });

  it('rejects archived submitted projects with a controlled error before inserting links', async () => {
    const database = createDatabase();
    const repository = new PgOrderGroupLinkRepository(database.service);

    await expect(repository.replaceOrderProjects(replaceCommand({
      dto: { projects: [{ projectId: PROJECT_ARCHIVED, relationType: 'main', isPrimary: true }], primaryProjectId: PROJECT_ARCHIVED },
    }))).rejects.toMatchObject({
      statusCode: 422,
      code: 'PROJECT_ARCHIVED',
      details: { projectId: PROJECT_ARCHIVED },
    });

    expect(database.state.order.version).toBe(3);
    expect(database.domainWrites()).toEqual([]);
  });

  it('canonicalizes uppercase submitted project ids before validation and insertion', async () => {
    const database = createDatabase();
    const repository = new PgOrderGroupLinkRepository(database.service);

    const response = await repository.replaceOrderProjects(replaceCommand({
      dto: {
        idempotencyKey: 'uppercase-project-key',
        projects: [{ projectId: PROJECT_ALPHA_UPPERCASE, relationType: 'main', isPrimary: true }],
        primaryProjectId: PROJECT_ALPHA_UPPERCASE,
      },
    }));

    expect(response).toMatchObject({
      version: 4,
      changed: true,
      primaryProject: { id: PROJECT_ALPHA },
      projects: [{ id: PROJECT_ALPHA, relationType: 'main', isPrimary: true }],
    });
    expect(database.state.links.filter((link) => link.validTo === null)).toMatchObject([
      { projectId: PROJECT_ALPHA, relationType: 'main', isPrimary: true },
    ]);
    expect(database.queries.find((query) => normalizeSql(query.text).includes('FROM public.group_groups'))?.params[0])
      .toEqual([PROJECT_ALPHA]);
  });

  it('rejects duplicate project relation links regardless of primary flag', async () => {
    const database = createDatabase();
    const repository = new PgOrderGroupLinkRepository(database.service);

    await expect(repository.replaceOrderProjects(replaceCommand({
      dto: {
        idempotencyKey: 'duplicate-primary-key',
        projects: [
          { projectId: PROJECT_1, relationType: 'main', isPrimary: true },
          { projectId: PROJECT_1.toUpperCase(), relationType: 'main', isPrimary: false },
        ],
        primaryProjectId: null,
      },
    }))).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      details: {
        errors: [{ field: 'projects', message: 'Duplicate project/relation link' }],
      },
    });

    expect(database.queries).toHaveLength(0);
    expect(database.state.transactions).toBe(0);
  });

  it('completes and replays a no-op replace without duplicate rows, version bump, audit, or outbox', async () => {
    const database = createDatabase();
    database.state.links = [currentLink({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      projectId: PROJECT_1,
      relationType: 'main',
      isPrimary: true,
    })];
    const repository = new PgOrderGroupLinkRepository(database.service);

    const command = replaceCommand({
      dto: {
        idempotencyKey: 'no-op-key',
        projects: [{ projectId: PROJECT_1, relationType: 'main', isPrimary: true }],
        primaryProjectId: PROJECT_1,
        reason: 'same',
      },
    });

    const first = await repository.replaceOrderProjects(command);
    const writesAfterFirst = [...database.state.writes];
    const queryCountAfterFirst = database.queries.length;
    const second = await repository.replaceOrderProjects(command);

    expect(first).toMatchObject({ orderId: 15, version: 3, changed: false });
    expect(second).toEqual(first);
    expect(database.state.order.version).toBe(3);
    expect(database.state.links).toHaveLength(1);
    expect(database.state.auditRows).toHaveLength(0);
    expect(database.state.outboxRows).toHaveLength(0);
    expect(writesAfterFirst).toEqual(['complete-idempotency']);
    expect(database.state.writes).toEqual(writesAfterFirst);
    expect(normalizedSql(database.queries.slice(queryCountAfterFirst))).toContain('FROM orders WHERE order_id = $1 AND delete_flag = false FOR UPDATE');
  });

  it('denies completed idempotency replay when the order is no longer in update scope', async () => {
    const database = createDatabase();
    database.state.order.managerUserId = 99;
    const repository = new PgOrderGroupLinkRepository(database.service);
    const command = replaceCommand({
      currentUser: scopedUser({
        id: '99',
        role: 'manager',
        permissions: ['orders.view', 'orders.update', 'groups.manage_links'],
      }),
      dto: {
        idempotencyKey: 'replay-scope-key',
        projects: [{ projectId: PROJECT_1, relationType: 'main', isPrimary: true }],
        primaryProjectId: PROJECT_1,
      },
    });

    await repository.replaceOrderProjects(command);
    const writesAfterCompletion = [...database.state.writes];
    database.state.order.managerUserId = 7;

    await expect(repository.replaceOrderProjects(command)).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['orders.update'] },
    });

    expect(database.state.writes).toEqual(writesAfterCompletion);
  });

  it('returns conflict when an idempotency key is reused with a different payload', async () => {
    const database = createDatabase();
    const repository = new PgOrderGroupLinkRepository(database.service);
    const command = replaceCommand({
      dto: {
        idempotencyKey: 'reused-key',
        projects: [{ projectId: PROJECT_1, relationType: 'main', isPrimary: true }],
        primaryProjectId: PROJECT_1,
      },
    });

    await repository.replaceOrderProjects(command);

    await expect(repository.replaceOrderProjects(replaceCommand({
      dto: {
        idempotencyKey: 'reused-key',
        projects: [{ projectId: PROJECT_2, relationType: 'main', isPrimary: true }],
        primaryProjectId: PROJECT_2,
      },
    }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('returns conflict for processing and failed idempotency keys', async () => {
    const processing = createDatabase({ existingIdempotencyStatus: 'processing' });
    const failed = createDatabase({ existingIdempotencyStatus: 'failed' });

    await expect(new PgOrderGroupLinkRepository(processing.service).replaceOrderProjects(replaceCommand({
      dto: { idempotencyKey: 'processing-key' },
    }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_IN_PROGRESS',
    });

    await expect(new PgOrderGroupLinkRepository(failed.service).replaceOrderProjects(replaceCommand({
      dto: { idempotencyKey: 'failed-key' },
    }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_FAILED',
    });

    expect(processing.domainWrites()).toEqual([]);
    expect(failed.domainWrites()).toEqual([]);
  });

  it('hands off the primary project by closing old links and inserting the new primary once', async () => {
    const database = createDatabase();
    database.state.links = [currentLink({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      projectId: PROJECT_OLD,
      relationType: 'main',
      isPrimary: true,
      validFrom: '2026-05-01T00:00:00.000Z',
    })];
    const repository = new PgOrderGroupLinkRepository(database.service);
    const command = replaceCommand({
      dto: {
        idempotencyKey: 'handoff-key',
        projects: [{ projectId: PROJECT_1, relationType: 'main', isPrimary: true }],
        primaryProjectId: PROJECT_1,
        reason: 'handoff',
      },
    });

    const first = await repository.replaceOrderProjects(command);
    const second = await repository.replaceOrderProjects(command);

    expect(first).toMatchObject({
      orderId: 15,
      version: 4,
      changed: true,
      primaryProject: { id: PROJECT_1 },
    });
    expect(second).toEqual(first);
    expect(database.state.order.version).toBe(4);
    expect(database.state.links.filter((link) => link.validTo === null)).toMatchObject([
      { projectId: PROJECT_1, relationType: 'main', isPrimary: true },
    ]);
    expect(database.state.links.find((link) => link.projectId === PROJECT_OLD)).toMatchObject({
      validTo: expect.any(String),
      endedBy: 1,
      endReason: 'handoff',
    });
    expect(database.state.auditRows).toHaveLength(1);
    expect(database.state.outboxRows).toHaveLength(1);
    expect(database.state.writes.filter((write) => write === 'insert-link')).toHaveLength(1);
    expect(database.state.writes.filter((write) => write === 'audit')).toHaveLength(1);
    expect(database.state.writes.filter((write) => write === 'outbox')).toHaveLength(1);
  });

  it('replaces current order project links with idempotency, audit, outbox, and version bump', async () => {
    const database = createDatabase();
    database.state.links = [currentLink({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      projectId: PROJECT_OLD,
      relationType: 'main',
      isPrimary: true,
    })];
    const repository = new PgOrderGroupLinkRepository(database.service);

    const response = await repository.replaceOrderProjects(replaceCommand({
      dto: {
        idempotencyKey: 'order-projects-key-1',
        primaryProjectId: PROJECT_1,
        projects: [
          { projectId: PROJECT_1, relationType: 'main', isPrimary: true },
          { projectId: PROJECT_2, relationType: 'secondary', isPrimary: false },
        ],
        reason: 'rebalance',
      },
    }));

    expect(response).toMatchObject({
      orderId: 15,
      version: 4,
      changed: true,
      primaryProject: { id: PROJECT_1 },
      projects: [
        { id: PROJECT_1, relationType: 'main', isPrimary: true },
        { id: PROJECT_2, relationType: 'secondary', isPrimary: false },
      ],
    });
    expect(database.state.links.filter((link) => link.validTo === null)).toHaveLength(2);
    expect(database.state.auditRows).toHaveLength(1);
    expect(database.state.outboxRows).toMatchObject([
      {
        eventType: 'GROUP_ORDER_LINKS_CHANGED',
        idempotencyKey: 'order-projects-key-1:group_order_links_changed',
      },
    ]);
    expect(database.state.outboxRows[0].payload).toMatchObject({
      addedGroupIds: [PROJECT_1, PROJECT_2],
      removedGroupIds: [PROJECT_OLD],
      recipientVisibilityPolicy: 'group_participants_must_pass_base_entity_visibility',
      facts: [
        { factKey: `order:15:group:${PROJECT_1}:added`, orderId: '15', groupId: PROJECT_1, action: 'added' },
        { factKey: `order:15:group:${PROJECT_2}:added`, orderId: '15', groupId: PROJECT_2, action: 'added' },
        { factKey: `order:15:group:${PROJECT_OLD}:removed`, orderId: '15', groupId: PROJECT_OLD, action: 'removed' },
      ],
    });
  });

  it('denies GET when the order is outside the user view scope before returning links', async () => {
    const database = createDatabase();
    database.state.order.createdByUserId = 7;
    database.state.order.managerUserId = 7;
    database.state.links = [currentLink({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      projectId: PROJECT_1,
      relationType: 'main',
      isPrimary: true,
    })];
    const repository = new PgOrderGroupLinkRepository(database.service);

    await expect(repository.getOrderProjects({
      currentUser: scopedUser({ id: '99', role: 'manager', permissions: ['orders.view'] }),
      orderId: 15,
      requestId: 'request-denied-get',
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['orders.view'] },
    });

    expect(database.queries).toHaveLength(1);
    expect(normalizeSql(database.queries[0].text)).toContain('FROM orders');
  });

  it('denies PUT when the order is outside the user update scope before writing links', async () => {
    const database = createDatabase();
    database.state.order.createdByUserId = 7;
    database.state.order.managerUserId = 7;
    const repository = new PgOrderGroupLinkRepository(database.service);

    await expect(repository.replaceOrderProjects(replaceCommand({
      currentUser: scopedUser({
        id: '99',
        role: 'manager',
        permissions: ['orders.view', 'orders.update', 'groups.manage_links'],
      }),
      dto: {
        idempotencyKey: 'denied-put-key',
        projects: [{ projectId: PROJECT_1, relationType: 'main', isPrimary: true }],
        primaryProjectId: PROJECT_1,
      },
    }))).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['orders.update'] },
    });

    expect(database.domainWrites()).toEqual([]);
    expect(database.state.links).toHaveLength(0);
  });
});

interface QueryRecord {
  text: string;
  params: unknown[];
}

interface ProjectState {
  id: string;
  code: string;
  name: string;
  status: 'active' | 'archived';
  archivedAt: string | null;
}

interface LinkState {
  id: string;
  orderId: number;
  projectId: string;
  relationType: string;
  isPrimary: boolean;
  validFrom: string;
  validTo: string | null;
  endedBy: number | null;
  endReason: string | null;
}

interface IdempotencyState {
  requestHash: string;
  status: 'processing' | 'completed' | 'failed';
  responseJson: unknown;
}

interface FakeState {
  order: { orderId: number; version: number; clientId: number; createdByUserId: number | null; managerUserId: number | null };
  projects: Map<string, ProjectState>;
  links: LinkState[];
  idempotency: Map<string, IdempotencyState>;
  auditRows: unknown[];
  outboxRows: Array<{ eventType: string; aggregateId: string; payload: unknown; idempotencyKey: string }>;
  writes: string[];
  nextLink: number;
  transactions: number;
}

function createDatabase(options: { existingIdempotencyStatus?: 'processing' | 'failed' } = {}) {
  const queries: QueryRecord[] = [];
  const state: FakeState = {
    order: { orderId: 15, version: 3, clientId: 7, createdByUserId: 1, managerUserId: 1 },
    projects: new Map([
      [PROJECT_1, project(PROJECT_1, 'P1', 'Project 1')],
      [PROJECT_2, project(PROJECT_2, 'P2', 'Project 2')],
      [PROJECT_OLD, project(PROJECT_OLD, 'OLD', 'Old Project')],
      [PROJECT_ARCHIVED, project(PROJECT_ARCHIVED, 'ARC', 'Archived Project', 'archived', '2026-05-02T00:00:00.000Z')],
      [PROJECT_ALPHA, project(PROJECT_ALPHA, 'ALPHA', 'Alpha Project')],
    ]),
    links: [],
    idempotency: new Map(),
    auditRows: [],
    outboxRows: [],
    writes: [],
    nextLink: 1,
    transactions: 0,
  };

  const service = {
    transaction: async <T>(handler: (client: typeof service) => Promise<T>) => {
      state.transactions += 1;
      return handler(service);
    },
    query: async <T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) => {
      queries.push({ text, params });
      const normalized = normalizeSql(text);

      if (normalized.startsWith('INSERT INTO command_idempotency_keys')) {
        const key = String(params[0]);
        const requestHash = String(params[3]);
        if (options.existingIdempotencyStatus) {
          state.idempotency.set(key, {
            requestHash,
            status: options.existingIdempotencyStatus,
            responseJson: null,
          });
          return rows<T>([]);
        }
        if (state.idempotency.has(key)) return rows<T>([]);
        state.idempotency.set(key, { requestHash, status: 'processing', responseJson: null });
        return rows<T>([{ idempotency_key: key, request_hash: requestHash, status: 'processing', response_json: null }]);
      }

      if (normalized.startsWith('SELECT idempotency_key, request_hash')) {
        const key = String(params[0]);
        const row = state.idempotency.get(key);
        return rows<T>(row ? [{
          idempotency_key: key,
          request_hash: row.requestHash,
          status: row.status,
          response_json: row.responseJson,
        }] : []);
      }

      if (normalized.includes('FROM orders WHERE order_id = $1 AND delete_flag = false FOR UPDATE')) {
        return rows<T>([{
          order_id: state.order.orderId,
          version: state.order.version,
          client_id: state.order.clientId,
          created_by: state.order.createdByUserId,
          manager_id: state.order.managerUserId,
        }]);
      }

      if (normalized.includes('FROM orders') && normalized.includes('WHERE order_id = $1 AND delete_flag = false')) {
        return rows<T>([{
          order_id: state.order.orderId,
          version: state.order.version,
          client_id: state.order.clientId,
          created_by: state.order.createdByUserId,
          manager_id: state.order.managerUserId,
        }]);
      }

      if (normalized.includes('FROM public.group_groups') && normalized.includes('WHERE id = ANY($1::uuid[])')) {
        const ids = params[0] as string[];
        return rows<T>(ids.flatMap((id) => {
          const row = state.projects.get(id.toLowerCase());
          return row ? [{
            id: row.id,
            status: row.status,
            archived_at: row.archivedAt,
          }] : [];
        }));
      }

      if (normalized.includes('FROM public.group_order_groups pop')) {
        return rows<T>(state.links
          .filter((link) => link.orderId === Number(params[0]) && link.validTo === null)
          .map((link) => linkRow(link, state.projects))
          .sort(compareLinkRows));
      }

      if (normalized.startsWith('UPDATE public.group_order_groups')) {
        state.writes.push('close-link');
        const ids = params[0] as string[];
        for (const link of state.links) {
          if (ids.includes(link.id) && link.validTo === null) {
            link.validTo = '2026-05-27T00:00:00.000Z';
            link.endedBy = params[1] as number | null;
            link.endReason = params[2] as string | null;
          }
        }
        return rows<T>([]);
      }

      if (normalized.startsWith('INSERT INTO public.group_order_groups')) {
        state.writes.push('insert-link');
        const projectId = String(params[1]);
        const link: LinkState = currentLink({
          id: `10000000-0000-4000-8000-${String(state.nextLink).padStart(12, '0')}`,
          projectId,
          relationType: String(params[2]),
          isPrimary: Boolean(params[3]),
          validFrom: '2026-05-27T00:00:00.000Z',
        });
        state.nextLink += 1;
        state.links.push(link);
        return rows<T>([linkRow(link, state.projects)]);
      }

      if (normalized.startsWith('UPDATE orders SET version = version + 1')) {
        state.writes.push('bump-version');
        state.order.version += 1;
        return rows<T>([{ version: state.order.version }]);
      }

      if (normalized.startsWith('INSERT INTO audit_log')) {
        state.writes.push('audit');
        const audit = { audit_id: `audit-${state.auditRows.length + 1}` };
        state.auditRows.push({ params, audit });
        return rows<T>([audit]);
      }

      if (normalized.startsWith('INSERT INTO outbox_events')) {
        state.writes.push('outbox');
        const idempotencyKey = String(params[3]);
        if (!state.outboxRows.some((row) => row.idempotencyKey === idempotencyKey)) {
          state.outboxRows.push({
            eventType: String(params[0]),
            aggregateId: String(params[1]),
            payload: JSON.parse(String(params[2])),
            idempotencyKey,
          });
        }
        return rows<T>([]);
      }

      if (normalized.startsWith('UPDATE command_idempotency_keys')) {
        state.writes.push('complete-idempotency');
        const key = String(params[0]);
        const row = state.idempotency.get(key);
        if (row) {
          row.status = 'completed';
          row.responseJson = JSON.parse(String(params[1]));
        }
        return rows<T>([]);
      }

      return rows<T>([]);
    },
  } as unknown as DatabaseService;

  return {
    service,
    queries,
    state,
    domainWrites: () => state.writes.filter((write) => write !== 'complete-idempotency'),
  };
}

function replaceCommand(overrides: {
  currentUser?: CurrentUser;
  dto?: {
    idempotencyKey?: string;
    version?: number;
    primaryProjectId?: string | null;
    projects?: Array<{ projectId: string; relationType: 'main' | 'secondary'; isPrimary: boolean }>;
    reason?: string | null;
  };
} = {}) {
  const dto = overrides.dto ?? {};
  return {
    currentUser: overrides.currentUser ?? currentUser(),
    orderId: 15,
    dto: {
      idempotencyKey: dto.idempotencyKey ?? 'order-projects-key-1',
      version: dto.version ?? 3,
      primaryProjectId: 'primaryProjectId' in dto ? dto.primaryProjectId : PROJECT_1,
      projects: dto.projects ?? [{ projectId: PROJECT_1, relationType: 'main', isPrimary: true }],
      reason: dto.reason ?? 'rebalance',
    },
    requestId: 'request-1',
  };
}

function scopedUser(input: {
  id: string;
  role: CurrentUser['role'];
  permissions: CurrentUser['permissions'];
}): CurrentUser {
  return {
    id: input.id,
    username: `${input.role}-${input.id}`,
    role: input.role,
    roleId: 0,
    permissions: input.permissions,
  };
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

function project(
  id: string,
  code: string,
  name: string,
  status: 'active' | 'archived' = 'active',
  archivedAt: string | null = null,
): ProjectState {
  return { id, code, name, status, archivedAt };
}

function currentLink(input: {
  id: string;
  projectId: string;
  relationType: string;
  isPrimary: boolean;
  validFrom?: string;
}): LinkState {
  return {
    id: input.id,
    orderId: 15,
    projectId: input.projectId,
    relationType: input.relationType,
    isPrimary: input.isPrimary,
    validFrom: input.validFrom ?? '2026-05-10T00:00:00.000Z',
    validTo: null,
    endedBy: null,
    endReason: null,
  };
}

function linkRow(link: LinkState, projects: Map<string, ProjectState>): QueryResultRow {
  const projectState = projects.get(link.projectId);
  return {
    link_id: link.id,
    group_id: link.projectId,
    code: projectState?.code ?? 'P',
    name: projectState?.name ?? 'Project',
    relation_type: link.relationType,
    is_primary: link.isPrimary,
    valid_from: link.validFrom,
  };
}

function compareLinkRows(left: QueryResultRow, right: QueryResultRow): number {
  if (left.is_primary !== right.is_primary) return left.is_primary ? -1 : 1;
  const byRelation = String(left.relation_type).localeCompare(String(right.relation_type));
  if (byRelation !== 0) return byRelation;
  return String(left.name).localeCompare(String(right.name)) || String(left.code).localeCompare(String(right.code));
}

function rows<T extends QueryResultRow>(value: QueryResultRow[]): { rows: T[] } {
  return { rows: value as T[] };
}

function normalizedSql(queries: QueryRecord[]): string {
  return queries.map((query) => normalizeSql(query.text)).join('\n');
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}
