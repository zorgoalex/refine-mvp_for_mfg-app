import { describe, expect, it } from 'vitest';
import { parseProjectDeadlineStatusCountsReportQuery } from './project-deadline-status-counts-report.dto';

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_A_UPPER = '11111111-1111-4111-8111-111111111111'.toUpperCase();

describe('parseProjectDeadlineStatusCountsReportQuery', () => {
  it('parses default any mode with current-only response filter', () => {
    expect(parseProjectDeadlineStatusCountsReportQuery({ projectIds: PROJECT_A })).toEqual({
      predicateFilter: {
        mode: 'any',
        projectIds: [PROJECT_A],
        temporal: { mode: 'current' },
      },
      responseFilter: {
        projectMode: 'any',
        projectIds: [PROJECT_A],
        temporalMode: 'current',
      },
    });
  });

  it('parses projectMode none without projectIds', () => {
    expect(parseProjectDeadlineStatusCountsReportQuery({ projectMode: 'none' })).toEqual({
      predicateFilter: { mode: 'none', temporal: { mode: 'current' } },
      responseFilter: { projectMode: 'none', temporalMode: 'current' },
    });
  });

  it('normalizes and deduplicates project IDs', () => {
    expect(parseProjectDeadlineStatusCountsReportQuery({ projectIds: `${PROJECT_A_UPPER}, ${PROJECT_A}` })).toEqual({
      predicateFilter: {
        mode: 'any',
        projectIds: [PROJECT_A],
        temporal: { mode: 'current' },
      },
      responseFilter: {
        projectMode: 'any',
        projectIds: [PROJECT_A],
        temporalMode: 'current',
      },
    });
  });

  it('rejects missing projectIds for project modes', () => {
    expect(() => parseProjectDeadlineStatusCountsReportQuery({ projectMode: 'any' })).toThrow('projectIds are required');
  });

  it('rejects invalid projectIds', () => {
    expect(() => parseProjectDeadlineStatusCountsReportQuery({ projectIds: 'not-a-uuid' })).toThrow(
      'projectIds must contain UUID values',
    );
  });

  it('rejects historical temporal modes', () => {
    expect(() =>
      parseProjectDeadlineStatusCountsReportQuery({
        temporalMode: 'asOf',
        asOf: '2026-06-05T00:00:00Z',
      }),
    ).toThrow('temporalMode must be current');
  });

  it('rejects unsupported project modes including primary', () => {
    expect(() => parseProjectDeadlineStatusCountsReportQuery({ projectMode: 'bogus' })).toThrow(
      'projectMode must be any, all, or none',
    );
    expect(() => parseProjectDeadlineStatusCountsReportQuery({ projectMode: 'primary', projectIds: PROJECT_A })).toThrow(
      'projectMode=primary is not supported',
    );
  });
});
