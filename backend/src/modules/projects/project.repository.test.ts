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
