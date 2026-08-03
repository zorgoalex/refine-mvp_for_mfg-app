import { describe, expect, it } from 'vitest';
import type { OrderDetailLiveStateSnapshot } from '../../api/orderRealtimeApi';
import {
  areOrderDetailLiveStateMapsEqual,
  buildOrderDetailLiveStateMaps,
  calculateOrderRealtimeReconnectDelay,
  parseOrderRealtimeEvent,
} from './useOrderDetailLiveState';

const snapshot: OrderDetailLiveStateSnapshot = {
  orderId: 42,
  streamEnabled: true,
  streamCursor: 'cursor-1',
  cutRefsAccess: 'allowed',
  details: [
    {
      detailId: 7,
      productionStatusId: 3,
      cutJob: {
        cutJobId: 10,
        resultNo: 2,
        cutNumber: '10-2',
        name: 'Раскрой 10',
        paramProfileId: null,
        profileName: null,
        profileIsActive: null,
      },
      bathCutJob: null,
    },
  ],
};

describe('order detail live state projection', () => {
  it('projects one compact snapshot into status and cut maps', () => {
    const maps = buildOrderDetailLiveStateMaps(snapshot);

    expect(maps.statusByDetailId.get(7)).toBe(3);
    expect(maps.cutJobByDetailId.get(7)).toMatchObject({ cutJobId: 10, resultNo: 2 });
    expect(maps.bathCutJobByDetailId.size).toBe(0);
    expect(maps.loaded).toBe(true);
  });

  it('treats equivalent snapshots as equal despite new map references', () => {
    const left = buildOrderDetailLiveStateMaps(snapshot);
    const right = buildOrderDetailLiveStateMaps(structuredClone(snapshot));

    expect(areOrderDetailLiveStateMapsEqual(left, right)).toBe(true);
    right.statusByDetailId.set(7, 4);
    expect(areOrderDetailLiveStateMapsEqual(left, right)).toBe(false);
  });

  it('invalidates only for matching order events and handles server disable', () => {
    expect(parseOrderRealtimeEvent({
      event: 'order.invalidate',
      data: JSON.stringify({
        schemaVersion: 1,
        orderId: 42,
        cursor: 'v1;s=2;c=1',
        domains: ['detail_status'],
      }),
    }, 42)).toBe('invalidate');
    expect(parseOrderRealtimeEvent({
      event: 'order.reset',
      data: JSON.stringify({
        schemaVersion: 1,
        orderId: 42,
        cursor: 'v1;s=2;c=1',
        reason: 'buffer_overflow',
      }),
    }, 42)).toBe('reset');
    expect(parseOrderRealtimeEvent({
      event: 'order.reset',
      data: JSON.stringify({
        schemaVersion: 1,
        orderId: 43,
        cursor: 'v1;s=2;c=1',
        reason: 'buffer_overflow',
      }),
    }, 42)).toBe('protocol_error');
    expect(parseOrderRealtimeEvent({
      event: 'order.invalidate',
      data: JSON.stringify({ schemaVersion: 2, orderId: 42 }),
    }, 42)).toBe('protocol_error');
    expect(parseOrderRealtimeEvent({
      event: 'order.realtime-disabled',
      data: JSON.stringify({ schemaVersion: 1, enabled: false }),
    }, 42)).toBe('disabled');
    expect(parseOrderRealtimeEvent({ event: 'future.event', data: '{}' }, 42)).toBe('ignore');
  });

  it('uses capped exponential full-jitter reconnect delays', () => {
    expect(calculateOrderRealtimeReconnectDelay(3_000, 0, () => 0.5)).toBe(1_500);
    expect(calculateOrderRealtimeReconnectDelay(3_000, 2, () => 0.5)).toBe(6_000);
    expect(calculateOrderRealtimeReconnectDelay(3_000, 10, () => 1)).toBe(30_000);
  });
});
