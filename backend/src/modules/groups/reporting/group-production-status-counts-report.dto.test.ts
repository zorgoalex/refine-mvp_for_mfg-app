import { describe, expect, it } from 'vitest';
import { parseGroupProductionStatusCountsReportQuery } from './group-production-status-counts-report.dto';

describe('parseGroupProductionStatusCountsReportQuery', () => {
  it('defaults to current group membership and requires groupIds for group modes', () => {
    expect(() => parseGroupProductionStatusCountsReportQuery({ groupMode: 'any' })).toThrow(
      /groupIds are required unless groupMode=none/,
    );

    expect(parseGroupProductionStatusCountsReportQuery({ groupMode: 'none' })).toEqual({
      predicateFilter: { mode: 'none', temporal: { mode: 'current' } },
      responseFilter: { groupMode: 'none', temporalMode: 'current' },
    });
  });

  it('normalizes group IDs and returns current-only filter metadata', () => {
    expect(
      parseGroupProductionStatusCountsReportQuery({
        groupMode: 'primary',
        groupIds: '11111111-1111-4111-8111-111111111111,11111111-1111-4111-8111-111111111111',
      }),
    ).toEqual({
      predicateFilter: {
        mode: 'primary',
        groupIds: ['11111111-1111-4111-8111-111111111111'],
        temporal: { mode: 'current' },
      },
      responseFilter: {
        groupMode: 'primary',
        groupIds: ['11111111-1111-4111-8111-111111111111'],
        temporalMode: 'current',
      },
    });
  });

  it('rejects historical temporal modes and invalid UUIDs', () => {
    expect(() =>
      parseGroupProductionStatusCountsReportQuery({
        groupMode: 'any',
        groupIds: 'not-a-uuid',
      }),
    ).toThrow(/groupIds must contain UUID values/);

    expect(() =>
      parseGroupProductionStatusCountsReportQuery({ groupMode: 'none', temporalMode: 'asOf' }),
    ).toThrow(/temporalMode must be current for production-status-counts/);
    expect(() =>
      parseGroupProductionStatusCountsReportQuery({ groupMode: 'none', temporalMode: 'overlap' }),
    ).toThrow(/temporalMode must be current for production-status-counts/);
  });
});
