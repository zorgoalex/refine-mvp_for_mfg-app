import { describe, expect, it } from 'vitest';
import { apiRoutes, backendApiPath, BACKEND_API_PREFIX, BACKEND_API_VERSION } from './apiRoutes';

describe('apiRoutes', () => {
  it('uses explicit path versioning for new backend endpoints', () => {
    expect(BACKEND_API_VERSION).toBe('v1');
    expect(BACKEND_API_PREFIX).toBe('/api/v1');
    expect(backendApiPath('orders')).toBe('/api/v1/orders');
    expect(apiRoutes.auth.login).toBe('/api/v1/auth/login');
    expect(apiRoutes.orders.formData).toBe('/api/v1/orders/form-data');
    expect(apiRoutes.orders.byId(42)).toBe('/api/v1/orders/42');
    expect(apiRoutes.orders.status(42)).toBe('/api/v1/orders/42/status');
    expect(apiRoutes.orders.calendarDate(42)).toBe('/api/v1/orders/42/calendar-date');
    expect(apiRoutes.orders.orderStatus(42)).toBe('/api/v1/orders/42/order-status');
    expect(apiRoutes.orders.productionStageEvent(42, 7)).toBe(
      '/api/v1/orders/42/production-stage-events/7',
    );
    expect(apiRoutes.payments.byId(42)).toBe('/api/v1/payments/42');
    expect(apiRoutes.clientPhones.byId(42)).toBe('/api/v1/client-phones/42');
    expect(apiRoutes.orders.deadlineSummary(42)).toBe('/api/v1/orders/42/deadline-summary');
    expect(apiRoutes.orders.deadlineEffectiveRules(42)).toBe(
      '/api/v1/orders/42/deadline-effective-rules',
    );
    expect(apiRoutes.orders.deadlineActionPreview(42)).toBe(
      '/api/v1/orders/42/deadline-action-preview',
    );
    expect(apiRoutes.orders.deadlineOverrides(42)).toBe(
      '/api/v1/orders/42/deadline-overrides',
    );
    expect(apiRoutes.orders.deadlineOverride(42, 'override-id')).toBe(
      '/api/v1/orders/42/deadline-overrides/override-id',
    );
    expect(apiRoutes.deadlines.pause('deadline-id')).toBe('/api/v1/deadlines/deadline-id/pause');
    expect(apiRoutes.deadlinePolicies.list).toBe('/api/v1/deadline-policies');
    expect(apiRoutes.deadlineSettings.root).toBe('/api/v1/deadline-settings');
    expect(apiRoutes.deadlineTransitionRules.list).toBe('/api/v1/deadline-transition-rules');
    expect(apiRoutes.deadlineTransitionRules.byId('rule-id')).toBe(
      '/api/v1/deadline-transition-rules/rule-id',
    );
    expect(apiRoutes.projects.list).toBe('/api/v1/projects');
    expect(apiRoutes.projects.lookup).toBe('/api/v1/projects/lookup');
    expect(apiRoutes.projects.byId('project-id')).toBe('/api/v1/projects/project-id');
    expect(apiRoutes.projects.overview('11111111-1111-4111-8111-111111111111')).toBe(
      '/api/v1/projects/11111111-1111-4111-8111-111111111111/overview',
    );
    expect(apiRoutes.orders.autoProductionStatusMode(42)).toBe('/api/v1/orders/42/production-status-mode/auto');
    expect(apiRoutes.orders.manualProductionStatusMode(42)).toBe('/api/v1/orders/42/production-status-mode/manual');
    expect(apiRoutes.users.changePassword(7)).toBe('/api/v1/users/7/change-password');
    expect(apiRoutes.vlm.analyze).toBe('/api/v1/vlm/analyze');
  });
});
