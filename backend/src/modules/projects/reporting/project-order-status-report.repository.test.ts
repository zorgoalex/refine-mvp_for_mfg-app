import { describe, expect, it } from 'vitest';
import {
  PgProjectOrderStatusReportRepository,
  UnavailableProjectOrderStatusReportRepository,
} from './project-order-status-report.repository';

describe('PgProjectOrderStatusReportRepository', () => {
  it('uses project_order_projects predicate against orders.order_id and aggregates by order status', async () => {
    const database = fakeDatabase();
    const repo = new PgProjectOrderStatusReportRepository(database);

    await repo.listOrderStatusCounts({
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
    expect(sql).toContain('JOIN public.order_statuses os ON os.order_status_id = o.order_status_id');
    expect(sql).toContain('FROM public.project_order_projects');
    expect(sql).toContain('pop_filter.order_id = o.order_id');
    expect(sql).toContain('GROUP BY os.order_status_id, os.order_status_name, os.sort_order');
    expect(sql).not.toContain('payments');
    expect(sql).not.toContain('deadline');
    expect(sql).not.toContain('production_status_events');
    expect(sql).not.toContain('audit');
    expect(sql).not.toContain('project_members');
  });

  it('parameterizes filters and returns aggregate-only response data', async () => {
    const database = fakeDatabase({
      rows: [
        { status_id: '1', status_name: 'Новый', order_count: '2' },
        { status_id: '2', status_name: 'В работе', order_count: '5' },
      ],
    });
    const repo = new PgProjectOrderStatusReportRepository(database);

    await expect(
      repo.listOrderStatusCounts({
        predicateFilter: {
          mode: 'all',
          projectIds: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
          temporal: { mode: 'asOf', asOf: '2026-06-01T00:00:00.000Z' },
        },
        responseFilter: {
          projectMode: 'all',
          projectIds: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
          temporalMode: 'asOf',
          asOf: '2026-06-01T00:00:00.000Z',
        },
      }),
    ).resolves.toEqual({
      data: [
        { statusId: 1, statusName: 'Новый', orderCount: 2 },
        { statusId: 2, statusName: 'В работе', orderCount: 5 },
      ],
      filter: {
        projectMode: 'all',
        projectIds: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
        temporalMode: 'asOf',
        asOf: '2026-06-01T00:00:00.000Z',
      },
    });

    expect(database.queries[0].params).toEqual([
      '2026-06-01T00:00:00.000Z',
      ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
    ]);
  });

  it('supports unavailable repository fail-closed behavior', async () => {
    await expect(new UnavailableProjectOrderStatusReportRepository().listOrderStatusCounts()).rejects.toMatchObject({
      statusCode: 503,
      code: 'DATABASE_UNAVAILABLE',
    });
  });
});

function fakeDatabase({
  rows = [],
}: {
  rows?: Array<{ status_id: string | number; status_name: string; order_count: string | number }>;
} = {}) {
  return {
    queries: [] as Array<{ text: string; params: readonly unknown[] }>,
    async query(text: string, params: readonly unknown[] = []) {
      this.queries.push({ text, params });
      return { rows };
    },
  };
}
