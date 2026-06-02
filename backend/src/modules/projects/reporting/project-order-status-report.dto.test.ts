import { describe, expect, it } from 'vitest';
import { parseProjectOrderStatusReportQuery } from './project-order-status-report.dto';

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_A_UPPER = '11111111-1111-4111-8111-111111111111'.toUpperCase();
const PROJECT_B = '22222222-2222-4222-8222-222222222222';

describe('parseProjectOrderStatusReportQuery', () => {
  it('parses current any-mode project filter without pagination', () => {
    expect(parseProjectOrderStatusReportQuery({ projectIds: `${PROJECT_A},${PROJECT_B}` })).toEqual({
      predicateFilter: { mode: 'any', projectIds: [PROJECT_A, PROJECT_B], temporal: { mode: 'current' } },
      responseFilter: { projectMode: 'any', projectIds: [PROJECT_A, PROJECT_B], temporalMode: 'current' },
    });
  });

  it('parses all, primary, and none modes', () => {
    expect(parseProjectOrderStatusReportQuery({ projectMode: 'all', projectIds: PROJECT_A }).responseFilter.projectMode).toBe(
      'all',
    );
    expect(
      parseProjectOrderStatusReportQuery({ projectMode: 'primary', projectIds: PROJECT_A }).responseFilter.projectMode,
    ).toBe('primary');
    expect(parseProjectOrderStatusReportQuery({ projectMode: 'none' }).responseFilter).toEqual({
      projectMode: 'none',
      temporalMode: 'current',
    });
  });

  it('parses as-of and overlap temporal modes', () => {
    expect(
      parseProjectOrderStatusReportQuery({
        projectIds: PROJECT_A,
        temporalMode: 'asOf',
        asOf: '2026-06-01T00:00:00.000Z',
      }).responseFilter,
    ).toEqual({
      projectMode: 'any',
      projectIds: [PROJECT_A],
      temporalMode: 'asOf',
      asOf: '2026-06-01T00:00:00.000Z',
    });
    expect(
      parseProjectOrderStatusReportQuery({
        projectIds: PROJECT_A,
        temporalMode: 'overlap',
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-06-02T00:00:00.000Z',
      }).responseFilter,
    ).toEqual({
      projectMode: 'any',
      projectIds: [PROJECT_A],
      temporalMode: 'overlap',
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-02T00:00:00.000Z',
    });
  });

  it('rejects missing project ids except none mode and rejects fact-time mode', () => {
    expect(() => parseProjectOrderStatusReportQuery({ projectMode: 'any' })).toThrow(
      'projectIds are required unless projectMode=none',
    );
    expect(() => parseProjectOrderStatusReportQuery({ projectIds: PROJECT_A, temporalMode: 'factTime' })).toThrow(
      'temporalMode must be current, asOf, or overlap',
    );
  });

  it('dedupes and lower-cases project ids', () => {
    expect(parseProjectOrderStatusReportQuery({ projectIds: `${PROJECT_A_UPPER}, ${PROJECT_A}` }).responseFilter).toEqual({
      projectMode: 'any',
      projectIds: [PROJECT_A],
      temporalMode: 'current',
    });
  });

  it('validates uuid project ids and maximum project id count', () => {
    expect(() => parseProjectOrderStatusReportQuery({ projectIds: 'not-a-uuid' })).toThrow(
      'projectIds must contain UUID values',
    );
    expect(() =>
      parseProjectOrderStatusReportQuery({
        projectIds: Array.from(
          { length: 51 },
          (_, index) => `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
        ).join(','),
      }),
    ).toThrow('projectIds supports at most 50 ids');
  });

  it('validates overlap window bounds', () => {
    expect(() =>
      parseProjectOrderStatusReportQuery({ projectIds: PROJECT_A, temporalMode: 'asOf', asOf: '2026-06-01' }),
    ).toThrow('asOf must be an ISO timestamp');
    expect(() =>
      parseProjectOrderStatusReportQuery({
        projectIds: PROJECT_A,
        temporalMode: 'overlap',
        from: '2026-06-02T00:00:00.000Z',
        to: '2026-06-02T00:00:00.000Z',
      }),
    ).toThrow('to must be after from');
  });
});
