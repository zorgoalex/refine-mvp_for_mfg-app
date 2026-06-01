import { describe, expect, it } from 'vitest';
import { PgProjectOrderReportRepository, UnavailableProjectOrderReportRepository } from './project-order-report.repository';

describe('PgProjectOrderReportRepository', () => {
  it('uses project_order_projects predicate against orders.order_id', async () => {
    const database = fakeDatabase();
    const repo = new PgProjectOrderReportRepository(database);

    await repo.listOrderIds({
      page: 1,
      pageSize: 25,
      filter: {
        mode: 'any',
        projectIds: ['11111111-1111-4111-8111-111111111111'],
        temporal: { mode: 'current' },
      },
    });

    const sql = database.queries.map((query) => query.text).join('\n');
    expect(database.queries).toHaveLength(2);
    expect(database.queries[0].text).toContain('COUNT');
    expect(database.queries[0].text).toContain('FROM public.orders o');
    expect(sql).toContain('FROM public.project_order_projects');
    expect(sql).toContain('pop_filter.order_id = o.order_id');
    expect(sql).not.toContain('payments');
    expect(sql).not.toContain('deadline');
    expect(sql).not.toContain('production_status_events');
    expect(sql).not.toContain('audit');
  });

  it('parameterizes filters, limit, and offset and returns narrow response data', async () => {
    const database = fakeDatabase({
      countRows: [{ total: '2' }],
      listRows: [{ order_id: '20' }, { order_id: '10' }],
    });
    const repo = new PgProjectOrderReportRepository(database);

    await expect(
      repo.listOrderIds({
        page: 2,
        pageSize: 10,
        filter: {
          mode: 'all',
          projectIds: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
          temporal: { mode: 'asOf', asOf: '2026-06-01T00:00:00.000Z' },
        },
      }),
    ).resolves.toEqual({
      data: [{ orderId: 20 }, { orderId: 10 }],
      pagination: { page: 2, pageSize: 10, total: 2, totalPages: 1 },
      filter: {
        mode: 'all',
        projectIds: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
        temporal: { mode: 'asOf', asOf: '2026-06-01T00:00:00.000Z' },
      },
    });

    expect(database.queries[0].params).toEqual([
      '2026-06-01T00:00:00.000Z',
      ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
    ]);
    expect(database.queries[1].params).toEqual([
      '2026-06-01T00:00:00.000Z',
      ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
      10,
      10,
    ]);
    expect(database.queries[1].text).toContain('LIMIT $3 OFFSET $4');
  });

  it('supports unavailable repository fail-closed behavior', async () => {
    await expect(new UnavailableProjectOrderReportRepository().listOrderIds()).rejects.toMatchObject({
      statusCode: 503,
      code: 'DATABASE_UNAVAILABLE',
    });
  });
});

function fakeDatabase({
  countRows = [{ total: 0 }],
  listRows = [],
}: {
  countRows?: Array<{ total: string | number }>;
  listRows?: Array<{ order_id: string | number }>;
} = {}) {
  return {
    queries: [] as Array<{ text: string; params: readonly unknown[] }>,
    async query(text: string, params: readonly unknown[] = []) {
      this.queries.push({ text, params });
      if (text.trim().startsWith('SELECT COUNT(*)::int AS total')) return { rows: countRows };
      return { rows: listRows };
    },
  };
}
