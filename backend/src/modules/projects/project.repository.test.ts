import { describe, expect, it } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import { PgProjectRepository } from './project.repository';

describe('PgProjectRepository', () => {
  it('lists projects with parameterized filters and pagination', async () => {
    const database = new FakeProjectDatabase([
      { rows: [{ total: 1 }] },
      {
        rows: [
          projectRow({
            id: '11111111-1111-4111-8111-111111111111',
            code: 'PRJ-001',
            name: 'Kitchen rollout',
          }),
        ],
      },
    ]);
    const repository = new PgProjectRepository(database);

    await expect(
      repository.listProjects({
        page: 2,
        pageSize: 10,
        search: 'kitchen',
        status: 'active',
        ownerUserId: 7,
      }),
    ).resolves.toMatchObject({
      data: [{ id: '11111111-1111-4111-8111-111111111111', code: 'PRJ-001' }],
      pagination: { page: 2, pageSize: 10, total: 1, totalPages: 1 },
    });

    expect(database.queries[0].text).toContain('FROM public.project_projects p');
    expect(database.queries[0].text).toContain('p.archived_at IS NULL');
    expect(database.queries[0].text).toContain('(p.code ILIKE $1 OR p.name ILIKE $1)');
    expect(database.queries[0].text).toContain('p.status = $2');
    expect(database.queries[0].text).toContain('p.owner_user_id = $3');
    expect(database.queries[1].params).toEqual(['%kitchen%', 'active', 7, 10, 10]);
  });

  it('looks up active projects with a bounded parameterized query', async () => {
    const database = new FakeProjectDatabase([
      { rows: [projectRow({ code: 'PRJ-002', name: 'Office' })] },
    ]);
    const repository = new PgProjectRepository(database);

    await expect(repository.lookupProjects({ search: 'office', limit: 5 })).resolves.toEqual({
      data: [{ id: '00000000-0000-4000-8000-000000000000', code: 'PRJ-002', name: 'Office', status: 'active' }],
    });

    expect(database.queries[0].text).toContain('p.archived_at IS NULL');
    expect(database.queries[0].text).toContain("p.status <> 'archived'");
    expect(database.queries[0].params).toEqual(['%office%', 5]);
  });

  it('gets a project by UUID with a parameterized query', async () => {
    const database = new FakeProjectDatabase([{ rows: [projectRow({ code: 'PRJ-003' })] }]);
    const repository = new PgProjectRepository(database);

    await expect(
      repository.getProjectById('22222222-2222-4222-8222-222222222222'),
    ).resolves.toMatchObject({ code: 'PRJ-003' });

    expect(database.queries[0].text).toContain('WHERE p.id = $1');
    expect(database.queries[0].params).toEqual(['22222222-2222-4222-8222-222222222222']);
  });

  it('creates a project transactionally and writes actor/request audit metadata', async () => {
    const database = new FakeProjectDatabase([
      { rows: [projectRow({ id: '33333333-3333-4333-8333-333333333333', code: 'PRJ-004' })] },
      { rows: [] },
    ]);
    const repository = new PgProjectRepository(database);

    await expect(
      repository.createProject({
        currentUser: currentUser(),
        dto: {
          code: 'PRJ-004',
          name: 'New project',
          status: 'draft',
          startsAt: '2026-05-01',
          endsAt: '2026-05-02',
          ownerUserId: 9,
          metadata: { source: 'test' },
        },
        requestId: 'req-create-project',
      }),
    ).resolves.toMatchObject({ id: '33333333-3333-4333-8333-333333333333', code: 'PRJ-004' });

    expect(database.transactionCalls).toBe(1);
    expect(database.queries[0].text).toContain('INSERT INTO public.project_projects');
    expect(database.queries[0].text).toContain('RETURNING');
    expect(database.queries[0].params).toEqual([
      'PRJ-004',
      'New project',
      null,
      'draft',
      '2026-05-01',
      '2026-05-02',
      9,
      JSON.stringify({ source: 'test' }),
      42,
    ]);
    expect(database.queries[1].text).toContain('INSERT INTO audit_log');
    expect(database.queries[1].params).toEqual([
      'projects.create',
      '33333333-3333-4333-8333-333333333333',
      42,
      'admin_user',
      'admin',
      'req-create-project',
      null,
      expect.any(String),
      expect.any(String),
    ]);
  });

  it('updates a project transactionally with before and after audit snapshots', async () => {
    const before = projectRow({ name: 'Old project' });
    const after = projectRow({ name: 'Updated project', status: 'paused' });
    const database = new FakeProjectDatabase([{ rows: [before] }, { rows: [after] }, { rows: [] }]);
    const repository = new PgProjectRepository(database);

    await expect(
      repository.updateProject({
        currentUser: currentUser(),
        projectId: '00000000-0000-4000-8000-000000000000',
        dto: { name: 'Updated project', status: 'paused' },
        requestId: 'req-update-project',
      }),
    ).resolves.toMatchObject({ name: 'Updated project', status: 'paused' });

    expect(database.transactionCalls).toBe(1);
    expect(database.queries[0].text).toContain('FOR UPDATE');
    expect(database.queries[0].params).toEqual(['00000000-0000-4000-8000-000000000000']);
    expect(database.queries[1].text).toContain('UPDATE public.project_projects p');
    expect(database.queries[1].text).toContain('name = $1');
    expect(database.queries[1].text).toContain('status = $2');
    expect(database.queries[1].params).toEqual(['Updated project', 'paused', '00000000-0000-4000-8000-000000000000']);
    expect(database.queries[2].text).toContain('INSERT INTO audit_log');
    expect(database.queries[2].params[0]).toBe('projects.update');
    expect(database.queries[2].params[5]).toBe('req-update-project');
    expect(JSON.parse(database.queries[2].params[6] as string)).toMatchObject({ name: 'Old project' });
    expect(JSON.parse(database.queries[2].params[7] as string)).toMatchObject({ name: 'Updated project' });
  });

  it('rejects updates to archived projects before issuing UPDATE', async () => {
    const database = new FakeProjectDatabase([
      { rows: [projectRow({ status: 'archived', archived_at: '2026-05-03T00:00:00.000Z' })] },
    ]);
    const repository = new PgProjectRepository(database);

    await expect(
      repository.updateProject({
        currentUser: currentUser(),
        projectId: '00000000-0000-4000-8000-000000000000',
        dto: { name: 'Updated project' },
        requestId: 'req-update-archived',
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PROJECT_ARCHIVED',
    });

    expect(database.queries).toHaveLength(1);
    expect(database.queries[0].text).toContain('FOR UPDATE');
  });

  it('validates partial date updates against the locked existing row', async () => {
    const database = new FakeProjectDatabase([
      { rows: [projectRow({ starts_at: '2026-05-10', ends_at: '2026-05-20' })] },
    ]);
    const repository = new PgProjectRepository(database);

    await expect(
      repository.updateProject({
        currentUser: currentUser(),
        projectId: '00000000-0000-4000-8000-000000000000',
        dto: { endsAt: '2026-05-09' },
        requestId: 'req-update-dates',
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
    });

    expect(database.queries).toHaveLength(1);
    expect(database.queries[0].text).toContain('FOR UPDATE');
  });

  it('maps duplicate active project code database errors to conflict responses', async () => {
    const database = new FakeProjectDatabase([
      pgError('23505', 'ux_projects_code_active'),
    ]);
    const repository = new PgProjectRepository(database);

    await expect(
      repository.createProject({
        currentUser: currentUser(),
        dto: { code: 'PRJ-001', name: 'Project' },
        requestId: 'req-duplicate',
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PROJECT_CODE_CONFLICT',
      details: { field: 'code' },
    });
  });

  it('maps project date check database errors to validation responses', async () => {
    const database = new FakeProjectDatabase([
      { rows: [projectRow({ starts_at: '2026-05-10', ends_at: '2026-05-20' })] },
      pgError('23514', 'chk_projects_dates'),
    ]);
    const repository = new PgProjectRepository(database);

    await expect(
      repository.updateProject({
        currentUser: currentUser(),
        projectId: '00000000-0000-4000-8000-000000000000',
        dto: { startsAt: '2026-05-11' },
        requestId: 'req-date-check',
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      details: { field: 'dates' },
    });
  });

  it('maps missing owner FK errors on create to validation responses', async () => {
    const database = new FakeProjectDatabase([
      pgError('23503', 'project_projects_owner_user_id_fkey'),
    ]);
    const repository = new PgProjectRepository(database);

    await expect(
      repository.createProject({
        currentUser: currentUser(),
        dto: { code: 'PRJ-005', name: 'Project', ownerUserId: 999 },
        requestId: 'req-owner-create',
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      details: {
        field: 'ownerUserId',
        errors: [{ field: 'ownerUserId', message: 'ownerUserId must reference an existing user' }],
      },
    });
  });

  it('maps missing owner FK errors on update to validation responses', async () => {
    const database = new FakeProjectDatabase([
      { rows: [projectRow()] },
      pgError('23503', 'project_projects_owner_user_id_fkey'),
    ]);
    const repository = new PgProjectRepository(database);

    await expect(
      repository.updateProject({
        currentUser: currentUser(),
        projectId: '00000000-0000-4000-8000-000000000000',
        dto: { ownerUserId: 999 },
        requestId: 'req-owner-update',
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      details: {
        field: 'ownerUserId',
        errors: [{ field: 'ownerUserId', message: 'ownerUserId must reference an existing user' }],
      },
    });
  });

  it('archives a project as a soft delete and writes audit metadata', async () => {
    const before = projectRow({ status: 'active', archived_at: null });
    const after = projectRow({ status: 'archived', archived_at: '2026-05-03T00:00:00.000Z' });
    const database = new FakeProjectDatabase([{ rows: [before] }, { rows: [after] }, { rows: [] }]);
    const repository = new PgProjectRepository(database);

    await expect(
      repository.archiveProject({
        currentUser: currentUser(),
        projectId: '00000000-0000-4000-8000-000000000000',
        requestId: 'req-archive-project',
      }),
    ).resolves.toMatchObject({ status: 'archived', archivedAt: '2026-05-03T00:00:00.000Z' });

    expect(database.transactionCalls).toBe(1);
    expect(database.queries[1].text).toContain("status = 'archived'");
    expect(database.queries[1].text).toContain('archived_at = COALESCE(p.archived_at, now())');
    expect(database.queries[1].text).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(database.queries[2].text).toContain('INSERT INTO audit_log');
    expect(database.queries[2].params[0]).toBe('projects.archive');
    expect(database.queries[2].params[5]).toBe('req-archive-project');
  });

  it('lists current project members through user and employee read-model joins', async () => {
    const database = new FakeProjectDatabase([
      {
        rows: [
          projectMemberRow({
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            user_id: 7,
            username: 'member_user',
            employee_id: 11,
            display_name: 'Member User',
            role: 'manager',
            metadata: { allocation: 'lead' },
          }),
        ],
      },
    ]);
    const repository = new PgProjectRepository(database);

    await expect(
      repository.listProjectMembers({
        currentUser: currentUser(),
        projectId: '11111111-1111-4111-8111-111111111111',
        requestId: 'req-members-list',
      }),
    ).resolves.toEqual({
      projectId: '11111111-1111-4111-8111-111111111111',
      members: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          userId: 7,
          username: 'member_user',
          employeeId: 11,
          displayName: 'Member User',
          role: 'manager',
          validFrom: '2026-05-27T00:00:00.000Z',
          metadata: { allocation: 'lead' },
        },
      ],
      requestId: 'req-members-list',
    });

    expect(database.queries[0].text).toContain('FROM public.project_members pm');
    expect(database.queries[0].text).toContain('INNER JOIN users u ON u.user_id = pm.user_id');
    expect(database.queries[0].text).toContain('LEFT JOIN employees e ON e.employee_id = u.employee_id');
    expect(database.queries[0].text).toContain('pm.valid_to IS NULL');
    expect(database.queries[0].params).toEqual(['11111111-1111-4111-8111-111111111111']);
  });

  it('replaces current members by closing removed rows and inserting new rows with audit outbox and idempotency', async () => {
    const database = new FakeProjectDatabase([
      { rows: [{ idempotency_key: 'members-key-1', request_hash: 'hash', status: 'processing', response_json: null }] },
      { rows: [projectRow({ id: '11111111-1111-4111-8111-111111111111' })] },
      { rows: [projectMemberRow({ id: 'old-member-id', user_id: 5, role: 'manager' })] },
      { rows: [{ user_id: 7 }] },
      { rows: [] },
      { rows: [projectMemberRow({ id: 'new-member-id', user_id: 7, role: 'manager' })] },
      { rows: [{ audit_id: 'audit-1' }] },
      // bridge: user:5 (removed, no employee_id), user:7 (added, no employee_id)
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
    ]);
    const repository = new PgProjectRepository(database);

    await expect(
      repository.replaceProjectMembers({
        currentUser: currentUser(),
        projectId: '11111111-1111-4111-8111-111111111111',
        dto: {
          idempotencyKey: 'members-key-1',
          members: [{ userId: 7, role: 'manager' }],
          reason: 'staffing',
        },
        requestId: 'req-members-replace',
      }),
    ).resolves.toMatchObject({
      projectId: '11111111-1111-4111-8111-111111111111',
      changed: true,
      auditId: 'audit-1',
      members: [{ userId: 7, role: 'manager' }],
      requestId: 'req-members-replace',
    });

    expect(database.transactionCalls).toBe(1);
    expect(database.queries[0].text).toContain("command_name, actor_user_id, entity_type, entity_id, request_hash, status");
    expect(database.queries[0].text).toContain("'projects.members.replace'");
    expect(database.queries[1].text).toContain('FROM public.project_projects p');
    expect(database.queries[1].text).toContain('FOR UPDATE');
    expect(database.queries[2].text).toContain('FROM public.project_members pm');
    expect(database.queries[2].text).toContain('pm.valid_to IS NULL');
    expect(database.queries[3].text).toContain('FROM users');
    expect(database.queries[3].text).toContain('WHERE user_id = ANY($1::int[])');
    expect(database.queries[4].text).toContain('UPDATE public.project_members');
    expect(database.queries[4].text).toContain('valid_to = now()');
    expect(database.queries[4].text).toContain('ended_by = $2');
    expect(database.queries[4].text).toContain('end_reason = $3');
    expect(database.queries[5].text).toContain('INSERT INTO public.project_members');
    expect(database.queries[5].params).toEqual(['11111111-1111-4111-8111-111111111111', 7, 'manager', '{}', 42]);
    expect(database.queries[6].text).toContain('INSERT INTO audit_log');
    expect(database.queries[6].params[0]).toBe('projects.members_changed');
    // bridge inserts at [7] and [8] (user:5 removed, user:7 added)
    expect(database.queries[9].text).toContain('INSERT INTO outbox_events');
    expect(database.queries[10].text).toContain('UPDATE command_idempotency_keys');
  });

  it('writes bridge rows for added and removed members on the same tx, skipping null employee ids', async () => {
    // before: user 5, employeeId 11 (has employee); after: user 7, employeeId null (no employee)
    const database = new FakeProjectDatabase([
      { rows: [{ idempotency_key: 'bridge-key', request_hash: 'hash', status: 'processing', response_json: null }] },
      { rows: [projectRow({ id: '11111111-1111-4111-8111-111111111111' })] },
      { rows: [projectMemberRow({ id: 'old-id', user_id: 5, employee_id: 11, role: 'manager' })] },
      { rows: [{ user_id: 7 }] },
      { rows: [] },
      { rows: [projectMemberRow({ id: 'new-id', user_id: 7, employee_id: null, role: 'manager' })] },
      { rows: [{ audit_id: 'audit-bridge' }] },
      // bridge: user:5 (removed), employee:11 (removed), user:7 (added) — no employee row for user:7
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
    ]);
    const repository = new PgProjectRepository(database);

    await repository.replaceProjectMembers({
      currentUser: currentUser(),
      projectId: '11111111-1111-4111-8111-111111111111',
      dto: {
        idempotencyKey: 'bridge-key',
        members: [{ userId: 7, role: 'manager' }],
        reason: null,
      },
      requestId: 'req-bridge',
    });

    const bridgeQueries = database.queries.filter((q) =>
      q.text.includes('INSERT INTO audit_log_related_entity'),
    );
    // removed member: user:5 + employee:11; added member: user:7 (employeeId null → no employee row)
    expect(bridgeQueries).toHaveLength(3);

    const bridgeParams = bridgeQueries.map((q) => ({ entityType: q.params[1], entityId: q.params[2] }));
    expect(bridgeParams).toContainEqual({ entityType: 'user', entityId: 5 });
    expect(bridgeParams).toContainEqual({ entityType: 'employee', entityId: 11 });
    expect(bridgeParams).toContainEqual({ entityType: 'user', entityId: 7 });
    // all bridge rows carry the parent audit_id
    expect(bridgeQueries.every((q) => q.params[0] === 'audit-bridge')).toBe(true);
    // no employee bridge row for user:7 (employeeId is null)
    expect(bridgeParams.filter((p) => p.entityType === 'employee')).toHaveLength(1);
  });

  it('treats member metadata changes as temporal replacement instead of in-place rewrite', async () => {
    const database = new FakeProjectDatabase([
      { rows: [{ idempotency_key: 'members-metadata-key', request_hash: 'hash', status: 'processing', response_json: null }] },
      { rows: [projectRow({ id: '11111111-1111-4111-8111-111111111111' })] },
      { rows: [projectMemberRow({ id: 'old-member-id', user_id: 7, role: 'manager', metadata: { allocation: 'old' } })] },
      { rows: [{ user_id: 7 }] },
      { rows: [] },
      { rows: [projectMemberRow({ id: 'new-member-id', user_id: 7, role: 'manager', metadata: { allocation: 'lead' } })] },
      { rows: [{ audit_id: 'audit-1' }] },
      { rows: [] },
      { rows: [] },
    ]);
    const repository = new PgProjectRepository(database);

    await expect(
      repository.replaceProjectMembers({
        currentUser: currentUser(),
        projectId: '11111111-1111-4111-8111-111111111111',
        dto: {
          idempotencyKey: 'members-metadata-key',
          members: [{ userId: 7, role: 'manager', metadata: { allocation: 'lead' } }],
          reason: 'allocation change',
        },
        requestId: 'req-members-metadata',
      }),
    ).resolves.toMatchObject({
      changed: true,
      members: [{ userId: 7, role: 'manager', metadata: { allocation: 'lead' } }],
    });

    expect(database.queries[4].text).toContain('UPDATE public.project_members');
    expect(database.queries[5].text).toContain('INSERT INTO public.project_members');
    expect(database.queries[5].params).toEqual([
      '11111111-1111-4111-8111-111111111111',
      7,
      'manager',
      JSON.stringify({ allocation: 'lead' }),
      42,
    ]);
  });
});

class FakeProjectDatabase {
  readonly queries: Array<{ text: string; params: readonly unknown[] }> = [];
  transactionCalls = 0;
  private readonly queryQueue: Array<QueryResult<QueryResultRow> | Error>;

  constructor(queryResults: Array<{ rows: QueryResultRow[] } | Error>) {
    this.queryQueue = queryResults.map((result) => result instanceof Error ? result : toQueryResult(result.rows));
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    this.queries.push({ text, params });
    const result = this.queryQueue.shift() ?? toQueryResult([]);
    if (result instanceof Error) {
      throw result;
    }
    return result as QueryResult<T>;
  }

  async transaction<T>(handler: (client: FakeProjectDatabase) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    return handler(this);
  }
}

function toQueryResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

function projectRow(overrides: Partial<QueryResultRow> = {}): QueryResultRow {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    code: 'PRJ-001',
    name: 'Project',
    description: null,
    status: 'active',
    starts_at: null,
    ends_at: null,
    owner_user_id: null,
    metadata: {},
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
    archived_at: null,
    created_by: null,
    ...overrides,
  };
}

function projectMemberRow(overrides: Partial<QueryResultRow> = {}): QueryResultRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    user_id: 7,
    username: 'member_user',
    employee_id: null,
    display_name: null,
    role: 'participant',
    valid_from: '2026-05-27T00:00:00.000Z',
    metadata: {},
    ...overrides,
  };
}

function currentUser() {
  return {
    id: '42',
    username: 'admin_user',
    role: 'admin' as const,
    roleId: 1,
    permissions: ['projects.create', 'projects.update', 'projects.archive', 'projects.view'],
  };
}

function pgError(code: string, constraint: string): Error & { code: string; constraint: string } {
  return Object.assign(new Error(`Postgres ${code}`), { code, constraint });
}
