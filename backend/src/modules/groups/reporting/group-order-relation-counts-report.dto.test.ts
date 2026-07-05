import { describe, expect, it } from 'vitest';
import { parseGroupOrderRelationCountsReportQuery } from './group-order-relation-counts-report.dto';

const GROUP_A = '11111111-1111-4111-8111-111111111111';
const GROUP_B = '22222222-2222-4222-8222-222222222222';

describe('parseGroupOrderRelationCountsReportQuery', () => {
  it('parses a current any-mode filter into predicate and strict response filters', () => {
    expect(parseGroupOrderRelationCountsReportQuery({ groupIds: `${GROUP_A},${GROUP_B}` })).toEqual({
      predicateFilter: { mode: 'any', groupIds: [GROUP_A, GROUP_B], temporal: { mode: 'current' } },
      responseFilter: { groupMode: 'any', groupIds: [GROUP_A, GROUP_B], temporalMode: 'current' },
    });
  });

  it('supports all, primary, none, asOf, and overlap modes', () => {
    expect(parseGroupOrderRelationCountsReportQuery({ groupMode: 'all', groupIds: GROUP_A }).responseFilter.groupMode).toBe('all');
    expect(parseGroupOrderRelationCountsReportQuery({ groupMode: 'primary', groupIds: GROUP_A }).responseFilter.groupMode).toBe('primary');
    expect(parseGroupOrderRelationCountsReportQuery({ groupMode: 'none' }).responseFilter).toEqual({
      groupMode: 'none',
      temporalMode: 'current',
    });
    expect(
      parseGroupOrderRelationCountsReportQuery({
        groupIds: GROUP_A,
        temporalMode: 'asOf',
        asOf: '2026-06-02T00:00:00.000Z',
      }).responseFilter,
    ).toEqual({
      groupMode: 'any',
      groupIds: [GROUP_A],
      temporalMode: 'asOf',
      asOf: '2026-06-02T00:00:00.000Z',
    });
    expect(
      parseGroupOrderRelationCountsReportQuery({
        groupIds: GROUP_A,
        temporalMode: 'overlap',
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-06-02T00:00:00.000Z',
      }).responseFilter,
    ).toEqual({
      groupMode: 'any',
      groupIds: [GROUP_A],
      temporalMode: 'overlap',
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-02T00:00:00.000Z',
    });
  });

  it('rejects invalid filters', () => {
    expect(() => parseGroupOrderRelationCountsReportQuery({ groupMode: 'any' })).toThrow(
      'groupIds are required unless groupMode=none',
    );
    expect(() => parseGroupOrderRelationCountsReportQuery({ groupIds: GROUP_A, temporalMode: 'factTime' })).toThrow(
      'temporalMode must be current, asOf, or overlap',
    );
    expect(() => parseGroupOrderRelationCountsReportQuery({ groupIds: 'not-a-uuid' })).toThrow(
      'groupIds must contain UUID values',
    );
  });
});
