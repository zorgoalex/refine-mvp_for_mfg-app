import { describe, expect, it } from 'vitest';
import { parseProjectOrderRelationCountsReportQuery } from './project-order-relation-counts-report.dto';

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = '22222222-2222-4222-8222-222222222222';

describe('parseProjectOrderRelationCountsReportQuery', () => {
  it('parses a current any-mode filter into predicate and strict response filters', () => {
    expect(parseProjectOrderRelationCountsReportQuery({ projectIds: `${PROJECT_A},${PROJECT_B}` })).toEqual({
      predicateFilter: { mode: 'any', projectIds: [PROJECT_A, PROJECT_B], temporal: { mode: 'current' } },
      responseFilter: { projectMode: 'any', projectIds: [PROJECT_A, PROJECT_B], temporalMode: 'current' },
    });
  });

  it('supports all, primary, none, asOf, and overlap modes', () => {
    expect(parseProjectOrderRelationCountsReportQuery({ projectMode: 'all', projectIds: PROJECT_A }).responseFilter.projectMode).toBe('all');
    expect(parseProjectOrderRelationCountsReportQuery({ projectMode: 'primary', projectIds: PROJECT_A }).responseFilter.projectMode).toBe('primary');
    expect(parseProjectOrderRelationCountsReportQuery({ projectMode: 'none' }).responseFilter).toEqual({
      projectMode: 'none',
      temporalMode: 'current',
    });
    expect(
      parseProjectOrderRelationCountsReportQuery({
        projectIds: PROJECT_A,
        temporalMode: 'asOf',
        asOf: '2026-06-02T00:00:00.000Z',
      }).responseFilter,
    ).toEqual({
      projectMode: 'any',
      projectIds: [PROJECT_A],
      temporalMode: 'asOf',
      asOf: '2026-06-02T00:00:00.000Z',
    });
    expect(
      parseProjectOrderRelationCountsReportQuery({
        projectIds: PROJECT_A,
        temporalMode: 'overlap',
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-06-02T00:00:00.000Z',
      }).responseFilter,
    ).toEqual({
      projectMode: 'any',
      projectIds: [PROJECT_A],
      temporalMode: 'overlap',
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-02T00:00:00.000Z',
    });
  });

  it('rejects invalid filters', () => {
    expect(() => parseProjectOrderRelationCountsReportQuery({ projectMode: 'any' })).toThrow(
      'projectIds are required unless projectMode=none',
    );
    expect(() => parseProjectOrderRelationCountsReportQuery({ projectIds: PROJECT_A, temporalMode: 'factTime' })).toThrow(
      'temporalMode must be current, asOf, or overlap',
    );
    expect(() => parseProjectOrderRelationCountsReportQuery({ projectIds: 'not-a-uuid' })).toThrow(
      'projectIds must contain UUID values',
    );
  });
});
