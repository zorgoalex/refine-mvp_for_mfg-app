import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  acquireUiVariantSwitchLock,
  getUiVariantSwitchBlockReason,
  persistUiVariantPreference,
  requireConfirmedUiVariant,
} from './useUiVariantPreference';

const profileSource = readFileSync(new URL('../pages/profile/index.tsx', import.meta.url), 'utf8');
const loginPageSource = readFileSync(new URL('../pages/login/index.tsx', import.meta.url), 'utf8');
const workosCallbackSource = readFileSync(
  new URL('../pages/login/WorkosCallback.tsx', import.meta.url),
  'utf8',
);

describe('per-user UI variant selector', () => {
  it('accepts only an exact server confirmation', () => {
    expect(requireConfirmedUiVariant(
      { preferences: { uiVariant: 'evolution' } },
      'evolution',
    )).toBe('evolution');
    expect(requireConfirmedUiVariant(
      { preferences: { uiVariant: 'line' } },
      'line',
    )).toBe('line');
    expect(requireConfirmedUiVariant(
      { preferences: { uiVariant: 'air' } },
      'air',
    )).toBe('air');
    expect(() => requireConfirmedUiVariant({ preferences: {} }, 'evolution')).toThrow();
    expect(() => requireConfirmedUiVariant(
      { preferences: { uiVariant: 'legacy' } },
      'evolution',
    )).toThrow();
  });

  it('blocks same/saving, unavailable, dirty and unauthenticated switches', () => {
    const allowed = {
      current: 'legacy' as const,
      requested: 'evolution' as const,
      isSaving: false,
      modernUiAvailable: true,
      hasDirtyTabs: false,
      userId: '7',
      hasAccessToken: true,
    };

    expect(getUiVariantSwitchBlockReason(allowed)).toBeNull();
    expect(getUiVariantSwitchBlockReason({ ...allowed, requested: 'legacy' })).toBe('same');
    expect(getUiVariantSwitchBlockReason({ ...allowed, isSaving: true })).toBe('saving');
    expect(getUiVariantSwitchBlockReason({ ...allowed, modernUiAvailable: false }))
      .toBe('unavailable');
    expect(getUiVariantSwitchBlockReason({ ...allowed, requested: 'line' }))
      .toBeNull();
    expect(getUiVariantSwitchBlockReason({ ...allowed, requested: 'air', modernUiAvailable: false }))
      .toBe('unavailable');
    expect(getUiVariantSwitchBlockReason({ ...allowed, hasDirtyTabs: true })).toBe('dirty');
    expect(getUiVariantSwitchBlockReason({ ...allowed, userId: null })).toBe('unauthenticated');
    expect(getUiVariantSwitchBlockReason({ ...allowed, hasAccessToken: false }))
      .toBe('unauthenticated');
  });

  it('acquires the save lock synchronously to block rapid duplicate PATCH calls', () => {
    const lock = { current: false };
    expect(acquireUiVariantSwitchLock(lock)).toBe(true);
    expect(acquireUiVariantSwitchLock(lock)).toBe(false);
    lock.current = false;
    expect(acquireUiVariantSwitchLock(lock)).toBe(true);
  });

  it('persists exact PATCH confirmation, caches for that user, then hard reloads', async () => {
    const updatePreferences = vi.fn(async () => ({
      preferences: { uiVariant: 'air' },
    }));
    const setCached = vi.fn();
    const reload = vi.fn();

    await expect(persistUiVariantPreference('air', '7', {
      updatePreferences,
      getCurrentUserId: () => '7',
      setCached,
      reload,
    })).resolves.toBe('switched');

    expect(updatePreferences).toHaveBeenCalledWith({ uiVariant: 'air' });
    expect(setCached).toHaveBeenCalledWith('7', 'air');
    expect(reload).toHaveBeenCalledOnce();
  });

  it('never caches or reloads an invalid confirmation or stale-user response', async () => {
    const setCached = vi.fn();
    const reload = vi.fn();

    await expect(persistUiVariantPreference('evolution', '7', {
      updatePreferences: async () => ({ preferences: {} }),
      getCurrentUserId: () => '7',
      setCached,
      reload,
    })).rejects.toThrow('Backend did not confirm');
    expect(setCached).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();

    await expect(persistUiVariantPreference('evolution', '7', {
      updatePreferences: async () => ({ preferences: { uiVariant: 'evolution' } }),
      getCurrentUserId: () => '8',
      setCached,
      reload,
    })).resolves.toBe('stale-user');
    expect(setCached).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('renders a controlled accessible radio group with full-size targets', () => {
    expect(profileSource).toContain('<Radio.Group');
    expect(profileSource).toContain('aria-label="Дизайн интерфейса"');
    expect(profileSource).toContain('value={variant}');
    expect(profileSource).toContain('minHeight: 40');
    expect(profileSource).toContain('Классический');
    expect(profileSource).toContain('Новый (Evolutionary)');
    expect(profileSource).toContain('LINE · Деловой минимализм');
    expect(profileSource).toContain('AIR · Светлая динамика');
  });

  it('reboots every successful login at a safe URL before authenticated paint', () => {
    expect(loginPageSource).toContain('mutationOptions: {');
    expect(loginPageSource).toContain('onSuccess: (result)');
    expect(loginPageSource).toContain('postLoginTarget.current = resolvePostLoginTarget(');
    expect(loginPageSource).toContain('resolvePostLoginTarget(');
    expect(loginPageSource).toContain('window.location.assign(');
    expect(loginPageSource).not.toContain('login(values, {');
    expect(workosCallbackSource).toContain('window.location.replace("/")');
    expect(workosCallbackSource).not.toContain('window.location.replace(window.location');
  });
});
