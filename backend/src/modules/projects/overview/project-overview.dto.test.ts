import { describe, expect, it } from 'vitest';

import { parseProjectOverviewQuery } from './project-overview.dto';

describe('parseProjectOverviewQuery', () => {
  it('defaults to current temporal mode and no created range', () => {
    expect(parseProjectOverviewQuery({})).toEqual({
      temporal: { mode: 'current' },
      filter: { temporalMode: 'current' },
      createdRange: {},
    });
  });

  it('parses overlap and created range', () => {
    expect(
      parseProjectOverviewQuery({
        temporalMode: 'overlap',
        from: '2026-01-01T00:00:00Z',
        to: '2026-02-01T00:00:00Z',
        createdFrom: '2026-01-01T00:00:00Z',
        createdTo: '2026-06-01T00:00:00Z',
      }),
    ).toEqual({
      temporal: {
        mode: 'overlap',
        from: '2026-01-01T00:00:00Z',
        to: '2026-02-01T00:00:00Z',
      },
      filter: {
        temporalMode: 'overlap',
        from: '2026-01-01T00:00:00Z',
        to: '2026-02-01T00:00:00Z',
        createdFrom: '2026-01-01T00:00:00Z',
        createdTo: '2026-06-01T00:00:00Z',
      },
      createdRange: {
        from: '2026-01-01T00:00:00Z',
        to: '2026-06-01T00:00:00Z',
      },
    });
  });

  it('rejects unsupported temporal mode', () => {
    expect(() => parseProjectOverviewQuery({ temporalMode: 'factTime' })).toThrow(
      'temporalMode must be current, asOf, or overlap',
    );
  });

  it('rejects invalid ISO timestamps', () => {
    expect(() =>
      parseProjectOverviewQuery({
        temporalMode: 'asOf',
        asOf: '2026-02-30T00:00:00Z',
      }),
    ).toThrow('asOf must be an ISO timestamp');
  });

  it('rejects inverted created range', () => {
    expect(() =>
      parseProjectOverviewQuery({
        createdFrom: '2026-06-01T00:00:00Z',
        createdTo: '2026-01-01T00:00:00Z',
      }),
    ).toThrow('createdTo must be after createdFrom');
  });
});
