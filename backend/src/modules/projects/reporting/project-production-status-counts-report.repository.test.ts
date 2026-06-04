import { describe, expect, it } from 'vitest';
import {
  PgProjectProductionStatusCountsReportRepository,
  UnavailableProjectProductionStatusCountsReportRepository,
} from './project-production-status-counts-report.repository';

describe('PgProjectProductionStatusCountsReportRepository', () => {
  it('aggregates by current orders.production_status_id and project_order_projects predicate', async () => {
    const database = fakeDatabase();
    const repo = new PgProjectProductionStatusCountsReportRepository(database);

    await repo.listProductionStatusCounts({
      predicateFilter: {
        mode: 'any',
        projectIds: ['11111111-1111-4111-8111-111111111111'],
        temporal: { mode: 'current' },
      },
      responseFilter: {
        projectMode: 'any',
        projectIds: ['11111111-1111-4111-8111-111111111111'],
        temporalMode: 'current',
      },
    });

    const sql = database.queries.map((query) => query.text).join('\n');
    expect(database.queries).toHaveLength(1);
    expect(sql).toContain('COUNT(*)::int AS order_count');
    expect(sql).toContain('FROM public.orders o');
    expect(sql).toContain('LEFT JOIN public.production_statuses ps ON ps.production_status_id = o.production_status_id');
    expect(sql).toContain('FROM public.project_order_projects');
    expect(sql).toContain('pop_filter.order_id = o.order_id');
    expect(sql).toContain('GROUP BY ps.production_status_id, ps.production_status_code, ps.production_status_name, ps.sort_order');
    expect(sql).toContain("COALESCE(ps.production_status_name, 'Без статуса') AS production_status_name");
    expect(sql).not.toContain('production_status_events');
    expect(sql).not.toContain('payments');
    expect(sql).not.toContain('deadline');
    expect(sql).not.toContain('audit');
    expect(sql).not.toContain('project_members');
  });

  it('returns aggregate-only response data including unassigned status bucket', async () => {
    const database = fakeDatabase({
      rows: [
        {
          production_status_id: '3',
          production_status_code: 'cutting',
          production_status_name: 'Раскрой',
          order_count: '7',
        },
        {
          production_status_id: null,
          production_status_code: null,
          production_status_name: 'Без статуса',
          order_count: '2',
        },
      ],
    });
    const repo = new PgProjectProductionStatusCountsReportRepository(database);

    await expect(
      repo.listProductionStatusCounts({
        predicateFilter: { mode: 'none', temporal: { mode: 'current' } },
        responseFilter: { projectMode: 'none', temporalMode: 'current' },
      }),
    ).resolves.toEqual({
      data: [
        { productionStatusId: 3, productionStatusCode: 'cutting', productionStatusName: 'Раскрой', orderCount: 7 },
        { productionStatusId: null, productionStatusCode: null, productionStatusName: 'Без статуса', orderCount: 2 },
      ],
      filter: { projectMode: 'none', temporalMode: 'current' },
    });
  });

  it('supports unavailable repository fail-closed behavior', async () => {
    await expect(
      new UnavailableProjectProductionStatusCountsReportRepository().listProductionStatusCounts(),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'DATABASE_UNAVAILABLE',
    });
  });
});

function fakeDatabase({
  rows = [],
}: {
  rows?: Array<{
    production_status_id: string | number | null;
    production_status_code: string | null;
    production_status_name: string;
    order_count: string | number;
  }>;
} = {}) {
  return {
    queries: [] as Array<{ text: string; params: readonly unknown[] }>,
    async query(text: string, params: readonly unknown[] = []) {
      this.queries.push({ text, params });
      return { rows };
    },
  };
}
