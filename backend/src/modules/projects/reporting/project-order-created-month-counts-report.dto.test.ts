import { describe, expect, it } from 'vitest';
import { parseProjectOrderCreatedMonthCountsReportQuery } from './project-order-created-month-counts-report.dto';

const PROJECT_A = '11111111-1111-4111-8111-111111111111';

describe('parseProjectOrderCreatedMonthCountsReportQuery', () => {
  it('parses current project filter plus created range', () => {
    expect(
      parseProjectOrderCreatedMonthCountsReportQuery({
        projectIds: PROJECT_A,
        createdFrom: '2026-01-01T00:00:00.000Z',
        createdTo: '2026-06-01T00:00:00.000Z',
      }).responseFilter,
    ).toEqual({
      projectMode: 'any',
      projectIds: [PROJECT_A],
      temporalMode: 'current',
      createdFrom: '2026-01-01T00:00:00.000Z',
      createdTo: '2026-06-01T00:00:00.000Z',
    });
  });

  it('supports projectMode none without projectIds', () => {
    expect(parseProjectOrderCreatedMonthCountsReportQuery({ projectMode: 'none' }).responseFilter).toEqual({
      projectMode: 'none',
      temporalMode: 'current',
    });
  });

  it('rejects invalid project, temporal, and created ranges', () => {
    expect(() => parseProjectOrderCreatedMonthCountsReportQuery({ projectMode: 'any' })).toThrow(
      'projectIds are required unless projectMode=none',
    );
    expect(() => parseProjectOrderCreatedMonthCountsReportQuery({ projectIds: 'not-a-uuid' })).toThrow(
      'projectIds must contain UUID values',
    );
    expect(
      () => parseProjectOrderCreatedMonthCountsReportQuery({ projectIds: PROJECT_A, temporalMode: 'factTime' }),
    ).toThrow('temporalMode must be current, asOf, or overlap');
    expect(() =>
      parseProjectOrderCreatedMonthCountsReportQuery({
        projectIds: PROJECT_A,
        createdFrom: '2026-06-01T00:00:00.000Z',
        createdTo: '2026-01-01T00:00:00.000Z',
      }),
    ).toThrow('createdTo must be after createdFrom');
  });
});
