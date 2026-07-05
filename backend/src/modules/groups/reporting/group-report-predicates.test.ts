import { describe, expect, it } from 'vitest';
import { appendGroupReportPredicate, type GroupReportFilter } from './group-report-predicates';

const GROUP_A = '11111111-1111-4111-8111-111111111111';
const GROUP_B = '22222222-2222-4222-8222-222222222222';

describe('appendGroupReportPredicate', () => {
  it('builds a current any-mode EXISTS predicate with parameterized group ids', () => {
    const params: unknown[] = ['open'];
    const filter: GroupReportFilter = {
      mode: 'any',
      temporal: { mode: 'current' },
      groupIds: [GROUP_A, GROUP_B],
    };

    const sql = appendGroupReportPredicate({
      params,
      orderIdExpression: 'o.order_id',
      filter,
    });

    expect(sql).toContain('EXISTS');
    expect(sql).toContain('FROM public.group_order_groups pop_filter');
    expect(sql).toContain('pop_filter.order_id = o.order_id');
    expect(sql).toContain('pop_filter.group_id = ANY($2::uuid[])');
    expect(sql).toContain('pop_filter.valid_to IS NULL');
    expect(params).toEqual(['open', [GROUP_A, GROUP_B]]);
  });

  it('builds a current primary-mode predicate requiring primary membership', () => {
    const params: unknown[] = [];

    const sql = appendGroupReportPredicate({
      params,
      orderIdExpression: 'fact.order_id',
      filter: {
        mode: 'primary',
        temporal: { mode: 'current' },
        groupIds: [GROUP_A],
      },
    });

    expect(sql).toContain('EXISTS');
    expect(sql).toContain('pop_filter.is_primary');
    expect(sql).toContain('pop_filter.group_id = ANY($1::uuid[])');
    expect(params).toEqual([[GROUP_A]]);
  });

  it('builds all-mode as a distinct group count against the same order', () => {
    const params: unknown[] = [];

    const sql = appendGroupReportPredicate({
      params,
      orderIdExpression: 'report_scope.order_id',
      filter: {
        mode: 'all',
        temporal: { mode: 'current' },
        groupIds: [GROUP_A, GROUP_B],
      },
    });

    expect(sql).toContain('SELECT COUNT(DISTINCT pop_filter.group_id)::int');
    expect(sql).toContain('= cardinality($1::uuid[])');
    expect(sql).toContain('pop_filter.group_id = ANY($1::uuid[])');
    expect(params).toEqual([[GROUP_A, GROUP_B]]);
  });

  it('builds none-mode without requiring group ids', () => {
    const params: unknown[] = [];

    const sql = appendGroupReportPredicate({
      params,
      orderIdExpression: 'o.order_id',
      filter: {
        mode: 'none',
        temporal: { mode: 'current' },
      },
    });

    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('pop_filter.order_id = o.order_id');
    expect(sql).toContain('pop_filter.valid_to IS NULL');
    expect(params).toEqual([]);
  });

  it('builds as-of temporal membership with a parameterized timestamp', () => {
    const params: unknown[] = [];

    const sql = appendGroupReportPredicate({
      params,
      orderIdExpression: 'o.order_id',
      filter: {
        mode: 'any',
        temporal: { mode: 'asOf', asOf: '2026-06-01T00:00:00.000Z' },
        groupIds: [GROUP_A],
      },
    });

    expect(sql).toContain('pop_filter.valid_from <= $1::timestamptz');
    expect(sql).toContain("COALESCE(pop_filter.valid_to, 'infinity'::timestamptz) > $1::timestamptz");
    expect(sql).toContain('pop_filter.group_id = ANY($2::uuid[])');
    expect(params).toEqual(['2026-06-01T00:00:00.000Z', [GROUP_A]]);
  });

  it('builds overlap temporal membership with parameterized window bounds', () => {
    const params: unknown[] = [];

    const sql = appendGroupReportPredicate({
      params,
      orderIdExpression: 'o.order_id',
      filter: {
        mode: 'any',
        temporal: {
          mode: 'overlap',
          from: '2026-06-01T00:00:00.000Z',
          to: '2026-07-01T00:00:00.000Z',
        },
        groupIds: [GROUP_A],
      },
    });

    expect(sql).toContain(
      "tstzrange(pop_filter.valid_from, COALESCE(pop_filter.valid_to, 'infinity'::timestamptz), '[)')",
    );
    expect(sql).toContain("tstzrange($1::timestamptz, $2::timestamptz, '[)')");
    expect(sql).toContain('pop_filter.group_id = ANY($3::uuid[])');
    expect(params).toEqual(['2026-06-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', [GROUP_A]]);
  });

  it('builds fact-time membership only from a trusted SQL expression', () => {
    const params: unknown[] = [];

    const sql = appendGroupReportPredicate({
      params,
      orderIdExpression: 'deadline_scope.order_id',
      filter: {
        mode: 'any',
        temporal: { mode: 'factTime', factTimeExpression: 'deadline_scope.deadline_at' },
        groupIds: [GROUP_A],
      },
    });

    expect(sql).toContain('pop_filter.valid_from <= deadline_scope.deadline_at');
    expect(sql).toContain(
      "COALESCE(pop_filter.valid_to, 'infinity'::timestamptz) > deadline_scope.deadline_at",
    );
    expect(sql).toContain('pop_filter.group_id = ANY($1::uuid[])');
    expect(params).toEqual([[GROUP_A]]);
  });

  it('rejects untrusted fact-time expressions', () => {
    expect(() =>
      appendGroupReportPredicate({
        params: [],
        orderIdExpression: 'o.order_id',
        filter: {
          mode: 'any',
          temporal: { mode: 'factTime', factTimeExpression: 'deadline_at); DROP TABLE orders; --' },
          groupIds: [GROUP_A],
        },
      }),
    ).toThrow('factTimeExpression must be a trusted SQL identifier expression');
  });

  it('rejects untrusted order id expressions', () => {
    expect(() =>
      appendGroupReportPredicate({
        params: [],
        orderIdExpression: 'o.order_id); DROP TABLE orders; --',
        filter: {
          mode: 'any',
          temporal: { mode: 'current' },
          groupIds: [GROUP_A],
        },
      }),
    ).toThrow('orderIdExpression must be a trusted SQL identifier expression');
  });

  it('rejects untrusted table aliases', () => {
    expect(() =>
      appendGroupReportPredicate({
        params: [],
        orderIdExpression: 'o.order_id',
        tableAlias: 'pop_filter; DROP TABLE orders; --',
        filter: {
          mode: 'any',
          temporal: { mode: 'current' },
          groupIds: [GROUP_A],
        },
      }),
    ).toThrow('tableAlias must be a trusted SQL identifier');
  });

  it('rejects missing or too many group ids unless mode is none', () => {
    expect(() =>
      appendGroupReportPredicate({
        params: [],
        orderIdExpression: 'o.order_id',
        filter: { mode: 'any', temporal: { mode: 'current' }, groupIds: [] },
      }),
    ).toThrow('groupIds are required unless mode is none');

    expect(() =>
      appendGroupReportPredicate({
        params: [],
        orderIdExpression: 'o.order_id',
        filter: {
          mode: 'any',
          temporal: { mode: 'current' },
          groupIds: Array.from({ length: 51 }, (_, index) =>
            `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
          ),
        },
      }),
    ).toThrow('groupIds supports at most 50 IDs');
  });

  it('supports deadline order-boundary derivation through a scoped CTE order id', () => {
    const params: unknown[] = [];

    const sql = appendGroupReportPredicate({
      params,
      orderIdExpression: 'deadline_scope.order_id',
      filter: {
        mode: 'any',
        temporal: { mode: 'factTime', factTimeExpression: 'deadline_scope.deadline_at' },
        groupIds: [GROUP_A],
      },
    });

    expect(sql).toContain('pop_filter.order_id = deadline_scope.order_id');
    expect(sql).not.toContain(['group', 'links'].join('_'));
    expect(sql).not.toContain('deadline_instance');
  });

  it('supports production report filters at the order boundary without naming production command tables', () => {
    const params: unknown[] = [];

    const sql = appendGroupReportPredicate({
      params,
      orderIdExpression: 'production_scope.order_id',
      filter: {
        mode: 'any',
        temporal: {
          mode: 'overlap',
          from: '2026-06-01T00:00:00.000Z',
          to: '2026-06-02T00:00:00.000Z',
        },
        groupIds: [GROUP_A],
      },
    });

    expect(sql).toContain('pop_filter.order_id = production_scope.order_id');
    expect(sql).toContain('FROM public.group_order_groups pop_filter');
    expect(sql).not.toContain('production_status_events');
    expect(sql).not.toContain('UPDATE');
    expect(sql).not.toContain('INSERT');
  });
});
