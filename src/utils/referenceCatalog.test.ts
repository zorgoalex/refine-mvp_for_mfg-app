import { describe, expect, it } from 'vitest';
import { EVOLUTION_CATEGORY_MAP } from './navigationMenuConfig';
import {
  REFERENCE_DESCRIPTIONS,
  REFERENCE_GROUPS,
  buildReferenceRail,
  filterReferenceRail,
  findReferenceByPath,
  referenceGroupLabel,
} from './referenceCatalog';
import { RESOURCE_LABELS } from './tabLabels';

const item = (name: string, route: string) => ({ name, label: RESOURCE_LABELS[name] ?? name, route });

describe('reference catalog of the NewLine rail', () => {
  it('lists every reference once and describes each of them', () => {
    const all = REFERENCE_GROUPS.flatMap((group) => group.resources);
    expect(new Set(all).size).toBe(all.length);
    all.forEach((name) => {
      expect(RESOURCE_LABELS[name], name).toBeTruthy();
      expect(REFERENCE_DESCRIPTIONS[name], name).toBeTruthy();
    });
  });

  it('covers every screen of the menu category «Данные» except the orders trash', () => {
    const all = new Set(REFERENCE_GROUPS.flatMap((group) => group.resources));
    const missing = Object.entries(EVOLUTION_CATEGORY_MAP)
      .filter(([, category]) => category === 'Данные')
      .map(([name]) => name)
      .filter((name) => !all.has(name));
    expect(missing).toEqual(['orders-trash']);
  });

  it('shows only screens the menu already shows, grouped in catalog order', () => {
    const groups = buildReferenceRail({
      CRM: [item('suppliers', '/suppliers'), item('clients', '/clients')],
      Данные: [item('units', '/units'), item('materials', '/materials'), item('orders-trash', '/orders/trash'), item('new_reference', '/new-reference')],
      Настройки: [],
    });
    expect(groups.map((group) => [group.label, group.items.map((entry) => entry.name)])).toEqual([
      ['Материалы', ['materials', 'units']],
      ['Партнёры', ['suppliers']],
      ['Прочее', ['new_reference']],
    ]);
  });

  it('matches the list route only, not a record or a form', () => {
    const groups = buildReferenceRail({ Данные: [item('milling_types', '/milling-types')] });
    expect(findReferenceByPath(groups, '/milling-types')?.name).toBe('milling_types');
    expect(findReferenceByPath(groups, '/milling-types/')?.name).toBe('milling_types');
    expect(findReferenceByPath(groups, '/milling-types/edit/5')).toBeNull();
    expect(findReferenceByPath(groups, '/orders')).toBeNull();
  });

  it('filters by name and drops empty groups', () => {
    const groups = buildReferenceRail({ Данные: [item('milling_types', '/milling-types'), item('order_statuses', '/order-statuses')] });
    expect(filterReferenceRail(groups, ' СТАТУС ').map((group) => group.label)).toEqual(['Статусы']);
    expect(filterReferenceRail(groups, '')).toHaveLength(2);
    expect(filterReferenceRail(groups, 'нет такого')).toEqual([]);
  });

  it('names the group of a reference and nothing for other screens', () => {
    expect(referenceGroupLabel('milling_types')).toBe('Материалы');
    expect(referenceGroupLabel('orders_view')).toBeNull();
    expect(referenceGroupLabel(undefined)).toBeNull();
  });
});
