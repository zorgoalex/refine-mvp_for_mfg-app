import { describe, expect, it } from 'vitest';
import { parseRollout, parseWritesSetting } from './order-realtime-runtime-config.service';

describe('order realtime rollout config', () => {
  it('parses a bounded explicit/cohort rollout', () => {
    expect(parseRollout({ enabled: true, userIds: [17, '42', 17], rolloutPercent: 5 })).toEqual({
      enabled: true,
      userIds: ['17', '42'],
      rolloutPercent: 5,
    });
  });

  it('fails closed for malformed settings', () => {
    expect(parseRollout({ enabled: true, userIds: [], rolloutPercent: 101 })).toEqual({
      enabled: false,
      userIds: [],
      rolloutPercent: 0,
    });
    expect(parseRollout({ enabled: true, userIds: ['admin'], rolloutPercent: 100 }).enabled).toBe(false);
  });

  it('fails database producer settings closed', () => {
    expect(parseWritesSetting({ enabled: true, maxFanoutOrders: 5000, maxDetailIds: 500 })).toEqual({
      enabled: true,
      maxFanoutOrders: 5000,
      maxDetailIds: 500,
    });
    expect(parseWritesSetting({ enabled: true, maxFanoutOrders: 0, maxDetailIds: 500 }).enabled).toBe(false);
    expect(parseWritesSetting({ enabled: true, maxFanoutOrders: 5000, maxDetailIds: 0 }).enabled).toBe(false);
  });
});
