import { describe, expect, it } from 'vitest';
import { parseGroupOrderStatusReportQuery } from './group-order-status-report.dto';

const GROUP_A = '11111111-1111-4111-8111-111111111111';
const GROUP_A_UPPER = '11111111-1111-4111-8111-111111111111'.toUpperCase();
const GROUP_B = '22222222-2222-4222-8222-222222222222';

describe('parseGroupOrderStatusReportQuery', () => {
  it('parses current any-mode group filter without pagination', () => {
    expect(parseGroupOrderStatusReportQuery({ groupIds: `${GROUP_A},${GROUP_B}` })).toEqual({
      predicateFilter: { mode: 'any', groupIds: [GROUP_A, GROUP_B], temporal: { mode: 'current' } },
      responseFilter: { groupMode: 'any', groupIds: [GROUP_A, GROUP_B], temporalMode: 'current' },
    });
  });

  it('parses all, primary, and none modes', () => {
    expect(parseGroupOrderStatusReportQuery({ groupMode: 'all', groupIds: GROUP_A }).responseFilter.groupMode).toBe(
      'all',
    );
    expect(
      parseGroupOrderStatusReportQuery({ groupMode: 'primary', groupIds: GROUP_A }).responseFilter.groupMode,
    ).toBe('primary');
    expect(parseGroupOrderStatusReportQuery({ groupMode: 'none' }).responseFilter).toEqual({
      groupMode: 'none',
      temporalMode: 'current',
    });
  });

  it('parses as-of and overlap temporal modes', () => {
    expect(
      parseGroupOrderStatusReportQuery({
        groupIds: GROUP_A,
        temporalMode: 'asOf',
        asOf: '2026-06-01T00:00:00.000Z',
      }).responseFilter,
    ).toEqual({
      groupMode: 'any',
      groupIds: [GROUP_A],
      temporalMode: 'asOf',
      asOf: '2026-06-01T00:00:00.000Z',
    });
    expect(
      parseGroupOrderStatusReportQuery({
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

  it('rejects missing group ids except none mode and rejects fact-time mode', () => {
    expect(() => parseGroupOrderStatusReportQuery({ groupMode: 'any' })).toThrow(
      'groupIds are required unless groupMode=none',
    );
    expect(() => parseGroupOrderStatusReportQuery({ groupIds: GROUP_A, temporalMode: 'factTime' })).toThrow(
      'temporalMode must be current, asOf, or overlap',
    );
  });

  it('dedupes and lower-cases group ids', () => {
    expect(parseGroupOrderStatusReportQuery({ groupIds: `${GROUP_A_UPPER}, ${GROUP_A}` }).responseFilter).toEqual({
      groupMode: 'any',
      groupIds: [GROUP_A],
      temporalMode: 'current',
    });
  });

  it('validates uuid group ids and maximum group id count', () => {
    expect(() => parseGroupOrderStatusReportQuery({ groupIds: 'not-a-uuid' })).toThrow(
      'groupIds must contain UUID values',
    );
    expect(() =>
      parseGroupOrderStatusReportQuery({
        groupIds: Array.from(
          { length: 51 },
          (_, index) => `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
        ).join(','),
      }),
    ).toThrow('groupIds supports at most 50 ids');
  });

  it('validates overlap window bounds', () => {
    expect(() =>
      parseGroupOrderStatusReportQuery({ groupIds: GROUP_A, temporalMode: 'asOf', asOf: '2026-06-01' }),
    ).toThrow('asOf must be an ISO timestamp');
    expect(() =>
      parseGroupOrderStatusReportQuery({
        groupIds: GROUP_A,
        temporalMode: 'overlap',
        from: '2026-06-02T00:00:00.000Z',
        to: '2026-06-02T00:00:00.000Z',
      }),
    ).toThrow('to must be after from');
  });
});
