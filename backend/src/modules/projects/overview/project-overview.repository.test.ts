import { describe, expect, it } from 'vitest';
import { PROJECT_OVERVIEW_OMITTED, type ProjectOverviewQuery } from './project-overview.dto';
import { PgProjectOverviewRepository, UnavailableProjectOverviewRepository } from './project-overview.repository';

describe('PgProjectOverviewRepository', () => {
  it('uses only project/order aggregate SQL and omits private domains', async () => {
    const database = fakeDatabase();
    const repo = new PgProjectOverviewRepository(database);

    const response = await repo.getOverview({
      projectId: projectId(),
      query: {
        temporal: { mode: 'current' },
        filter: { temporalMode: 'current' },
        createdRange: {},
      },
    });

    const sql = database.queries.map((query) => query.text).join('\n');
    expect(sql).toContain('public.project_order_projects');
    expect(sql).not.toMatch(/payment|audit|deadline|production|client_phone|order_details|project_members|users/i);
    expect(response.orders.totalCount).toBe(2);
    expect(response.omitted).toContain('payments');
    expect(response.omitted).toEqual(PROJECT_OVERVIEW_OMITTED);
  });

  it('returns project identity and aggregate DTO shape', async () => {
    const database = fakeDatabase({
      statusRows: [{ status_id: '5', status_name: 'In work', order_count: '3' }],
      relationRows: [{ relation_type: 'main', is_primary: true, order_count: '2' }],
      createdRows: [{ month: '2026-06-01', order_count: '4' }],
    });
    const repo = new PgProjectOverviewRepository(database);
    const query = overviewQuery();

    await expect(repo.getOverview({ projectId: projectId(), query })).resolves.toEqual({
      project: {
        id: projectId(),
        code: 'P7',
        name: 'Project P7',
        description: null,
        status: 'active',
        startsAt: null,
        endsAt: null,
        ownerUserId: 10,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        archivedAt: null,
      },
      orders: {
        totalCount: 2,
        statusCounts: [{ statusId: 5, statusName: 'In work', orderCount: 3 }],
        relationCounts: [{ relationType: 'main', isPrimary: true, orderCount: 2 }],
        createdMonthCounts: [{ month: '2026-06-01', orderCount: 4 }],
      },
      filter: { projectId: projectId(), ...query.filter },
      omitted: PROJECT_OVERVIEW_OMITTED,
    });
  });

  it('throws PROJECT_NOT_FOUND before aggregate work', async () => {
    const database = fakeDatabase({ projectRows: [] });
    const repo = new PgProjectOverviewRepository(database);

    await expect(repo.getOverview({ projectId: projectId(), query: overviewQuery() })).rejects.toMatchObject({
      statusCode: 404,
      code: 'PROJECT_NOT_FOUND',
      details: { projectId: projectId() },
    });
    expect(database.queries).toHaveLength(1);
  });

  it('supports unavailable repository fail-closed behavior', async () => {
    await expect(
      new UnavailableProjectOverviewRepository().getOverview({ projectId: projectId(), query: overviewQuery() }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'DATABASE_UNAVAILABLE',
    });
  });
});

function fakeDatabase({
  projectRows = [projectRow()],
  totalRows = [{ total_count: '2' }],
  statusRows = [],
  relationRows = [],
  createdRows = [],
}: {
  projectRows?: unknown[];
  totalRows?: unknown[];
  statusRows?: unknown[];
  relationRows?: unknown[];
  createdRows?: unknown[];
} = {}) {
  return {
    queries: [] as Array<{ text: string; params: readonly unknown[] }>,
    async query(text: string, params: readonly unknown[] = []) {
      this.queries.push({ text, params });
      if (text.includes('FROM public.project_projects')) return { rows: projectRows };
      if (text.includes('COUNT(*)::int AS total_count')) return { rows: totalRows };
      if (text.includes('JOIN public.order_statuses')) return { rows: statusRows };
      if (text.includes('pop_relation')) return { rows: relationRows };
      return { rows: createdRows };
    },
  };
}

function overviewQuery(): ProjectOverviewQuery {
  return {
    temporal: { mode: 'current' },
    filter: { temporalMode: 'current' },
    createdRange: {},
  };
}

function projectRow() {
  return {
    id: projectId(),
    code: 'P7',
    name: 'Project P7',
    description: null,
    status: 'active',
    starts_at: null,
    ends_at: null,
    owner_user_id: 10,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    archived_at: null,
  };
}

function projectId(): string {
  return '11111111-1111-4111-8111-111111111111';
}
