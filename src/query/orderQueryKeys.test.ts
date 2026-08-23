import { describe, expect, it } from 'vitest';
import { legacyOrderPrimaryQueryKey, orderPrimaryQueryKey } from './orderQueryKeys';

describe('order primary query keys', () => {
  it('uses Refine public keys() with exact resource, id and meta', () => {
    const input = {
      orderId: 42,
      meta: { idColumnName: 'order_id', authCacheNamespace: 'actor:7|session:2|scope:abc' },
    };
    expect(orderPrimaryQueryKey(input)).toEqual([
      'data',
      'default',
      'orders_view',
      'one',
      '42',
      input.meta,
    ]);
    expect(legacyOrderPrimaryQueryKey(input)).toEqual([
      'default',
      'orders_view',
      'detail',
      '42',
      input.meta,
    ]);
  });
});
