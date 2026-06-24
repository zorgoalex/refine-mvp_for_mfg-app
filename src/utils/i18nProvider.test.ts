import { describe, expect, it } from 'vitest';
import { i18nProvider } from './i18nProvider';

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

  it('maps the other action title suffixes to Russian', () => {
    expect(t('whatever.titles.create', 'Create')).toBe('Создать');
    expect(t('whatever.titles.edit', 'Edit')).toBe('Редактировать');
    expect(t('whatever.titles.show', 'Show')).toBe('Просмотр');
    expect(t('whatever.titles.clone', 'Clone')).toBe('Клонировать');
  });

  it('does not hijack unrelated keys — falls back to defaultMessage then key', () => {
    expect(t('buttons.unknownThing', 'Fallback')).toBe('Fallback');
    expect(t('totally.unknown.key')).toBe('totally.unknown.key');
    // not a *.titles.<suffix> shape → no generic mapping
    expect(t('titles.list')).toBe('Список'); // this exact key IS in the dict
    expect(t('foo.titles.unknownsuffix', 'X')).toBe('X');
  });

  it('reports ru locale', () => {
    expect(i18nProvider.getLocale()).toBe('ru');
  });
});
