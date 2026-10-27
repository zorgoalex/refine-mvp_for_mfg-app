import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { i18nProvider, REFERENCE_RESOURCE_LABELS, RESOURCE_NOTIFICATION_NAMES } from './i18nProvider';

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

  // Refine's useTranslate: `provider.translate(key, params, default) ?? default ?? (string params) ?? key`.
  const refineTranslate = (key: string, params?: unknown, defaultMessage?: string) =>
    i18nProvider.translate(key, params as any, defaultMessage) ??
    defaultMessage ??
    (typeof params === 'string' ? params : key);

  it('renders Refine CRUD notifications in Russian with the resource name (as Refine calls them)', () => {
    const resource = refineTranslate('suppliers.suppliers', 'supplier');
    expect(resource).toBe('поставщик');
    expect(refineTranslate('notifications.editSuccess', { resource }, 'Successfully updated supplier')).toBe('Сохранено: поставщик');
    expect(refineTranslate('notifications.createSuccess', { resource: refineTranslate('clients.clients', 'client') }, 'x')).toBe('Создано: клиент');
    expect(refineTranslate('notifications.deleteSuccess', { resource: refineTranslate('films.films', 'film') }, 'x')).toBe('Удалено: плёнка');
    // two-argument form: the success description used to come back as the raw key "notifications.success"
    expect(refineTranslate('notifications.success', 'Successful')).toBe('Успешно');
  });

  it('falls back to a neutral «запись» for unknown or raw (Latin) resource names', () => {
    const unknown = refineTranslate('some_future_resource.some_future_resource', 'some future resource');
    expect(unknown).toBe('some future resource'); // Refine's own default stays (menu/breadcrumb use this key too)
    expect(refineTranslate('notifications.editSuccess', { resource: unknown }, 'Successfully updated x')).toBe('Изменения сохранены');
    expect(refineTranslate('notifications.createSuccess', { resource: 'orders' }, 'x')).toBe('Запись создана');
    expect(refineTranslate('notifications.deleteSuccess', {}, 'x')).toBe('Запись удалена');
  });

  it('renders errors with the status code and progress messages in Russian', () => {
    expect(refineTranslate('notifications.error', { statusCode: 500 }, 'Error (status code: 500)')).toBe('Ошибка (код 500)');
    expect(refineTranslate('notifications.editError', { resource: 'поставщик', statusCode: 409 }, 'x')).toBe('Не удалось сохранить: поставщик (код 409)');
    expect(refineTranslate('notifications.createError', { resource: '', statusCode: undefined }, 'x')).toBe('Не удалось создать запись');
    expect(refineTranslate('notifications.deleteError', { resource: 'deleteMany_raw', statusCode: 403 }, 'x')).toBe('Не удалось удалить запись (код 403)');
    expect(refineTranslate('notifications.undoable', { seconds: 5 }, 'You have 5 seconds to undo')).toBe('Отменить можно ещё 5 с');
    expect(refineTranslate('notifications.importProgress', { processed: 3, total: 10 }, 'Importing: 3/10')).toBe('Импорт: 3 из 10');
  });

  it('translates the remaining built-in Refine/AntD texts and keeps unknown two-argument defaults', () => {
    expect(refineTranslate('warnWhenUnsavedChanges', 'Are you sure you want to leave? You have unsaved changes.')).toBe('Есть несохранённые изменения. Уйти со страницы?');
    expect(refineTranslate('buttons.notAccessTitle', "You don't have permission to access")).toBe('Нет прав на это действие');
    expect(refineTranslate('autoSave.success', 'saved')).toBe('Сохранено');
    expect(refineTranslate('buttons.clone', 'Clone')).toBe('Копировать');
    expect(refineTranslate('some.unknown', 'Как есть')).toBe('Как есть');
  });

  it('every resource registered in App.tsx has a notification name or is a non-CRUD screen', () => {
    // Screens whose writes go through our own backend commands/messages, not Refine CRUD notifications.
    const nonCrud = new Set([
      'calendar', 'cad', 'bazis', 'scan', 'clients_analytics_view', 'configuration', 'audit', 'onec', 'integrations',
      'orders-trash', 'order-status-board', 'mdf-work-board', 'film-inventory', 'inventory-warehouses', 'cut-jobs',
      'bazis-cut-sets', 'inbound-signals',
    ]);
    const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    const names = [...appSource.matchAll(/\bname:\s*["']([a-z_0-9-]+)["']/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(30);
    const missing = names.filter((n) => !nonCrud.has(n) && !RESOURCE_NOTIFICATION_NAMES[n]);
    expect(missing).toEqual([]);
  });

  it('reports ru locale', () => {
    expect(i18nProvider.getLocale()).toBe('ru');
  });
});
