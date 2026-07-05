import { describe, expect, it } from 'vitest';
import {
  PgGroupOrderCreatedMonthCountsReportRepository,
  UnavailableGroupOrderCreatedMonthCountsReportRepository,
} from './group-order-created-month-counts-report.repository';

describe('PgGroupOrderCreatedMonthCountsReportRepository', () => {
  it('uses orders.created_at as the fact timestamp and returns only month aggregates', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const repository = new PgGroupOrderCreatedMonthCountsReportRepository({
      async query(sql: string, params: unknown[]) {
        queries.push({ sql, params });
        return { rows: [{ month: '2026-01-01', order_count: '7' }] };
      },
    });

    await expect(
      repository.listOrderCreatedMonthCounts({
        predicateFilter: {
          mode: 'any',
          groupIds: ['11111111-1111-4111-8111-111111111111'],
          temporal: { mode: 'current' },
        },
        responseFilter: {
          groupMode: 'any',
          groupIds: ['11111111-1111-4111-8111-111111111111'],
          temporalMode: 'current',
          createdFrom: '2026-01-01T00:00:00.000Z',
          createdTo: '2026-06-01T00:00:00.000Z',
        },
        createdRange: {
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-06-01T00:00:00.000Z',
        },
      }),
    ).resolves.toEqual({
      data: [{ month: '2026-01-01', orderCount: 7 }],
      filter: {
        groupMode: 'any',
        groupIds: ['11111111-1111-4111-8111-111111111111'],
        temporalMode: 'current',
        createdFrom: '2026-01-01T00:00:00.000Z',
        createdTo: '2026-06-01T00:00:00.000Z',
      },
    });

    const sql = queries[0].sql;
    expect(sql).toContain('FROM public.orders o');
    expect(sql).toContain("date_trunc('month', o.created_at AT TIME ZONE 'UTC')");
    expect(sql).toContain('o.created_at >= $');
    expect(sql).toContain('o.created_at < $');
    expect(sql).toContain('FROM public.group_order_groups pop_filter');
    expect(sql).not.toMatch(/payment|amount|client|deadline|production_status_events|group_members|audit|order_details/i);
    expect(queries[0].params).toEqual([
      ['11111111-1111-4111-8111-111111111111'],
      '2026-01-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
    ]);
  });

  it('fails closed when the database is unavailable', async () => {
    await expect(
      new UnavailableGroupOrderCreatedMonthCountsReportRepository().listOrderCreatedMonthCounts(),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'DATABASE_UNAVAILABLE',
    });
  });

  it('keeps group temporal filtering separate from the orders.created_at fact window', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const repository = new PgGroupOrderCreatedMonthCountsReportRepository({
      async query(sql: string, params: unknown[]) {
        queries.push({ sql, params });
        return { rows: [] };
      },
    });

    await repository.listOrderCreatedMonthCounts({
      predicateFilter: {
        mode: 'any',
        groupIds: ['11111111-1111-4111-8111-111111111111'],
        temporal: { mode: 'asOf', asOf: '2026-05-15T00:00:00.000Z' },
      },
      responseFilter: {
        groupMode: 'any',
        groupIds: ['11111111-1111-4111-8111-111111111111'],
        temporalMode: 'asOf',
        asOf: '2026-05-15T00:00:00.000Z',
        createdFrom: '2026-01-01T00:00:00.000Z',
        createdTo: '2026-06-01T00:00:00.000Z',
      },
      createdRange: {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-06-01T00:00:00.000Z',
      },
    });

    const sql = queries[0].sql;
    expect(sql).toContain('pop_filter.valid_from <= $1::timestamptz');
    expect(sql).toContain("COALESCE(pop_filter.valid_to, 'infinity'::timestamptz) > $1::timestamptz");
    expect(sql).toContain('o.created_at >= $3::timestamptz');
    expect(sql).toContain('o.created_at < $4::timestamptz');
    expect(sql).toContain("date_trunc('month', o.created_at AT TIME ZONE 'UTC')");
    expect(queries[0].params).toEqual([
      '2026-05-15T00:00:00.000Z',
      ['11111111-1111-4111-8111-111111111111'],
      '2026-01-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
    ]);
  });

  it('groups month buckets in UTC rather than the database session timezone', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const repository = new PgGroupOrderCreatedMonthCountsReportRepository({
      async query(sql: string, params: unknown[]) {
        queries.push({ sql, params });
        return { rows: [] };
      },
    });

    await repository.listOrderCreatedMonthCounts({
      predicateFilter: { mode: 'none', temporal: { mode: 'current' } },
      responseFilter: { groupMode: 'none', temporalMode: 'current' },
      createdRange: {},
    });

    const sql = queries[0].sql;
    expect(sql).toContain("to_char(date_trunc('month', o.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-01')");
    expect(sql).toContain("GROUP BY date_trunc('month', o.created_at AT TIME ZONE 'UTC')");
    expect(sql).toContain("ORDER BY date_trunc('month', o.created_at AT TIME ZONE 'UTC') ASC");
    expect(sql).not.toContain("date_trunc('month', o.created_at)");
  });
});
