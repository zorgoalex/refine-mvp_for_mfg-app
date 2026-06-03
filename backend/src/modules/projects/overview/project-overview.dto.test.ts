import { describe, expect, it } from 'vitest';

import { ApiError } from '../../../common/errors/api-error';
import {
  PROJECT_OVERVIEW_OMITTED,
  parseProjectOverviewQuery,
  type ProjectOverviewResponseDto,
} from './project-overview.dto';

const RESPONSE_FIXTURE = {
  project: {
    id: '11111111-1111-4111-8111-111111111111',
    code: 'P7',
    name: 'P7 Overview',
    description: null,
    status: 'active',
    startsAt: null,
    endsAt: null,
    ownerUserId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    archivedAt: null,
  },
  orders: {
    totalCount: 0,
    statusCounts: [],
    relationCounts: [],
    createdMonthCounts: [],
  },
  filter: {
    projectId: '11111111-1111-4111-8111-111111111111',
    temporalMode: 'current',
  },
  omitted: [...PROJECT_OVERVIEW_OMITTED],
} satisfies ProjectOverviewResponseDto;

describe('ProjectOverviewResponseDto', () => {
  it('matches the P7 overview response envelope', () => {
    expect(RESPONSE_FIXTURE).toMatchObject({
      project: {
        id: '11111111-1111-4111-8111-111111111111',
      },
      orders: {
        totalCount: 0,
        createdMonthCounts: [],
      },
      filter: {
        projectId: '11111111-1111-4111-8111-111111111111',
        temporalMode: 'current',
      },
      omitted: [...PROJECT_OVERVIEW_OMITTED],
    });
  });
});

describe('parseProjectOverviewQuery', () => {
  it('defaults to current temporal mode and no created range', () => {
    const result = parseProjectOverviewQuery({});

    expect(result).toEqual({
      temporal: { mode: 'current' },
      filter: { temporalMode: 'current' },
      createdRange: {},
    });
    expect(Object.keys(result.createdRange)).toEqual([]);
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

  it('parses valid asOf temporal mode', () => {
    expect(
      parseProjectOverviewQuery({
        temporalMode: 'asOf',
        asOf: '2026-01-01T00:00:00Z',
      }),
    ).toEqual({
      temporal: { mode: 'asOf', asOf: '2026-01-01T00:00:00Z' },
      filter: { temporalMode: 'asOf', asOf: '2026-01-01T00:00:00Z' },
      createdRange: {},
    });
  });

  it('rejects unsupported temporal mode', () => {
    expect(() => parseProjectOverviewQuery({ temporalMode: 'factTime' })).toThrow(
      'temporalMode must be current, asOf, or overlap',
    );
  });

  it('rejects projectIds because the path projectId is the only accepted project scope', () => {
    expect(() =>
      parseProjectOverviewQuery({
        projectIds: '11111111-1111-4111-8111-111111111111',
      }),
    ).toThrow('projectIds is not accepted for project overview');
  });

  it('rejects invalid ISO timestamps', () => {
    expect(() =>
      parseProjectOverviewQuery({
        temporalMode: 'asOf',
        asOf: '2026-02-30T00:00:00Z',
      }),
    ).toThrow('asOf must be an ISO timestamp');
  });

  it('rejects inverted overlap range', () => {
    expect(() =>
      parseProjectOverviewQuery({
        temporalMode: 'overlap',
        from: '2026-02-01T00:00:00Z',
        to: '2026-02-01T00:00:00Z',
      }),
    ).toThrow('to must be after from');
  });

  it('uses the first value for array query params', () => {
    expect(
      parseProjectOverviewQuery({
        temporalMode: ['asOf', 'overlap'],
        asOf: ['2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'],
      }),
    ).toEqual({
      temporal: { mode: 'asOf', asOf: '2026-01-01T00:00:00Z' },
      filter: { temporalMode: 'asOf', asOf: '2026-01-01T00:00:00Z' },
      createdRange: {},
    });
  });

  it('throws ApiError validation shape', () => {
    try {
      parseProjectOverviewQuery({ temporalMode: 'unknown' });
      throw new Error('Expected parseProjectOverviewQuery to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        statusCode: 422,
        code: 'VALIDATION_ERROR',
        details: { field: 'temporalMode' },
      });
    }
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
