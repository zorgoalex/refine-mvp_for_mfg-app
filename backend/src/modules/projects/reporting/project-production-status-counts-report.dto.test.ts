import { describe, expect, it } from 'vitest';
import { parseProjectProductionStatusCountsReportQuery } from './project-production-status-counts-report.dto';

describe('parseProjectProductionStatusCountsReportQuery', () => {
  it('defaults to current project membership and requires projectIds for project modes', () => {
    expect(() => parseProjectProductionStatusCountsReportQuery({ projectMode: 'any' })).toThrow(
      /projectIds are required unless projectMode=none/,
    );

    expect(parseProjectProductionStatusCountsReportQuery({ projectMode: 'none' })).toEqual({
      predicateFilter: { mode: 'none', temporal: { mode: 'current' } },
      responseFilter: { projectMode: 'none', temporalMode: 'current' },
    });
  });

  it('normalizes project IDs and returns current-only filter metadata', () => {
    expect(
      parseProjectProductionStatusCountsReportQuery({
        projectMode: 'primary',
        projectIds: '11111111-1111-4111-8111-111111111111,11111111-1111-4111-8111-111111111111',
      }),
    ).toEqual({
      predicateFilter: {
        mode: 'primary',
        projectIds: ['11111111-1111-4111-8111-111111111111'],
        temporal: { mode: 'current' },
      },
      responseFilter: {
        projectMode: 'primary',
        projectIds: ['11111111-1111-4111-8111-111111111111'],
        temporalMode: 'current',
      },
    });
  });

  it('rejects historical temporal modes and invalid UUIDs', () => {
    expect(() =>
      parseProjectProductionStatusCountsReportQuery({
        projectMode: 'any',
        projectIds: 'not-a-uuid',
      }),
    ).toThrow(/projectIds must contain UUID values/);

    expect(() =>
      parseProjectProductionStatusCountsReportQuery({ projectMode: 'none', temporalMode: 'asOf' }),
    ).toThrow(/temporalMode must be current for production-status-counts/);
    expect(() =>
      parseProjectProductionStatusCountsReportQuery({ projectMode: 'none', temporalMode: 'overlap' }),
    ).toThrow(/temporalMode must be current for production-status-counts/);
  });
});
