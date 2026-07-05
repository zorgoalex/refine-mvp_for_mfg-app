import { describe, expect, it } from 'vitest';
import { parseGroupOrderReportQuery } from './group-order-report.dto';

const GROUP_A = '11111111-1111-4111-8111-111111111111';
const GROUP_A_UPPER = '11111111-1111-4111-8111-111111111111'.toUpperCase();
const GROUP_B = '22222222-2222-4222-8222-222222222222';

describe('parseGroupOrderReportQuery', () => {
  it('parses current any-mode group filter with pagination defaults', () => {
    expect(parseGroupOrderReportQuery({ groupIds: `${GROUP_A},${GROUP_B}` })).toEqual({
      page: 1,
      pageSize: 50,
      filter: { mode: 'any', groupIds: [GROUP_A, GROUP_B], temporal: { mode: 'current' } },
    });
  });

  it('parses all, primary, and none modes', () => {
    expect(parseGroupOrderReportQuery({ groupMode: 'all', groupIds: GROUP_A }).filter.mode).toBe('all');
    expect(parseGroupOrderReportQuery({ groupMode: 'primary', groupIds: GROUP_A }).filter.mode).toBe(
      'primary',
    );
    expect(parseGroupOrderReportQuery({ groupMode: 'none' }).filter).toEqual({
      mode: 'none',
      temporal: { mode: 'current' },
    });
  });

  it('parses as-of and overlap temporal modes', () => {
    expect(
      parseGroupOrderReportQuery({
        groupIds: GROUP_A,
        temporalMode: 'asOf',
        asOf: '2026-06-01T00:00:00.000Z',
      }).filter.temporal,
    ).toEqual({
      mode: 'asOf',
      asOf: '2026-06-01T00:00:00.000Z',
    });
    expect(
      parseGroupOrderReportQuery({
        groupIds: GROUP_A,
        temporalMode: 'overlap',
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-06-02T00:00:00.000Z',
      }).filter.temporal,
    ).toEqual({
      mode: 'overlap',
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-02T00:00:00.000Z',
    });
  });

  it('rejects missing group ids except none mode and rejects fact-time mode', () => {
    expect(() => parseGroupOrderReportQuery({ groupMode: 'any' })).toThrow(
      'groupIds are required unless groupMode=none',
    );
    expect(() => parseGroupOrderReportQuery({ groupIds: GROUP_A, temporalMode: 'factTime' })).toThrow(
      'temporalMode must be current, asOf, or overlap',
    );
  });

  it('dedupes and lower-cases group ids', () => {
    expect(parseGroupOrderReportQuery({ groupIds: `${GROUP_A_UPPER}, ${GROUP_A}` }).filter).toEqual({
      mode: 'any',
      groupIds: [GROUP_A],
      temporal: { mode: 'current' },
    });
  });

  it('validates uuid group ids and maximum group id count', () => {
    expect(() => parseGroupOrderReportQuery({ groupIds: 'not-a-uuid' })).toThrow(
      'groupIds must contain UUID values',
    );
    expect(() =>
      parseGroupOrderReportQuery({
        groupIds: Array.from(
          { length: 51 },
          (_, index) => `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
        ).join(','),
      }),
    ).toThrow('groupIds supports at most 50 ids');
  });

  it('validates pagination and overlap window bounds', () => {
    expect(parseGroupOrderReportQuery({ groupMode: 'none', page: '3', pageSize: '200' })).toMatchObject({
      page: 3,
      pageSize: 200,
    });
    expect(() =>
      parseGroupOrderReportQuery({ groupIds: GROUP_A, temporalMode: 'asOf', asOf: '2026-06-01' }),
    ).toThrow('asOf must be an ISO timestamp');
    expect(() => parseGroupOrderReportQuery({ groupMode: 'none', pageSize: '201' })).toThrow(
      'pageSize must be an integer between 1 and 200',
    );
    expect(() =>
      parseGroupOrderReportQuery({
        groupIds: GROUP_A,
        temporalMode: 'overlap',
        from: '2026-06-02T00:00:00.000Z',
        to: '2026-06-02T00:00:00.000Z',
      }),
    ).toThrow('to must be after from');
  });
});
