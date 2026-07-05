import { describe, expect, it } from 'vitest';
import {
  PgGroupOrderRelationCountsReportRepository,
  UnavailableGroupOrderRelationCountsReportRepository,
} from './group-order-relation-counts-report.repository';

describe('PgGroupOrderRelationCountsReportRepository', () => {
  it('uses the group_order_groups predicate and returns only relation aggregate fields', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const repository = new PgGroupOrderRelationCountsReportRepository({
      async query(sql: string, params: unknown[]) {
        queries.push({ sql, params });
        return { rows: [{ relation_type: 'main', is_primary: true, order_count: '3' }] };
      },
    });

    await expect(
      repository.listOrderRelationCounts({
        predicateFilter: {
          mode: 'any',
          groupIds: ['11111111-1111-4111-8111-111111111111'],
          temporal: { mode: 'current' },
        },
        responseFilter: {
          groupMode: 'any',
          groupIds: ['11111111-1111-4111-8111-111111111111'],
          temporalMode: 'current',
        },
      }),
    ).resolves.toEqual({
      data: [{ relationType: 'main', isPrimary: true, orderCount: 3 }],
      filter: {
        groupMode: 'any',
        groupIds: ['11111111-1111-4111-8111-111111111111'],
        temporalMode: 'current',
      },
    });

    const sql = queries[0].sql;
    expect(sql).toContain('FROM public.orders o');
    expect(sql).toContain('FROM public.group_order_groups pop_filter');
    expect(sql).toContain('JOIN public.group_order_groups pop_relation ON pop_relation.order_id = o.order_id');
    expect(sql).toContain('pop_relation.valid_to IS NULL');
    expect(sql).toContain('GROUP BY pop_relation.relation_type, pop_relation.is_primary');
    expect(sql).not.toMatch(/payment|amount|client|deadline|production_status_events|group_members|audit/i);
  });

  it('keeps counted relation rows current-only when the group scope is as-of historical', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const repository = new PgGroupOrderRelationCountsReportRepository({
      async query(sql: string, params: unknown[]) {
        queries.push({ sql, params });
        return { rows: [] };
      },
    });

    await repository.listOrderRelationCounts({
      predicateFilter: {
        mode: 'any',
        groupIds: ['11111111-1111-4111-8111-111111111111'],
        temporal: { mode: 'asOf', asOf: '2026-06-02T00:00:00.000Z' },
      },
      responseFilter: {
        groupMode: 'any',
        groupIds: ['11111111-1111-4111-8111-111111111111'],
        temporalMode: 'asOf',
        asOf: '2026-06-02T00:00:00.000Z',
      },
    });

    const sql = queries[0].sql;
    expect(sql).toContain('pop_filter.valid_from <= $1::timestamptz');
    expect(sql).toContain("COALESCE(pop_filter.valid_to, 'infinity'::timestamptz) > $1::timestamptz");
    expect(sql).toContain('pop_relation.valid_to IS NULL');
    expect(sql).not.toContain('pop_relation.valid_from <= $');
    expect(sql).not.toContain('COALESCE(pop_relation.valid_to');
  });

  it('keeps counted relation rows current-only when the group scope is an overlap window', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const repository = new PgGroupOrderRelationCountsReportRepository({
      async query(sql: string, params: unknown[]) {
        queries.push({ sql, params });
        return { rows: [] };
      },
    });

    await repository.listOrderRelationCounts({
      predicateFilter: {
        mode: 'any',
        groupIds: ['11111111-1111-4111-8111-111111111111'],
        temporal: {
          mode: 'overlap',
          from: '2026-06-01T00:00:00.000Z',
          to: '2026-06-02T00:00:00.000Z',
        },
      },
      responseFilter: {
        groupMode: 'any',
        groupIds: ['11111111-1111-4111-8111-111111111111'],
        temporalMode: 'overlap',
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-06-02T00:00:00.000Z',
      },
    });

    const sql = queries[0].sql;
    expect(sql).toContain("tstzrange(pop_filter.valid_from, COALESCE(pop_filter.valid_to, 'infinity'::timestamptz), '[)'");
    expect(sql).toContain('pop_relation.valid_to IS NULL');
    expect(sql).not.toContain('tstzrange(pop_relation.valid_from');
  });

  it('uses historical none-mode only for the scoped order set while counting current relation rows', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const repository = new PgGroupOrderRelationCountsReportRepository({
      async query(sql: string, params: unknown[]) {
        queries.push({ sql, params });
        return { rows: [] };
      },
    });

    await repository.listOrderRelationCounts({
      predicateFilter: {
        mode: 'none',
        temporal: { mode: 'asOf', asOf: '2026-06-02T00:00:00.000Z' },
      },
      responseFilter: {
        groupMode: 'none',
        temporalMode: 'asOf',
        asOf: '2026-06-02T00:00:00.000Z',
      },
    });

    const asOfSql = queries[0].sql;
    expect(asOfSql).toContain('NOT EXISTS (');
    expect(asOfSql).toContain('FROM public.group_order_groups pop_filter');
    expect(asOfSql).toContain('pop_filter.valid_from <= $1::timestamptz');
    expect(asOfSql).toContain("COALESCE(pop_filter.valid_to, 'infinity'::timestamptz) > $1::timestamptz");
    expect(asOfSql).toContain('pop_relation.valid_to IS NULL');
    expect(asOfSql).not.toContain('pop_relation.valid_from <= $');

    await repository.listOrderRelationCounts({
      predicateFilter: {
        mode: 'none',
        temporal: {
          mode: 'overlap',
          from: '2026-06-01T00:00:00.000Z',
          to: '2026-06-02T00:00:00.000Z',
        },
      },
      responseFilter: {
        groupMode: 'none',
        temporalMode: 'overlap',
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-06-02T00:00:00.000Z',
      },
    });

    const overlapSql = queries[1].sql;
    expect(overlapSql).toContain('NOT EXISTS (');
    expect(overlapSql).toContain("tstzrange(pop_filter.valid_from, COALESCE(pop_filter.valid_to, 'infinity'::timestamptz), '[)'");
    expect(overlapSql).toContain('pop_relation.valid_to IS NULL');
    expect(overlapSql).not.toContain('tstzrange(pop_relation.valid_from');
  });

  it('fails closed when relation_type is outside the published enum', async () => {
    const repository = new PgGroupOrderRelationCountsReportRepository({
      async query() {
        return { rows: [{ relation_type: 'unexpected', is_primary: false, order_count: '1' }] };
      },
    });

    await expect(
      repository.listOrderRelationCounts({
        predicateFilter: { mode: 'none', temporal: { mode: 'current' } },
        responseFilter: { groupMode: 'none', temporalMode: 'current' },
      }),
    ).rejects.toMatchObject({
      statusCode: 500,
      code: 'GROUP_REPORT_RELATION_TYPE_INVALID',
    });
  });

  it('fails closed when the database is unavailable', async () => {
    await expect(new UnavailableGroupOrderRelationCountsReportRepository().listOrderRelationCounts()).rejects.toMatchObject({
      statusCode: 503,
      code: 'DATABASE_UNAVAILABLE',
    });
  });
});
