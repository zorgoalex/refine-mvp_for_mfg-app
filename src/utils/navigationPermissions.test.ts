import { describe, expect, it } from 'vitest';
import {
  canViewNavigationResource,
  canViewSettingsCategory,
} from './navigationPermissions';

describe('navigation permissions', () => {
  it('keeps legacy navigation visible while backend permissions are disabled', () => {
    expect(canViewNavigationResource('users', null, false)).toBe(true);
    expect(canViewSettingsCategory(null, false, true)).toBe(true);
    expect(canViewSettingsCategory(null, false, false)).toBe(false);
  });

  it('uses permissions for settings category in backend mode', () => {
    expect(
      canViewSettingsCategory({ permissions: ['users.view'] }, true, false),
    ).toBe(true);
    expect(
      canViewSettingsCategory({ permissions: ['orders.view'] }, true, true),
    ).toBe(false);
  });

  it('uses explicit resource permissions and falls back to references.view', () => {
    expect(
      canViewNavigationResource('users', { permissions: ['users.view'] }, true),
    ).toBe(true);
    expect(
      canViewNavigationResource('users', { permissions: ['settings.manage'] }, true),
    ).toBe(false);
    expect(
      canViewNavigationResource('materials', { permissions: ['references.view'] }, true),
    ).toBe(true);
    expect(
      canViewNavigationResource('materials', { permissions: ['orders.view'] }, true),
    ).toBe(false);
  });
});
