import { describe, expect, it } from 'vitest';
import type { GroupDeadlineStatusCountsReportQuery } from './group-deadline-status-counts-report.dto';
import {
  buildGroupDeadlineStatusCountsSql,
  PgGroupDeadlineStatusCountsReportRepository,
  UnavailableGroupDeadlineStatusCountsReportRepository,
} from './group-deadline-status-counts-report.repository';

const GROUP_A = '11111111-1111-4111-8111-111111111111';
const GROUP_B = '22222222-2222-4222-8222-222222222222';

describe('buildGroupDeadlineStatusCountsSql', () => {
  it('builds effective attribution with explicit deadline links replacing derived order attribution', () => {
    const { text, params } = buildGroupDeadlineStatusCountsSql(reportQuery({ mode: 'any', groupIds: [GROUP_A] }));

    expect(params).toEqual([[GROUP_A], 'any']);
    expect(text).toContain('FROM public.deadline_instances d');
    expect(text).toContain('JOIN public.group_entity_links pel');
    expect(text).toContain("pel.entity_type_code = 'deadline_instance'");
    expect(text).toContain('pel.entity_id_text = d.deadline_id::text');
    expect(text).not.toContain('entity_id_text::uuid');
    expect(text).toContain('JOIN public.group_order_groups pop');
    expect(text).toContain('JOIN public.order_workshops ow');
    expect(text).toContain('effective_deadline_groups AS');
    expect(text).toContain('UNION\n  SELECT ddp.deadline_id');
    expect(text).toContain('WHERE NOT EXISTS');
    expect(text).toContain('COUNT(DISTINCT d.deadline_id)::int AS deadline_count');
    expect(text).toContain('GROUP BY d.status');
    expect(text).not.toContain('client');
    expect(text).not.toContain('payments');
    expect(text).not.toContain('audit');
    expect(text).not.toContain('notifications');
    expect(text).not.toContain('outbox');
    expect(text).not.toContain('metadata');
    expect(text).not.toContain('action_executions');
  });

  it('builds any all and none predicates over effective attribution only', () => {
    expect(buildGroupDeadlineStatusCountsSql(reportQuery({ mode: 'any', groupIds: [GROUP_A] })).text).toContain(
      'EXISTS (\n  SELECT 1\n  FROM effective_deadline_groups edp',
    );
    expect(
      buildGroupDeadlineStatusCountsSql(reportQuery({ mode: 'all', groupIds: [GROUP_A, GROUP_B] })).text,
    ).toContain('= cardinality($1::uuid[])');
    expect(buildGroupDeadlineStatusCountsSql(reportQuery({ mode: 'none' })).text).toContain(
      'NOT EXISTS (\n  SELECT 1\n  FROM effective_deadline_groups edp',
    );
  });
});

describe('PgGroupDeadlineStatusCountsReportRepository', () => {
  it('returns aggregate-only deadline status counts', async () => {
    const database = fakeDatabase({
      rows: [
        { deadline_status: 'active', deadline_count: '3' },
        { deadline_status: 'expired', deadline_count: '1' },
      ],
    });
    const repo = new PgGroupDeadlineStatusCountsReportRepository(database);

    await expect(repo.listDeadlineStatusCounts(reportQuery({ mode: 'none' }))).resolves.toEqual({
      data: [
        { deadlineStatus: 'active', deadlineCount: 3 },
        { deadlineStatus: 'expired', deadlineCount: 1 },
      ],
      filter: { groupMode: 'none', temporalMode: 'current' },
    });
  });

  it('supports unavailable repository fail-closed behavior', async () => {
    await expect(
      new UnavailableGroupDeadlineStatusCountsReportRepository().listDeadlineStatusCounts(),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'DATABASE_UNAVAILABLE',
    });
  });
});

function reportQuery(input: { mode: 'none' } | { mode: 'any' | 'all'; groupIds: string[] }): GroupDeadlineStatusCountsReportQuery {
  if (input.mode === 'none') {
    return {
      predicateFilter: { mode: 'none', temporal: { mode: 'current' } },
      responseFilter: { groupMode: 'none', temporalMode: 'current' },
    };
  }

  return {
    predicateFilter: { mode: input.mode, groupIds: input.groupIds, temporal: { mode: 'current' } },
    responseFilter: { groupMode: input.mode, groupIds: input.groupIds, temporalMode: 'current' },
  };
}

function fakeDatabase({
  rows = [],
}: {
  rows?: Array<{ deadline_status: string; deadline_count: string | number }>;
} = {}) {
  return {
    queries: [] as Array<{ text: string; params: readonly unknown[] }>,
    async query(text: string, params: readonly unknown[] = []) {
      this.queries.push({ text, params });
      return { rows };
    },
  };
}
