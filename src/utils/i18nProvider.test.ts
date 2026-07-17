import { describe, expect, it } from 'vitest';
import { i18nProvider, REFERENCE_RESOURCE_LABELS } from './i18nProvider';

const t = (key: string, defaultMessage?: string) =>
  i18nProvider.translate(key, undefined, defaultMessage);

describe('i18nProvider.translate', () => {
  it('returns explicit dictionary entries', () => {
    expect(t('buttons.list')).toBe('Список');
    expect(t('buttons.refresh')).toBe('Обновить');
    expect(t('actions.edit')).toBe('Редактировать');
  });

  it('maps any "<resource>.titles.list" to Russian (no English userFriendlyResourceName fallback)', () => {
    // resources NOT enumerated in the dict must still be Russian — this is the back-to-list button label
    for (const resource of [
      'doweling_orders_view',
      'sheet_material_types',
      'order_workshops',
      'order_resource_requirements',
      'clients_analytics',
      'payments_analytics',
      'orders',
      'some_future_resource',
    ]) {
      expect(t(`${resource}.titles.list`, 'Doweling Orders')).toBe('Список');
    }
  });

  it('maps create/edit page headers for every reference resource to Russian', () => {
    expect(Object.keys(REFERENCE_RESOURCE_LABELS)).toHaveLength(22);
    for (const [resource, label] of Object.entries(REFERENCE_RESOURCE_LABELS)) {
      expect(t(`${resource}.titles.create`, `${resource}.titles.create`)).toBe(`Создать ${label}`);
      expect(t(`${resource}.titles.edit`, `${resource}.titles.edit`)).toBe(`Редактировать ${label}`);
    }
    expect(t('materials.titles.create')).toBe('Создать материал');
    expect(t('films.titles.create')).toBe('Создать плёнку');
    expect(t('order_statuses.titles.create')).toBe('Создать статус заказа');
    expect(t('units.titles.create')).toBe('Создать единицу измерения');
  });

  it('does not remap non-reference create/edit or any show/clone title', () => {
    expect(t('whatever.titles.edit', 'Edit Whatever')).toBe('Edit Whatever');
    expect(t('whatever.titles.show', 'Show Whatever')).toBe('Show Whatever');
    expect(t('whatever.titles.clone', 'Clone Whatever')).toBe('Clone Whatever');
  });

  it('does not hijack unrelated keys — falls back to defaultMessage then key', () => {
    expect(t('buttons.unknownThing', 'Fallback')).toBe('Fallback');
    expect(t('totally.unknown.key')).toBe('totally.unknown.key');
    expect(t('titles.list')).toBe('Список'); // this exact key IS in the dict
  });

  it('reports ru locale', () => {
    expect(i18nProvider.getLocale()).toBe('ru');
  });
});
