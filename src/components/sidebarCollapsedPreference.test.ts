import { describe, expect, it, vi } from 'vitest';
import {
  loadSidebarCollapsed,
  saveSidebarCollapsed,
  sidebarCollapsedStorageKey,
} from './sidebarCollapsedPreference';

describe('sidebarCollapsedPreference', () => {
  it('scopes collapsed state by user id', () => {
    expect(sidebarCollapsedStorageKey('7')).toBe('erp.sidebar.collapsed.7');
    expect(sidebarCollapsedStorageKey('8')).toBe('erp.sidebar.collapsed.8');
  });

  it('loads explicit values and keeps caller default for absent or unknown values', () => {
    const storage = {
      getItem: vi.fn((key: string) => {
        if (key.endsWith('.7')) return 'true';
        if (key.endsWith('.8')) return 'false';
        if (key.endsWith('.9')) return 'bad';
        return null;
      }),
    };

    expect(loadSidebarCollapsed('7', false, storage)).toBe(true);
    expect(loadSidebarCollapsed('8', true, storage)).toBe(false);
    expect(loadSidebarCollapsed('9', true, storage)).toBe(true);
    expect(loadSidebarCollapsed('10', false, storage)).toBe(false);
  });

  it('saves only when a user id is available', () => {
    const storage = { setItem: vi.fn() };

    saveSidebarCollapsed('7', true, storage);
    saveSidebarCollapsed(null, false, storage);

    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledWith('erp.sidebar.collapsed.7', 'true');
  });

  it('survives unavailable storage', () => {
    expect(loadSidebarCollapsed('7', true, { getItem: () => { throw new Error('locked'); } })).toBe(true);
    expect(() => saveSidebarCollapsed('7', false, { setItem: () => { throw new Error('locked'); } })).not.toThrow();
  });
});
