import { describe, expect, it } from 'vitest';
import {
  CONFIGURATION_SECTION_GROUPS,
  CONFIGURATION_SECTION_LABELS,
  buildConfigurationNav,
  configurationSectionHasOwnHeading,
  filterConfigurationNav,
} from './configurationSections';

describe('configuration sections (NewLine)', () => {
  it('lists every section once and gives each a label', () => {
    const keys = CONFIGURATION_SECTION_GROUPS.flatMap((group) => group.keys);
    expect(new Set(keys).size).toBe(keys.length);
    keys.forEach((key) => expect(CONFIGURATION_SECTION_LABELS[key], key).toBeTruthy());
  });

  it('shows only available sections, grouped in catalog order', () => {
    const nav = buildConfigurationNav(['vlm', 'production', 'orders', 'cut']);
    expect(nav.map((group) => [group.label, group.items.map((item) => item.key)])).toEqual([
      ['Общие', ['orders']],
      ['Производство', ['production', 'cut']],
      ['Другое', ['vlm']],
    ]);
    expect(buildConfigurationNav([])).toEqual([]);
  });

  it('keeps a section missing from the catalog reachable', () => {
    const nav = buildConfigurationNav(['orders', 'brand-new']);
    expect(nav[nav.length - 1]).toEqual({ label: 'Другое', items: [{ key: 'brand-new', label: null }] });
    const withOther = buildConfigurationNav(['vlm', 'brand-new']);
    expect(withOther).toHaveLength(1);
    expect(withOther[0].items.map((item) => item.key)).toEqual(['vlm', 'brand-new']);
  });

  it('searches by section and by group name', () => {
    const nav = buildConfigurationNav(['orders', 'finance', 'production', 'labels', 'brand-new']);
    expect(filterConfigurationNav(nav, ' фин ').flatMap((group) => group.items.map((item) => item.key))).toEqual(['finance']);
    expect(filterConfigurationNav(nav, 'общие').flatMap((group) => group.items.map((item) => item.key))).toEqual(['orders', 'finance']);
    expect(filterConfigurationNav(nav, 'brand')[0].items).toEqual([{ key: 'brand-new', label: null }]);
    expect(filterConfigurationNav(nav, 'нет такого')).toEqual([]);
    expect(filterConfigurationNav(nav, '')).toEqual(nav);
  });

  it('does not repeat the heading of sections that print their own', () => {
    expect(configurationSectionHasOwnHeading('cut')).toBe(true);
    expect(configurationSectionHasOwnHeading('orders')).toBe(false);
  });
});
