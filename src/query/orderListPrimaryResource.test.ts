import { describe, expect, it } from 'vitest';

import {
  createOrderListPrimaryIdentity,
  ORDER_LIST_INITIAL_SORTERS,
  orderListPrimaryQueryKey,
  parseRefineRouteParamsFromSearch,
} from './orderListPrimaryResource';

describe('order list primary resource', () => {
  it('uses persisted URL pagination, filters and sorting in the exact Refine key', () => {
    const search = '?current=4&pageSize=50&filters[0][field]=client_id&filters[0][operator]=eq&filters[0][value]=17';
    const identity = createOrderListPrimaryIdentity({
      search,
      routeParams: { view: 'cards' },
      preferredPageSize: 20,
      authCacheNamespace: 'actor:7|session:2|scope:abc|mode:backend-orders-read',
    });

    expect(identity.pagination).toEqual({ current: 4, pageSize: 50, mode: 'server' });
    expect(identity.filters).toEqual([{ field: 'client_id', operator: 'eq', value: '17' }]);
    expect(identity.sorters).toEqual(ORDER_LIST_INITIAL_SORTERS);
    expect(identity.meta).toMatchObject({ view: 'cards', authCacheNamespace: expect.any(String) });
    expect(orderListPrimaryQueryKey(identity)).toEqual([
      'data',
      'default',
      'orders_view',
      'list',
      {
        ...identity.meta,
        filters: identity.filters,
        hasPagination: true,
        pagination: identity.pagination,
        sorters: identity.sorters,
      },
    ]);
  });

  it('uses the authenticated user page-size preference when URL has no page size', () => {
    const identity = createOrderListPrimaryIdentity({
      search: '',
      preferredPageSize: 25,
      authCacheNamespace: 'actor:7',
    });
    expect(identity.pagination.pageSize).toBe(25);
  });

  it('falls back safely for malformed pagination', () => {
    const identity = createOrderListPrimaryIdentity({
      search: '?current=abc&pageSize=not-a-number',
      preferredPageSize: 25,
      authCacheNamespace: 'actor:7',
    });
    expect(identity.pagination).toEqual({ current: 1, pageSize: 25, mode: 'server' });
  });

  it('mirrors Refine nested query parsing without table params in meta', () => {
    const routeParams = parseRefineRouteParamsFromSearch(
      '?current=3&pageSize=50&filters[0][field]=client_id&filters[0][operator]=eq'
      + '&filters[0][value]=17&view[mode]=cards&to=%252Forders',
    );
    const identity = createOrderListPrimaryIdentity({
      search: '?current=3&pageSize=50&filters[0][field]=client_id'
        + '&filters[0][operator]=eq&filters[0][value]=17',
      routeParams,
      authCacheNamespace: 'actor:7',
    });
    expect(routeParams).toMatchObject({
      current: 3,
      pageSize: 50,
      filters: [{ field: 'client_id', operator: 'eq', value: '17' }],
      view: { mode: 'cards' },
      to: '/orders',
    });
    expect(identity.meta).toMatchObject({ view: { mode: 'cards' }, to: '/orders' });
    expect(identity.meta).not.toHaveProperty('filters');
  });
});
