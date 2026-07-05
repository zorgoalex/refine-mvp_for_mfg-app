import { describe, expect, it } from 'vitest';
import { parseGroupDeadlineStatusCountsReportQuery } from './group-deadline-status-counts-report.dto';

const GROUP_A = '11111111-1111-4111-8111-111111111111';
const GROUP_A_UPPER = '11111111-1111-4111-8111-111111111111'.toUpperCase();

describe('parseGroupDeadlineStatusCountsReportQuery', () => {
  it('parses default any mode with current-only response filter', () => {
    expect(parseGroupDeadlineStatusCountsReportQuery({ groupIds: GROUP_A })).toEqual({
      predicateFilter: {
        mode: 'any',
        groupIds: [GROUP_A],
        temporal: { mode: 'current' },
      },
      responseFilter: {
        groupMode: 'any',
        groupIds: [GROUP_A],
        temporalMode: 'current',
      },
    });
  });

  it('parses groupMode none without groupIds', () => {
    expect(parseGroupDeadlineStatusCountsReportQuery({ groupMode: 'none' })).toEqual({
      predicateFilter: { mode: 'none', temporal: { mode: 'current' } },
      responseFilter: { groupMode: 'none', temporalMode: 'current' },
    });
  });

  it('normalizes and deduplicates group IDs', () => {
    expect(parseGroupDeadlineStatusCountsReportQuery({ groupIds: `${GROUP_A_UPPER}, ${GROUP_A}` })).toEqual({
      predicateFilter: {
        mode: 'any',
        groupIds: [GROUP_A],
        temporal: { mode: 'current' },
      },
      responseFilter: {
        groupMode: 'any',
        groupIds: [GROUP_A],
        temporalMode: 'current',
      },
    });
  });

  it('rejects missing groupIds for group modes', () => {
    expect(() => parseGroupDeadlineStatusCountsReportQuery({ groupMode: 'any' })).toThrow('groupIds are required');
  });

  it('rejects invalid groupIds', () => {
    expect(() => parseGroupDeadlineStatusCountsReportQuery({ groupIds: 'not-a-uuid' })).toThrow(
      'groupIds must contain UUID values',
    );
  });

  it('rejects historical temporal modes', () => {
    expect(() =>
      parseGroupDeadlineStatusCountsReportQuery({
        temporalMode: 'asOf',
        asOf: '2026-06-05T00:00:00Z',
      }),
    ).toThrow('temporalMode must be current');
  });

  it('rejects unsupported group modes including primary', () => {
    expect(() => parseGroupDeadlineStatusCountsReportQuery({ groupMode: 'bogus' })).toThrow(
      'groupMode must be any, all, or none',
    );
    expect(() => parseGroupDeadlineStatusCountsReportQuery({ groupMode: 'primary', groupIds: GROUP_A })).toThrow(
      'groupMode=primary is not supported',
    );
  });
});
