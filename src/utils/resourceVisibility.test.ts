import { describe, expect, it } from 'vitest';
import {
  buildInitialResourceVisibility,
  canViewResourceByRoleVisibility,
  getMenuResources,
  normalizeRoleKey,
  type RoleVisibilityMatrix,
} from './resourceVisibility';

describe('resource visibility matrix', () => {
  it('registers CAD with matching admin-only defaults in menu and configuration', () => {
    const resources = getMenuResources([{ name: 'cad', list: '/cad', meta: { label: 'CAD' } }], {});
    expect(resources).toEqual([{ name: 'cad', label: 'CAD', route: '/cad' }]);
    const roles = [1, 2, 10, 11, 15, 20, 30, 100, 999].map(role_id => ({ role_id }));
    const matrix = buildInitialResourceVisibility(resources, roles, {});
    for (const role of roles) {
      const roleKey = normalizeRoleKey(role), expected = role.role_id === 1 || role.role_id === 2;
      expect(matrix.cad[roleKey]).toBe(expected);
      expect(canViewResourceByRoleVisibility('cad', roleKey, null)).toBe(expected);
      expect(canViewResourceByRoleVisibility('cad', roleKey, { cad: {} })).toBe(expected);
    }
    expect(canViewResourceByRoleVisibility('cad', undefined, null)).toBe(false);
  });

  it('preserves explicit CAD visibility overrides without changing other defaults', () => {
    const matrix = { cad: { manager: true, admin: false } };
    expect(canViewResourceByRoleVisibility('cad', 'manager', matrix)).toBe(true);
    expect(canViewResourceByRoleVisibility('cad', 'admin', matrix)).toBe(false);
    expect(canViewResourceByRoleVisibility('cad', 'worker', matrix)).toBe(false);
    expect(canViewResourceByRoleVisibility('orders_view', 'worker', matrix)).toBe(true);
  });
  it('keeps navigation visible when no matrix exists yet', () => {
    expect(canViewResourceByRoleVisibility('orders_view', 'manager', null)).toBe(true);
    expect(canViewResourceByRoleVisibility('orders_view', undefined, undefined)).toBe(true);
  });

  it('hides a resource when the current role checkbox is false', () => {
    const matrix: RoleVisibilityMatrix = {
      orders_view: { manager: true, operator: false },
    };

    expect(canViewResourceByRoleVisibility('orders_view', 'manager', matrix)).toBe(true);
    expect(canViewResourceByRoleVisibility('orders_view', 'operator', matrix)).toBe(false);
  });

  it('defaults missing resource or role cells to visible for backwards compatibility', () => {
    const matrix: RoleVisibilityMatrix = {
      orders_view: { manager: false },
    };

    expect(canViewResourceByRoleVisibility('calendar', 'manager', matrix)).toBe(true);
    expect(canViewResourceByRoleVisibility('orders_view', 'operator', matrix)).toBe(true);
  });

  it('normalizes known role ids to canonical backend role names', () => {
    expect(normalizeRoleKey({ role_id: 10, role_name: 'Менеджер' })).toBe('manager');
    expect(normalizeRoleKey({ role_id: 30, role_name: 'Упаковщик' })).toBe('packer');
    expect(normalizeRoleKey({ role_id: 100, role_name: 'Наблюдатель' })).toBe('viewer');
    expect(normalizeRoleKey({ role_id: 999, role_name: 'Custom' })).toBe('999');
  });

  it('builds an editable matrix with all visible menu resources and role columns', () => {
    const matrix = buildInitialResourceVisibility(
      [
        { name: 'orders_view' },
        { name: 'calendar' },
      ],
      [
        { role_id: 10, role_name: 'Менеджер' },
        { role_id: 11, role_name: 'Оператор' },
      ],
      { orders_view: { manager: false } },
    );

    expect(matrix).toEqual({
      orders_view: { manager: false, operator: true },
      calendar: { manager: true, operator: true },
    });
  });

  it('includes configured virtual links such as Bitrix in the editable matrix', () => {
    expect(
      getMenuResources(
        [{ name: 'orders_view', list: '/orders' } as any],
        { orders_view: 'Заказы' },
        [{ name: 'crm', label: 'Битрикс24', route: 'https://example.bitrix24.kz/' }],
      ),
    ).toEqual([
      { name: 'crm', label: 'Битрикс24', route: 'https://example.bitrix24.kz/' },
      { name: 'orders_view', label: 'Заказы', route: '/orders' },
    ]);
  });
});
