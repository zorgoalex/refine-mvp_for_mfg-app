import { describe, expect, it } from 'vitest';
import {
  USER_VISIBILITY_KEY,
  buildInitialResourceVisibility,
  canViewResourceByRoleVisibility,
  canViewResourceForUser,
  clearUserVisibilityOverrides,
  countUserVisibilityOverrides,
  getUserVisibilityOverride,
  normalizeRoleVisibilityMatrix,
  setUserVisibilityOverride,
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

  describe('per-user overrides', () => {
    const base: RoleVisibilityMatrix = { orders_view: { manager: false, operator: true }, cad: { manager: false } };

    it('lets a personal override win over the role rule in both directions', () => {
      let matrix = setUserVisibilityOverride(base, 'orders_view', 42, 'show');
      matrix = setUserVisibilityOverride(matrix, 'calendar', '7', 'hide');
      expect(canViewResourceForUser('orders_view', { id: '42', role: 'manager' }, matrix)).toBe(true);
      expect(canViewResourceForUser('orders_view', { id: '43', role: 'manager' }, matrix)).toBe(false);
      expect(canViewResourceForUser('calendar', { id: 7, role: 'operator' }, matrix)).toBe(false);
      expect(canViewResourceForUser('calendar', { id: 8, role: 'operator' }, matrix)).toBe(true);
      // CAD default (admin-only) can be opened for one user.
      expect(canViewResourceForUser('cad', { id: '42', role: 'manager' }, setUserVisibilityOverride(matrix, 'cad', 42, 'show'))).toBe(true);
    });

    it('falls back to the role rule without a user id or override (same as before)', () => {
      const matrix = setUserVisibilityOverride(base, 'orders_view', 42, 'show');
      for (const role of ['manager', 'operator', 'worker', 'admin', undefined]) {
        for (const resource of ['orders_view', 'calendar', 'cad']) {
          expect(canViewResourceForUser(resource, { role }, matrix)).toBe(canViewResourceByRoleVisibility(resource, role, base));
          expect(canViewResourceForUser(resource, { id: 99, role }, matrix)).toBe(canViewResourceByRoleVisibility(resource, role, base));
        }
      }
      expect(canViewResourceForUser('orders_view', { roleId: 10 }, base)).toBe(false);
      expect(canViewResourceForUser('orders_view', null, null)).toBe(true);
    });

    it('reads and writes overrides; inherit removes them and empty containers', () => {
      let matrix = setUserVisibilityOverride(base, 'orders_view', 42, 'hide');
      expect(getUserVisibilityOverride(matrix, 'orders_view', '42')).toBe('hide');
      expect(getUserVisibilityOverride(matrix, 'orders_view', 43)).toBe('inherit');
      matrix = setUserVisibilityOverride(matrix, 'calendar', 42, 'show');
      expect(countUserVisibilityOverrides(matrix, 42)).toBe(2);
      matrix = setUserVisibilityOverride(matrix, 'orders_view', 42, 'inherit');
      matrix = setUserVisibilityOverride(matrix, 'calendar', 42, 'inherit');
      expect(matrix).toEqual(base);
      expect(USER_VISIBILITY_KEY in matrix).toBe(false);
      expect(base).toEqual({ orders_view: { manager: false, operator: true }, cad: { manager: false } });
    });

    it('reset clears the user on every stored screen, also ones not registered now, and keeps others', () => {
      let matrix = setUserVisibilityOverride(base, 'projects', 42, 'show'); // e.g. a screen behind a disabled flag
      matrix = setUserVisibilityOverride(matrix, 'orders_view', 42, 'hide');
      matrix = setUserVisibilityOverride(matrix, 'orders_view', 7, 'show');
      const cleared = clearUserVisibilityOverrides(matrix, '42');
      expect(countUserVisibilityOverrides(cleared, 42)).toBe(0);
      expect(getUserVisibilityOverride(cleared, 'projects', 42)).toBe('inherit');
      expect(getUserVisibilityOverride(cleared, 'orders_view', 7)).toBe('show');
      expect(clearUserVisibilityOverrides(cleared, 7)).toEqual(base);
    });

    it('normalizes the stored setting: keeps valid overrides, drops junk, keeps the legacy role format', () => {
      const stored = {
        orders_view: { manager: false },
        [USER_VISIBILITY_KEY]: { orders_view: { 42: true, 'x': true, 43: 'no' }, calendar: [], cad: { 7: false } },
      };
      const matrix = normalizeRoleVisibilityMatrix(stored);
      expect(matrix.orders_view).toEqual({ manager: false });
      expect((matrix as Record<string, unknown>)[USER_VISIBILITY_KEY]).toEqual({ orders_view: { 42: true }, cad: { 7: false } });
      expect(normalizeRoleVisibilityMatrix({ orders_view: { manager: false } })).toEqual({ orders_view: { manager: false } });
      expect(normalizeRoleVisibilityMatrix(null)).toEqual({});
    });

    it('keeps personal overrides when the role checkboxes are saved (whole setting is rewritten)', () => {
      const stored = setUserVisibilityOverride(base, 'orders_view', 42, 'show');
      const rebuilt = buildInitialResourceVisibility(
        [{ name: 'orders_view' }, { name: 'calendar' }],
        [{ role_id: 10 }, { role_id: 11 }],
        normalizeRoleVisibilityMatrix(stored),
      );
      expect((rebuilt as Record<string, unknown>)[USER_VISIBILITY_KEY]).toEqual({ orders_view: { 42: true } });
      expect(rebuilt.orders_view).toEqual({ manager: false, operator: true });
      expect(canViewResourceForUser('orders_view', { id: 42, role: 'manager' }, rebuilt)).toBe(true);
    });

    it('an older client reading the new setting sees the reserved entry as an unknown resource', () => {
      const stored = setUserVisibilityOverride(base, 'orders_view', 42, 'hide');
      for (const role of ['manager', 'operator']) {
        expect(canViewResourceByRoleVisibility('orders_view', role, stored)).toBe(canViewResourceByRoleVisibility('orders_view', role, base));
      }
    });
  });
});
