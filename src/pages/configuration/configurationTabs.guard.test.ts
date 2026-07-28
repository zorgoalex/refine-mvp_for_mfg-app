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

  it('embeds default schedules into production stages', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'index.tsx'), 'utf8');
    const productionSource = fs.readFileSync(
      path.resolve(__dirname, 'components/ProductionWorkflowTab.tsx'),
      'utf8',
    );

    expect(source).not.toContain("key: 'deadline-defaults'");
    expect(source).not.toContain('<DeadlineDefaultScheduleConfig />');
    expect(productionSource).toContain('Длительность');
    expect(productionSource).toContain('Плановая готовность заказа');
    expect(source).toContain("key: 'deadline-rules'");
  });

  it('keeps visual rows independent from transition-based deadlines', () => {
    const productionSource = fs.readFileSync(
      path.resolve(__dirname, 'components/ProductionWorkflowTab.tsx'),
      'utf8',
    );

    expect(productionSource).toContain('draggable={canManageWorkflow}');
    expect(productionSource).toContain('aria-label={`Перетащить этап ');
    expect(productionSource).not.toMatch(/key=\{code\}\s+draggable=/);
    expect(productionSource).toContain('layout_rows: compactRows');
    expect(productionSource).toContain(
      'transitionsOrder: draft.transitions_order ?? {}',
    );
    expect(productionSource).toContain(
      'Визуальный порядок выше на расчёт не влияет',
    );
  });

  it('shows production stages to deadline viewers without settings access', () => {
    const items = [
      { key: 'orders' },
      { key: 'production' },
      { key: 'deadline-rules' },
    ];

    expect(filterConfigurationTabItems(items, false, true)).toEqual([
      { key: 'production' },
    ]);
    expect(filterConfigurationTabItems(items, true, true)).toEqual(items);
    expect(filterConfigurationTabItems(items, false, false)).toEqual([]);
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
