import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  active: true,
  useAppSettings: vi.fn(() => ({ marker: 'settings' })),
}));

vi.mock('../query/orderLifecycleQueries', () => ({
  useOrderLifecycleReadActive: () => harness.active,
}));

vi.mock('./useAppSettings', () => ({
  useAppSettings: harness.useAppSettings,
}));

import { useOrderAppSettings } from './useOrderAppSettings';

describe('useOrderAppSettings', () => {
  beforeEach(() => {
    harness.active = true;
    harness.useAppSettings.mockClear();
  });

  it('disables the app_settings read outside the active order surface', () => {
    harness.active = false;

    expect(useOrderAppSettings()).toEqual({ marker: 'settings' });
    expect(harness.useAppSettings).toHaveBeenCalledWith({ enabled: false });
  });

  it('keeps the settings read enabled for active/control order consumers', () => {
    useOrderAppSettings();

    expect(harness.useAppSettings).toHaveBeenCalledWith({ enabled: true });
  });
});
