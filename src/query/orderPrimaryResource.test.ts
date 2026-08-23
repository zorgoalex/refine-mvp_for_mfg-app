import { beforeEach, describe, expect, it } from 'vitest';
import { authSession } from '../api/authSession';
import { getAuthCacheNamespace } from './authCacheNamespace';
import { createOrderShowPrimaryIdentity, getOrderShowBackendMode } from './orderPrimaryResource';

describe('order show primary resource contract', () => {
  beforeEach(() => authSession.clear());

  it('builds the primary identity with its auth namespace and feature-gated fields', () => {
    authSession.setUser({ id: '7', username: 'test', role: 'admin', permissions: ['orders.view'] });
    const backendMode = getOrderShowBackendMode(true);
    const identity = createOrderShowPrimaryIdentity({
      orderId: 42,
      projectsEnabled: true,
      authCacheNamespace: getAuthCacheNamespace(backendMode),
    });
    expect(identity.resource).toBe('orders_view');
    expect(identity.meta).toMatchObject({
      idColumnName: 'order_id',
      authCacheNamespace: expect.stringContaining('actor:7'),
    });
    expect(identity.meta.fields).toEqual(expect.arrayContaining(['order_id', 'project_id']));
  });

  it('keeps the backend mode explicit for auth-scoped cache identity', () => {
    expect(getOrderShowBackendMode(true)).toBe('backend-orders-read');
    expect(getOrderShowBackendMode(false)).toBe('hasura-orders-read');
  });
});
