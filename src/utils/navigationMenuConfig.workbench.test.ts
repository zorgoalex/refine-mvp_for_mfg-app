import { describe, expect, it } from 'vitest';
import { MODERN_UI_VARIANTS } from '../ui-variant/uiVariant';
import {
  EVOLUTION_CATEGORY_LABELS,
  EVOLUTION_CATEGORY_MAP,
  EVOLUTION_CATEGORY_ORDER,
  LEGACY_CATEGORY_MAP,
  getEvolutionCategoryLabels,
  getSidebarMenuConfig,
} from './navigationMenuConfig';

describe('workbench navigation config', () => {
  it('gives every modern variant, including workbench, the Evolution category keys and map', () => {
    for (const variant of MODERN_UI_VARIANTS) {
      const config = getSidebarMenuConfig(variant);
      expect(config.categoryOrder).toBe(EVOLUTION_CATEGORY_ORDER);
      expect(config.categoryMap).toBe(EVOLUTION_CATEGORY_MAP);
    }
    expect(getSidebarMenuConfig('legacy').categoryMap).toBe(LEGACY_CATEGORY_MAP);
  });

  it('only renames groups for workbench: same keys, so stored menu order and the settings gate keep working', () => {
    const labels = getEvolutionCategoryLabels('workbench');
    expect(Object.keys(labels).sort()).toEqual([...EVOLUTION_CATEGORY_ORDER].sort());
    expect(labels['Настройки']).toBe('Настройка');
    expect(labels['Данные']).toBe('Справочники');
    for (const variant of ['evolution', 'line', 'air', 'neutral'] as const) {
      expect(getEvolutionCategoryLabels(variant)).toBe(EVOLUTION_CATEGORY_LABELS);
    }
  });
});
