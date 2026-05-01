import { describe, expect, it } from 'vitest';
import { createLiveHealthResponse, createReadyHealthResponse } from './health.contract';

describe('health live contract', () => {
  it('returns stable live health payload without DB access', () => {
    expect(createLiveHealthResponse(new Date('2026-04-30T00:00:00.000Z'), 12.9)).toEqual({
      status: 'ok',
      service: 'erp-backend',
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
      checks: {
        database: { status: 'ok', message: 'database readiness check disabled' },
        redis: { status: 'ok', message: 'redis readiness check disabled' },
        config: { status: 'ok' },
      },
      timestamp: '2026-04-30T00:00:00.000Z',
    });
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
