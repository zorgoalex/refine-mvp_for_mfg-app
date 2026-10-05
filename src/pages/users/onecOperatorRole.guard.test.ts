import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canViewNavigationResource, canViewSettingsCategory, RESOURCE_PERMISSION_MAP } from '../../utils/navigationPermissions';
import { getSidebarMenuConfig } from '../../utils/navigationMenuConfig';
import { resolveDefaultSiderRoute } from '../../utils/siderMenuItems';
import { CREATION_ONLY_ROLES, isCreationOnlyRole, mapUserRecordToFormData } from './userFormMapping';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const createSource = read('./create.tsx');
const editSource = read('./edit.tsx');

/** Permissions the role gets by default (backend ROLE_PERMISSIONS.onec_operator). */
const operator = {
  role: 'onec_operator',
  permissions: ['profile.view', 'profile.update_own', 'sessions.logout_own', 'onec.view', 'onec.manage', 'onec.commands.send'],
};

describe('role «Оператор интеграции 1С» in the web client', () => {
  it('maps role id 32 and marks the role as assigned only at creation', () => {
    expect(mapUserRecordToFormData({ role_id: 32 }).role).toBe('onec_operator');
    expect(CREATION_ONLY_ROLES).toEqual(['onec_operator']);
    expect(isCreationOnlyRole('onec_operator')).toBe(true);
    expect(isCreationOnlyRole('viewer')).toBe(false);
    expect(isCreationOnlyRole(undefined)).toBe(false);
  });

  it('is offered when a user is created; the edit form locks the role of such an account and offers it to nobody else', () => {
    expect(createSource).toContain('<Select.Option value="onec_operator">');
    expect(editSource).toContain('const roleLocked = isCreationOnlyRole(queryResult?.data?.data?.role);');
    expect(editSource).toContain('<Select placeholder="Выберите роль пользователя" disabled={roleLocked}>');
    // The only option with this value is rendered under the lock.
    expect(editSource.match(/value="onec_operator"/g)).toHaveLength(1);
    expect(editSource).toMatch(/\{roleLocked && \(\s*<Select\.Option value="onec_operator">/);
  });

  it('shows the operator exactly one section — «Интеграция 1С» — and lands on it', () => {
    // The «Настройки» category opens for the 1C permission; settings.view is not needed.
    expect(canViewSettingsCategory(operator, true, false)).toBe(true);
    expect(canViewSettingsCategory({ permissions: ['profile.view'] }, true, false)).toBe(false);

    const visible = Object.keys(RESOURCE_PERMISSION_MAP).filter((name) => canViewNavigationResource(name, operator, true, false));
    expect(visible).toEqual(['onec']);

    for (const variant of ['classic', 'workbench'] as const) {
      const config = getSidebarMenuConfig(variant as never);
      expect(config.categoryMap.onec, variant).toBe('Настройки');
      expect(
        resolveDefaultSiderRoute({
          topOrder: ['orders_view', 'calendar', 'order-status-board'],
          topRoutes: {},
          categorizedResources: { Настройки: [{ name: 'onec', label: 'Интеграция 1С', route: '/onec' }] },
          categoryOrder: config.categoryOrder,
          fallback: '/orders',
        }),
        variant,
      ).toBe('/onec');
    }
  });
});
