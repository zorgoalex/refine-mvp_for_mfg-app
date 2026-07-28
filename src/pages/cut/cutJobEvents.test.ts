import { describe, expect, it } from 'vitest';
import { buildCutJobReadyPayload, cutJobReadyAffects, readCutJobReadyEvent } from './cutJobEvents';

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
});
