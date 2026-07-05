import { describe, expect, it } from 'vitest';
import { parseGroupOrderCreatedMonthCountsReportQuery } from './group-order-created-month-counts-report.dto';

const GROUP_A = '11111111-1111-4111-8111-111111111111';

describe('parseGroupOrderCreatedMonthCountsReportQuery', () => {
  it('parses current group filter plus created range', () => {
    expect(
      parseGroupOrderCreatedMonthCountsReportQuery({
        groupIds: GROUP_A,
        createdFrom: '2026-01-01T00:00:00.000Z',
        createdTo: '2026-06-01T00:00:00.000Z',
      }).responseFilter,
    ).toEqual({
      groupMode: 'any',
      groupIds: [GROUP_A],
      temporalMode: 'current',
      createdFrom: '2026-01-01T00:00:00.000Z',
      createdTo: '2026-06-01T00:00:00.000Z',
    });
  });

  it('supports groupMode none without groupIds', () => {
    expect(parseGroupOrderCreatedMonthCountsReportQuery({ groupMode: 'none' }).responseFilter).toEqual({
      groupMode: 'none',
      temporalMode: 'current',
    });
  });

  it('rejects invalid group, temporal, and created ranges', () => {
    expect(() => parseGroupOrderCreatedMonthCountsReportQuery({ groupMode: 'any' })).toThrow(
      'groupIds are required unless groupMode=none',
    );
    expect(() => parseGroupOrderCreatedMonthCountsReportQuery({ groupIds: 'not-a-uuid' })).toThrow(
      'groupIds must contain UUID values',
    );
    expect(
      () => parseGroupOrderCreatedMonthCountsReportQuery({ groupIds: GROUP_A, temporalMode: 'factTime' }),
    ).toThrow('temporalMode must be current, asOf, or overlap');
    expect(() =>
      parseGroupOrderCreatedMonthCountsReportQuery({
        groupIds: GROUP_A,
        createdFrom: '2026-06-01T00:00:00.000Z',
        createdTo: '2026-01-01T00:00:00.000Z',
      }),
    ).toThrow('createdTo must be after createdFrom');
  });
});
