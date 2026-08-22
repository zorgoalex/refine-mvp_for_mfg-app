import { describe, expect, it } from 'vitest';
import { createLiveHealthResponse, createReadyHealthResponse } from './health.contract';

describe('health live contract', () => {
  it('returns stable live health payload without DB access', () => {
    expect(createLiveHealthResponse(new Date('2026-04-30T00:00:00.000Z'), 12.9)).toEqual({
      status: 'ok',
      service: 'erp-backend',
      deployment: { gitCommitSha: null },
      timestamp: '2026-04-30T00:00:00.000Z',
      uptimeSeconds: 12,
    });
  });

  it('returns ready when required checks are ok or intentionally skipped', () => {
    expect(
      createReadyHealthResponse({
        now: new Date('2026-04-30T00:00:00.000Z'),
        database: { status: 'ok', message: 'database readiness check disabled' },
        redis: { status: 'ok', message: 'redis readiness check disabled' },
      }),
    ).toEqual({
      status: 'ready',
      deployment: { gitCommitSha: null },
      checks: {
        database: { status: 'ok', message: 'database readiness check disabled' },
        redis: { status: 'ok', message: 'redis readiness check disabled' },
        config: { status: 'ok' },
      },
      timestamp: '2026-04-30T00:00:00.000Z',
    });
  });

  it('publishes immutable deployment identity when supplied', () => {
    const sha = 'a154fef554948d9643630a827cb1aa4795117e54';
    expect(createLiveHealthResponse(new Date('2026-04-30T00:00:00.000Z'), 1, 'erp-backend', sha))
      .toMatchObject({ deployment: { gitCommitSha: sha } });
    expect(createReadyHealthResponse({
      gitCommitSha: sha,
      database: { status: 'ok' },
      redis: { status: 'ok' },
    })).toMatchObject({ deployment: { gitCommitSha: sha } });
  });

  it('returns not_ready when any check is unavailable', () => {
    expect(
      createReadyHealthResponse({
        database: { status: 'unavailable' },
        redis: { status: 'ok' },
      }).status,
    ).toBe('not_ready');
  });
});
