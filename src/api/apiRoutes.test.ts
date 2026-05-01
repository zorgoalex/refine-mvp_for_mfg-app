import { describe, expect, it } from 'vitest';
import { apiRoutes, backendApiPath, BACKEND_API_PREFIX, BACKEND_API_VERSION } from './apiRoutes';

describe('apiRoutes', () => {
  it('uses explicit path versioning for new backend endpoints', () => {
    expect(BACKEND_API_VERSION).toBe('v1');
    expect(BACKEND_API_PREFIX).toBe('/api/v1');
    expect(backendApiPath('orders')).toBe('/api/v1/orders');
    expect(apiRoutes.auth.login).toBe('/api/v1/auth/login');
    expect(apiRoutes.orders.byId(42)).toBe('/api/v1/orders/42');
    expect(apiRoutes.orders.deadlineSummary(42)).toBe('/api/v1/orders/42/deadline-summary');
    expect(apiRoutes.deadlines.pause('deadline-id')).toBe('/api/v1/deadlines/deadline-id/pause');
    expect(apiRoutes.deadlinePolicies.list).toBe('/api/v1/deadline-policies');
    expect(apiRoutes.deadlineSettings.root).toBe('/api/v1/deadline-settings');
    expect(apiRoutes.users.changePassword(7)).toBe('/api/v1/users/7/change-password');
    expect(apiRoutes.vlm.analyze).toBe('/api/v1/vlm/analyze');
  });
});
