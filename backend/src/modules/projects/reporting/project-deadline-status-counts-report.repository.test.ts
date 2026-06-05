import { describe, expect, it } from 'vitest';
import type { ProjectDeadlineStatusCountsReportQuery } from './project-deadline-status-counts-report.dto';
import {
  buildProjectDeadlineStatusCountsSql,
  PgProjectDeadlineStatusCountsReportRepository,
  UnavailableProjectDeadlineStatusCountsReportRepository,
} from './project-deadline-status-counts-report.repository';

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = '22222222-2222-4222-8222-222222222222';

describe('buildProjectDeadlineStatusCountsSql', () => {
  it('builds effective attribution with explicit deadline links replacing derived order attribution', () => {
    const { text, params } = buildProjectDeadlineStatusCountsSql(reportQuery({ mode: 'any', projectIds: [PROJECT_A] }));

    expect(params).toEqual([[PROJECT_A], 'any']);
    expect(text).toContain('FROM public.deadline_instances d');
    expect(text).toContain('JOIN public.project_entity_links pel');
    expect(text).toContain("pel.entity_type_code = 'deadline_instance'");
    expect(text).toContain('pel.entity_id_text = d.deadline_id::text');
    expect(text).not.toContain('entity_id_text::uuid');
    expect(text).toContain('JOIN public.project_order_projects pop');
    expect(text).toContain('JOIN public.order_workshops ow');
    expect(text).toContain('effective_deadline_projects AS');
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
    expect(buildProjectDeadlineStatusCountsSql(reportQuery({ mode: 'any', projectIds: [PROJECT_A] })).text).toContain(
      'EXISTS (\n  SELECT 1\n  FROM effective_deadline_projects edp',
    );
    expect(
      buildProjectDeadlineStatusCountsSql(reportQuery({ mode: 'all', projectIds: [PROJECT_A, PROJECT_B] })).text,
    ).toContain('= cardinality($1::uuid[])');
    expect(buildProjectDeadlineStatusCountsSql(reportQuery({ mode: 'none' })).text).toContain(
      'NOT EXISTS (\n  SELECT 1\n  FROM effective_deadline_projects edp',
    );
  });
});

describe('PgProjectDeadlineStatusCountsReportRepository', () => {
  it('returns aggregate-only deadline status counts', async () => {
    const database = fakeDatabase({
      rows: [
        { deadline_status: 'active', deadline_count: '3' },
        { deadline_status: 'expired', deadline_count: '1' },
      ],
    });
    const repo = new PgProjectDeadlineStatusCountsReportRepository(database);

    await expect(repo.listDeadlineStatusCounts(reportQuery({ mode: 'none' }))).resolves.toEqual({
      data: [
        { deadlineStatus: 'active', deadlineCount: 3 },
        { deadlineStatus: 'expired', deadlineCount: 1 },
      ],
      filter: { projectMode: 'none', temporalMode: 'current' },
    });
  });

  it('supports unavailable repository fail-closed behavior', async () => {
    await expect(
      new UnavailableProjectDeadlineStatusCountsReportRepository().listDeadlineStatusCounts(),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'DATABASE_UNAVAILABLE',
    });
  });
});

function reportQuery(input: { mode: 'none' } | { mode: 'any' | 'all'; projectIds: string[] }): ProjectDeadlineStatusCountsReportQuery {
  if (input.mode === 'none') {
    return {
      predicateFilter: { mode: 'none', temporal: { mode: 'current' } },
      responseFilter: { projectMode: 'none', temporalMode: 'current' },
    };
  }

  return {
    predicateFilter: { mode: input.mode, projectIds: input.projectIds, temporal: { mode: 'current' } },
    responseFilter: { projectMode: input.mode, projectIds: input.projectIds, temporalMode: 'current' },
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
