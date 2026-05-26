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
});

class FakeProjectDatabase {
  readonly queries: Array<{ text: string; params: readonly unknown[] }> = [];
  private readonly queryQueue: Array<QueryResult<QueryResultRow>>;

  constructor(queryResults: Array<{ rows: QueryResultRow[] }>) {
    this.queryQueue = queryResults.map((result) => toQueryResult(result.rows));
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    this.queries.push({ text, params });
    return (this.queryQueue.shift() ?? toQueryResult([])) as QueryResult<T>;
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
