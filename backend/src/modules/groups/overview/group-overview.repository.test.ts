import { describe, expect, it } from 'vitest';
import { GROUP_OVERVIEW_OMITTED, type GroupOverviewQuery } from './group-overview.dto';
import { PgGroupOverviewRepository, UnavailableGroupOverviewRepository } from './group-overview.repository';

describe('PgGroupOverviewRepository', () => {
  it('uses only group/order aggregate SQL and omits private domains', async () => {
    const database = fakeDatabase();
    const repo = new PgGroupOverviewRepository(database);

    const response = await repo.getOverview({
      groupId: groupId(),
      query: {
        temporal: { mode: 'current' },
        filter: { temporalMode: 'current' },
        createdRange: {},
      },
    });

    const sql = database.queries.map((query) => query.text).join('\n');
    expect(sql).toContain('public.group_order_groups');
    expect(sql).not.toMatch(
      /payment|audit|deadline|production_status_events|client_phone|order_details|group_members|users/i,
    );
    expect(sql).toContain("eligible_order.order_kind = 'production_order'");
    expect(response.orders.totalCount).toBe(2);
    expect(response.omitted).toContain('payments');
    expect(response.omitted).toEqual(GROUP_OVERVIEW_OMITTED);
  });

  it('binds relation count rows to the selected group with a parameter', async () => {
    const database = fakeDatabase();
    const repo = new PgGroupOverviewRepository(database);

    await repo.getOverview({ groupId: groupId(), query: overviewQuery() });

    const relationQuery = database.queries.find((query) => query.text.includes('pop_relation'));
    expect(relationQuery).toBeDefined();
    expect(relationQuery?.text).toMatch(/pop_relation\.group_id = \$\d+::uuid/);
    expect(relationQuery?.text).toContain('pop_relation.valid_to IS NULL');
    expect(relationQuery?.params).toContain(groupId());
  });

  it('uses created range bounds as parameterized inclusive from and exclusive to filters', async () => {
    const database = fakeDatabase();
    const repo = new PgGroupOverviewRepository(database);
    const createdFrom = '2026-05-01T00:00:00.000Z';
    const createdTo = '2026-06-01T00:00:00.000Z';

    await repo.getOverview({
      groupId: groupId(),
      query: {
        temporal: { mode: 'current' },
        filter: { temporalMode: 'current', createdFrom, createdTo },
        createdRange: { from: createdFrom, to: createdTo },
      },
    });

    const createdQuery = database.queries.find((query) => query.text.includes("date_trunc('month'"));
    expect(createdQuery).toBeDefined();
    expect(createdQuery?.text).toContain('o.created_at >= $2::timestamptz');
    expect(createdQuery?.text).toContain('o.created_at < $3::timestamptz');
    expect(createdQuery?.params).toEqual([[groupId()], createdFrom, createdTo]);
  });

  it('returns group identity and aggregate DTO shape', async () => {
    const database = fakeDatabase({
      statusRows: [{ status_id: '5', status_name: 'In work', order_count: '3' }],
      relationRows: [{ relation_type: 'main', is_primary: true, order_count: '2' }],
      createdRows: [{ month: '2026-06-01', order_count: '4' }],
    });
    const repo = new PgGroupOverviewRepository(database);
    const query = overviewQuery();

    await expect(repo.getOverview({ groupId: groupId(), query })).resolves.toEqual({
      group: {
        id: groupId(),
        code: 'P7',
        name: 'Group P7',
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
      linkedEntityCounts: [],
      participants: { currentSummary: [] },
      filter: { groupId: groupId(), ...query.filter },
      omitted: GROUP_OVERVIEW_OMITTED,
    });
  });

  it('throws GROUP_NOT_FOUND before aggregate work', async () => {
    const database = fakeDatabase({ groupRows: [] });
    const repo = new PgGroupOverviewRepository(database);

    await expect(repo.getOverview({ groupId: groupId(), query: overviewQuery() })).rejects.toMatchObject({
      statusCode: 404,
      code: 'GROUP_NOT_FOUND',
      details: { groupId: groupId() },
    });
    expect(database.queries).toHaveLength(1);
  });

  it('supports unavailable repository fail-closed behavior', async () => {
    await expect(
      new UnavailableGroupOverviewRepository().getOverview({ groupId: groupId(), query: overviewQuery() }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'DATABASE_UNAVAILABLE',
    });
  });
});

function fakeDatabase({
  groupRows = [groupRow()],
  totalRows = [{ total_count: '2' }],
  statusRows = [],
  relationRows = [],
  createdRows = [],
}: {
  groupRows?: unknown[];
  totalRows?: unknown[];
  statusRows?: unknown[];
  relationRows?: unknown[];
  createdRows?: unknown[];
} = {}) {
  return {
    queries: [] as Array<{ text: string; params: readonly unknown[] }>,
    async query(text: string, params: readonly unknown[] = []) {
      this.queries.push({ text, params });
      if (text.includes('FROM public.group_groups')) return { rows: groupRows };
      if (text.includes('COUNT(*)::int AS total_count')) return { rows: totalRows };
      if (text.includes('JOIN public.order_statuses')) return { rows: statusRows };
      if (text.includes('pop_relation')) return { rows: relationRows };
      return { rows: createdRows };
    },
  };
}

function overviewQuery(): GroupOverviewQuery {
  return {
    temporal: { mode: 'current' },
    filter: { temporalMode: 'current' },
    createdRange: {},
  };
}

function groupRow() {
  return {
    id: groupId(),
    code: 'P7',
    name: 'Group P7',
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

function groupId(): string {
  return '11111111-1111-4111-8111-111111111111';
}
