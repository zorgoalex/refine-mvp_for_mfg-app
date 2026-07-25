import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CONFIGURATION_ACTIVE_TAB_STORAGE_KEY,
  filterConfigurationTabItems,
  resolveConfigurationActiveTab,
} from './index';

describe('configuration tabs layout', () => {
  it('uses a wrapping tab bar so configuration tabs do not require horizontal scrolling', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'index.tsx'), 'utf8');

    expect(source).toContain('configuration-tabs-wrap');
    expect(source).toContain("tabBarGutter={4}");
  });

  it('registers the table visibility tab in the configuration screen', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'index.tsx'), 'utf8');

    expect(source).toContain("key: 'table-visibility'");
    expect(source).toContain('Видимость таблиц для юзеров');
    expect(source).toContain('<TableVisibilityByRoleTab />');
  });

  it('keeps default schedules separate from transition rules', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'index.tsx'), 'utf8');

    expect(source).toContain("key: 'deadline-defaults'");
    expect(source).toContain('Сроки по умолчанию');
    expect(source).toContain('<DeadlineDefaultScheduleConfig />');
    expect(source).toContain("key: 'deadline-rules'");
  });

  it('shows only deadline defaults to deadline viewers without settings access', () => {
    const items = [
      { key: 'orders' },
      { key: 'deadline-defaults' },
      { key: 'deadline-rules' },
    ];

    expect(filterConfigurationTabItems(items, false)).toEqual([
      { key: 'deadline-defaults' },
    ]);
    expect(filterConfigurationTabItems(items, true)).toEqual(items);
  });

  it('restores the last active configuration tab when it is still available', () => {
    expect(CONFIGURATION_ACTIVE_TAB_STORAGE_KEY).toBe('configuration:activeTab');
    expect(resolveConfigurationActiveTab('cut', ['orders', 'cut', 'labels'])).toBe('cut');
  });

  it('falls back to the first available configuration tab when the stored tab is unavailable', () => {
    expect(resolveConfigurationActiveTab('labels', ['orders', 'cut'])).toBe('orders');
    expect(resolveConfigurationActiveTab(null, ['orders', 'cut'])).toBe('orders');
  });
});
