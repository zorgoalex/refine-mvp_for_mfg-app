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

  it('NARROW scope: does NOT remap create/edit/show/clone titles (Refine uses them for page H3 headers)', () => {
    // These must fall through to Refine's defaultMessage so resource-specific page headers are preserved.
    expect(t('clients.titles.create', 'Создать клиента')).toBe('Создать клиента');
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
