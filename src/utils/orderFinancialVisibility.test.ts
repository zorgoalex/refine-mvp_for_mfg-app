import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { featureFlags } from '../config/featureFlags';
import {
  canManageOrderContent,
  canViewOrderFinancials,
  filterOrderFinancialItems,
  getOrderFinancialVisibilityOverride,
  normalizeOrderFinancialVisibilityMatrix,
  resolveOrderFinancialVisibility,
  setOrderFinancialVisibilityOverride,
} from './orderFinancialVisibility';

describe('filterOrderFinancialItems', () => {
  const items = [
    { key: 'order_name' },
    { key: 'payment_status_name' },
    { key: 'final_amount' },
    { key: 'actions' },
  ];

  it('removes financial fields when the layer is unavailable', () => {
    expect(filterOrderFinancialItems(items, false).map((item) => item.key)).toEqual([
      'order_name',
      'actions',
    ]);
  });

  it('keeps all fields when the layer is available', () => {
    expect(filterOrderFinancialItems(items, true)).toEqual(items);
  });
});

describe('order financial permission helpers', () => {
  const previousBackendPermissions = featureFlags.useBackendPermissions;

  beforeAll(() => {
    featureFlags.useBackendPermissions = true;
  });

  afterAll(() => {
    featureFlags.useBackendPermissions = previousBackendPermissions;
  });

  it('requires orders.view_financials when backend permissions are enabled', () => {
    expect(canViewOrderFinancials({ permissions: ['orders.view'] })).toBe(false);
    expect(canViewOrderFinancials({ permissions: ['orders.view_financials'] })).toBe(true);
  });

  it('requires both content and financial permissions for full order editing', () => {
    expect(canManageOrderContent('orders.update', {
      permissions: ['orders.update'],
    })).toBe(false);
    expect(canManageOrderContent('orders.update', {
      permissions: ['orders.update', 'orders.view_financials'],
    })).toBe(true);
  });
});

describe('order financial visibility matrix', () => {
  const user = {
    id: '42',
    role: 'manager',
    permissions: ['orders.view_financials'],
  };

  it('uses account override before role override', () => {
    expect(resolveOrderFinancialVisibility({
      baseAllowed: true,
      user,
      matrix: { version: 1, roles: { manager: false }, users: { '42': true } },
    })).toBe(true);
  });

  it('uses role override when the account inherits', () => {
    expect(resolveOrderFinancialVisibility({
      baseAllowed: true,
      user,
      matrix: { version: 1, roles: { manager: false }, users: {} },
    })).toBe(false);
  });

  it('never grants access missing from base permissions', () => {
    expect(resolveOrderFinancialVisibility({
      baseAllowed: false,
      user,
      matrix: { version: 1, roles: { manager: true }, users: { '42': true } },
    })).toBe(false);
  });

  it('normalizes malformed values and supports removing an override', () => {
    const normalized = normalizeOrderFinancialVisibilityMatrix({
      roles: { manager: false, operator: 'yes' },
      users: { 42: true, 43: null },
    });
    expect(normalized).toEqual({
      version: 1,
      roles: { manager: false },
      users: { '42': true },
    });

    const denied = setOrderFinancialVisibilityOverride(normalized, 'users', 42, 'deny');
    expect(getOrderFinancialVisibilityOverride(denied, 'users', 42)).toBe('deny');
    const inherited = setOrderFinancialVisibilityOverride(denied, 'users', 42, 'inherit');
    expect(getOrderFinancialVisibilityOverride(inherited, 'users', 42)).toBe('inherit');
  });
});
