import { describe, expect, it, vi } from 'vitest';
import {
  buildCutJobReadyPayload,
  cutJobReadyAffects,
  readCutJobReadyEvent,
  subscribeCutJobReady,
} from './cutJobEvents';

describe('cut job ready events', () => {
  it('builds a de-duplicated payload from job items', () => {
    const payload = buildCutJobReadyPayload({
      cutJobId: 42,
      name: 'Раскрой 42',
      items: [
        { cutJobItemId: 1, orderDetailId: 10, orderId: 100, qty: 1, cutGroupId: null, detail: null },
        { cutJobItemId: 2, orderDetailId: 10, orderId: 100, qty: 1, cutGroupId: null, detail: null },
        { cutJobItemId: 3, orderDetailId: 11, orderId: 101, qty: 1, cutGroupId: null, detail: null },
      ],
    });

    expect(payload).toEqual({
      cutJobId: 42,
      name: 'Раскрой 42',
      detailIds: [10, 11],
      orderIds: [100, 101],
    });
  });

  it('includes explicit affected ids for removed or reassigned items', () => {
    const payload = buildCutJobReadyPayload({
      cutJobId: 42,
      name: 'Раскрой 42',
      items: [
        { cutJobItemId: 1, orderDetailId: 10, orderId: 100, qty: 1, cutGroupId: null, detail: null },
      ],
    }, {
      detailIds: [10, 11],
      orderIds: [100, 101],
    });

    expect(payload.detailIds).toEqual([10, 11]);
    expect(payload.orderIds).toEqual([100, 101]);
  });

  it('checks whether a ready job touches an open order/detail table', () => {
    const payload = { cutJobId: 42, name: 'J', detailIds: [10, 11], orderIds: [100] };

    expect(cutJobReadyAffects(payload, { orderId: 100 })).toBe(true);
    expect(cutJobReadyAffects(payload, { detailIds: [99, 11] })).toBe(true);
    expect(cutJobReadyAffects(payload, { orderId: 101, detailIds: [99] })).toBe(false);
  });

  it('reads only valid event payloads', () => {
    expect(readCutJobReadyEvent({ type: 'x' } as Event)).toBeNull();
    const event = { type: 'x', detail: { cutJobId: 1, name: 'J', detailIds: [], orderIds: [] } } as CustomEvent;
    expect(readCutJobReadyEvent(event)?.cutJobId).toBe(1);
  });

  it('delivers a ready event created in another browser tab', () => {
    const listeners = new Map<string, EventListener>();
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn((type: string) => {
        listeners.delete(type);
      }),
    });
    const received = vi.fn();
    const unsubscribe = subscribeCutJobReady(received);
    const payload = {
      cutJobId: 42,
      name: 'Раскрой 42',
      detailIds: [10],
      orderIds: [100],
    };

    listeners.get('storage')?.({
      key: 'erp.cutJobReady.changed',
      newValue: JSON.stringify({ eventId: 'ready-1', payload }),
    } as StorageEvent);

    expect(received).toHaveBeenCalledWith(payload);
    unsubscribe();
    expect(listeners.size).toBe(0);
  });
});
