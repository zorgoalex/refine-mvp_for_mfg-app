import { describe, expect, it } from 'vitest';
import { parseProjectOrderReportQuery } from './project-order-report.dto';

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_A_UPPER = '11111111-1111-4111-8111-111111111111'.toUpperCase();
const PROJECT_B = '22222222-2222-4222-8222-222222222222';

describe('parseProjectOrderReportQuery', () => {
  it('parses current any-mode project filter with pagination defaults', () => {
    expect(parseProjectOrderReportQuery({ projectIds: `${PROJECT_A},${PROJECT_B}` })).toEqual({
      page: 1,
      pageSize: 50,
      filter: { mode: 'any', projectIds: [PROJECT_A, PROJECT_B], temporal: { mode: 'current' } },
    });
  });

  it('parses all, primary, and none modes', () => {
    expect(parseProjectOrderReportQuery({ projectMode: 'all', projectIds: PROJECT_A }).filter.mode).toBe('all');
    expect(parseProjectOrderReportQuery({ projectMode: 'primary', projectIds: PROJECT_A }).filter.mode).toBe(
      'primary',
    );
    expect(parseProjectOrderReportQuery({ projectMode: 'none' }).filter).toEqual({
      mode: 'none',
      temporal: { mode: 'current' },
    });
  });

  it('parses as-of and overlap temporal modes', () => {
    expect(
      parseProjectOrderReportQuery({
        projectIds: PROJECT_A,
        temporalMode: 'asOf',
        asOf: '2026-06-01T00:00:00.000Z',
      }).filter.temporal,
    ).toEqual({
      mode: 'asOf',
      asOf: '2026-06-01T00:00:00.000Z',
    });
    expect(
      parseProjectOrderReportQuery({
        projectIds: PROJECT_A,
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

  it('rejects missing project ids except none mode and rejects fact-time mode', () => {
    expect(() => parseProjectOrderReportQuery({ projectMode: 'any' })).toThrow(
      'projectIds are required unless projectMode=none',
    );
    expect(() => parseProjectOrderReportQuery({ projectIds: PROJECT_A, temporalMode: 'factTime' })).toThrow(
      'temporalMode must be current, asOf, or overlap',
    );
  });

  it('dedupes and lower-cases project ids', () => {
    expect(parseProjectOrderReportQuery({ projectIds: `${PROJECT_A_UPPER}, ${PROJECT_A}` }).filter).toEqual({
      mode: 'any',
      projectIds: [PROJECT_A],
      temporal: { mode: 'current' },
    });
  });

  it('validates uuid project ids and maximum project id count', () => {
    expect(() => parseProjectOrderReportQuery({ projectIds: 'not-a-uuid' })).toThrow(
      'projectIds must contain UUID values',
    );
    expect(() =>
      parseProjectOrderReportQuery({
        projectIds: Array.from(
          { length: 51 },
          (_, index) => `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
        ).join(','),
      }),
    ).toThrow('projectIds supports at most 50 ids');
  });

  it('validates pagination and overlap window bounds', () => {
    expect(parseProjectOrderReportQuery({ projectMode: 'none', page: '3', pageSize: '200' })).toMatchObject({
      page: 3,
      pageSize: 200,
    });
    expect(() =>
      parseProjectOrderReportQuery({ projectIds: PROJECT_A, temporalMode: 'asOf', asOf: '2026-06-01' }),
    ).toThrow('asOf must be an ISO timestamp');
    expect(() => parseProjectOrderReportQuery({ projectMode: 'none', pageSize: '201' })).toThrow(
      'pageSize must be an integer between 1 and 200',
    );
    expect(() =>
      parseProjectOrderReportQuery({
        projectIds: PROJECT_A,
        temporalMode: 'overlap',
        from: '2026-06-02T00:00:00.000Z',
        to: '2026-06-02T00:00:00.000Z',
      }),
    ).toThrow('to must be after from');
  });
});
