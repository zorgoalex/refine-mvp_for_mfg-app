import { describe, expect, it } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import { PgProfilePreferencesRepository } from './pg-profile-preferences.repository';

describe('PgProfilePreferencesRepository', () => {
  it('returns default preferences when user has no stored preferences', async () => {
    const database = new FakeDatabase([{ rows: [] }]);
    const repository = new PgProfilePreferencesRepository(database);

    await expect(repository.getUserPreferences(7)).resolves.toEqual({
      themeMode: 'light',
      uiSize: 'default',
      uiVariant: 'evolution',
      orderDetailColumns: {},
      recentReferences: {},
      pageSizePreferences: {},
      sidebarMenuOrder: { top: [], categories: [], resources: {} },
    });
    expect(database.queries[0].text).toContain('FROM user_preferences');
    expect(database.queries[0].params).toEqual([7]);
  });

  it('returns persisted dark theme', async () => {
    const database = new FakeDatabase([{ rows: [{ theme_mode: 'dark', ui_size: 'small', ui_variant: 'evolution', order_detail_columns: { orderShow: { order: ['height'], hidden: ['note'] } } }] }]);
    const repository = new PgProfilePreferencesRepository(database);

    await expect(repository.getUserPreferences(7)).resolves.toEqual({
      themeMode: 'dark',
      uiSize: 'small',
      uiVariant: 'evolution',
      orderDetailColumns: { orderShow: { order: ['height'], hidden: ['note'] } },
      recentReferences: {},
      pageSizePreferences: {},
      sidebarMenuOrder: { top: [], categories: [], resources: {} },
    });
  });

  it('upserts theme mode for one user and returns mapped preferences', async () => {
    const database = new FakeDatabase([{ rows: [{ theme_mode: 'dark', order_detail_columns: {} }] }]);
    const repository = new PgProfilePreferencesRepository(database);

    await expect(repository.updateUserPreferences(7, { themeMode: 'dark' })).resolves.toEqual({
      themeMode: 'dark',
      uiSize: 'default',
      uiVariant: 'evolution',
      orderDetailColumns: {},
      recentReferences: {},
      pageSizePreferences: {},
      sidebarMenuOrder: { top: [], categories: [], resources: {} },
    });
    expect(database.queries[0].text).toContain('INSERT INTO user_preferences');
    expect(database.queries[0].text).toContain('ON CONFLICT (user_id)');
    expect(database.queries[0].params).toEqual([7, 'dark', null, null, null, null, null]);
  });

  it('upserts order detail column preferences without changing theme', async () => {
    const database = new FakeDatabase([{ rows: [{ theme_mode: 'light', order_detail_columns: { orderEdit: { order: ['width'], hidden: [] } } }] }]);
    const repository = new PgProfilePreferencesRepository(database);

    await expect(repository.updateUserPreferences(7, {
      orderDetailColumns: { orderEdit: { order: ['width'], hidden: [] } },
    })).resolves.toEqual({
      themeMode: 'light',
      uiSize: 'default',
      uiVariant: 'evolution',
      orderDetailColumns: { orderEdit: { order: ['width'], hidden: [] } },
      recentReferences: {},
      pageSizePreferences: {},
      sidebarMenuOrder: { top: [], categories: [], resources: {} },
    });
    expect(database.queries[0].params).toEqual([
      7,
      null,
      null,
      null,
      JSON.stringify({ orderEdit: { order: ['width'], hidden: [] } }),
      null,
      null,
    ]);
  });

  it('upserts sidebar menu order without replacing page-size preferences', async () => {
    const sidebarMenuOrder = {
      top: ['calendar', 'orders_view'],
      categories: ['Материалы', 'Производство'],
      resources: { Материалы: ['materials', 'films'] },
    };
    const database = new FakeDatabase([{
      rows: [{
        theme_mode: 'light',
        order_detail_columns: {},
        page_size_preferences: { 'refine:orders_view': 50 },
        sidebar_menu_order: sidebarMenuOrder,
      }],
    }]);
    const repository = new PgProfilePreferencesRepository(database);

    await expect(repository.updateUserPreferences(7, { sidebarMenuOrder }))
      .resolves.toMatchObject({ sidebarMenuOrder });
    expect(database.queries[0].params).toEqual([
      7,
      null,
      null,
      null,
      null,
      null,
      JSON.stringify(sidebarMenuOrder),
    ]);
    expect(database.queries[0].text).toContain('sidebar_menu_order = COALESCE($7::jsonb, user_preferences.sidebar_menu_order)');
  });

  it('upserts ui size and normalizes garbage to default (uiSize)', async () => {
    const database = new FakeDatabase([{ rows: [{ theme_mode: 'light', ui_size: 'small', order_detail_columns: {} }] }]);
    const repository = new PgProfilePreferencesRepository(database);

    await expect(repository.updateUserPreferences(7, { uiSize: 'small' })).resolves.toEqual({
      themeMode: 'light',
      uiSize: 'small',
      uiVariant: 'evolution',
      orderDetailColumns: {},
      recentReferences: {},
      pageSizePreferences: {},
      sidebarMenuOrder: { top: [], categories: [], resources: {} },
    });
    expect(database.queries[0].params).toEqual([7, null, 'small', null, null, null, null]);

    const garbage = new FakeDatabase([{ rows: [{ theme_mode: 'light', ui_size: 'huge', order_detail_columns: {} }] }]);
    await expect(new PgProfilePreferencesRepository(garbage).getUserPreferences(7)).resolves.toMatchObject({
      uiSize: 'default',
      uiVariant: 'evolution',
    });
  });

  it('upserts UI variant and normalizes unknown stored values to evolution default', async () => {
    const database = new FakeDatabase([{
      rows: [{ theme_mode: 'light', ui_variant: 'line', order_detail_columns: {} }],
    }]);
    const repository = new PgProfilePreferencesRepository(database);

    await expect(repository.updateUserPreferences(7, { uiVariant: 'line' }))
      .resolves.toMatchObject({ uiVariant: 'line' });
    expect(database.queries[0].params).toEqual([7, null, null, 'line', null, null, null]);
    expect(database.queries[0].text).toContain('ui_variant = COALESCE($4, user_preferences.ui_variant)');

    const air = new FakeDatabase([{
      rows: [{ theme_mode: 'light', ui_variant: 'air', order_detail_columns: {} }],
    }]);
    await expect(new PgProfilePreferencesRepository(air).getUserPreferences(7))
      .resolves.toMatchObject({ uiVariant: 'air' });

    const garbage = new FakeDatabase([{
      rows: [{ theme_mode: 'light', ui_variant: 'future', order_detail_columns: {} }],
    }]);
    await expect(new PgProfilePreferencesRepository(garbage).getUserPreferences(7))
      .resolves.toMatchObject({ uiVariant: 'evolution' });
  });

  it('atomically merges one list page size without replacing other list preferences', async () => {
    const database = new FakeDatabase([{
      rows: [{
        theme_mode: 'light',
        ui_size: 'default',
        order_detail_columns: {},
        page_size_preferences: { 'refine:orders_view': 50, audit: 100 },
      }],
    }]);
    const repository = new PgProfilePreferencesRepository(database);

    await expect(repository.updateUserPreferences(7, {
      pageSizePreferences: { 'refine:orders_view': 50 },
    })).resolves.toMatchObject({
      pageSizePreferences: { 'refine:orders_view': 50, audit: 100 },
    });
    expect(database.queries[0].params).toEqual([
      7,
      null,
      null,
      null,
      null,
      JSON.stringify({ 'refine:orders_view': 50 }),
      null,
    ]);
    expect(database.queries[0].text).toContain('user_preferences.page_size_preferences || $6::jsonb');
    expect(database.queries[0].text).toContain('jsonb_object_length(user_preferences.page_size_preferences || $6::jsonb) <= 128');
  });

  it('rejects an atomic merge that would exceed the per-user key limit', async () => {
    const database = new FakeDatabase([{ rows: [] }]);
    const repository = new PgProfilePreferencesRepository(database);

    await expect(repository.updateUserPreferences(7, {
      pageSizePreferences: { 'refine:new-list': 20 },
    })).rejects.toMatchObject({
      statusCode: 422,
      code: 'PAGE_SIZE_PREFERENCES_LIMIT',
      details: { maxEntries: 128 },
    });
  });

  it('atomically promotes, deduplicates and caps recent reference ids', async () => {
    const database = new FakeDatabase([{
      rows: [{
        theme_mode: 'light',
        ui_size: 'default',
        order_detail_columns: {},
        recent_reference_entities: { sheet_material_types: [9, 7] },
      }],
    }]);
    const repository = new PgProfilePreferencesRepository(database);

    await expect(repository.promoteReferenceUsage(
      7,
      'sheet_material_types',
      9,
    )).resolves.toMatchObject({
      recentReferences: { sheet_material_types: [9, 7] },
      pageSizePreferences: {},
    });
    expect(database.queries[0].params).toEqual([7, 'sheet_material_types', 9]);
    expect(database.queries[0].text).toContain('ON CONFLICT (user_id)');
    expect(database.queries[0].text).toContain('GROUP BY raw.entity_id');
    expect(database.queries[0].text).toContain('LIMIT 20');
    expect(database.queries[0].text).toContain("item.value ~ '^[1-9][0-9]{0,18}$'");
  });

  it('normalizes malformed, duplicate and oversized recent-reference data', async () => {
    const database = new FakeDatabase([{
      rows: [{
        theme_mode: 'light',
        order_detail_columns: {},
        recent_reference_entities: {
          sheet_material_types: [3, 3, -1, '4', ...Array.from({ length: 30 }, (_, index) => index + 10)],
          unknown: [1],
        },
      }],
    }]);

    const preferences = await new PgProfilePreferencesRepository(database).getUserPreferences(7);
    expect(preferences.recentReferences.sheet_material_types).toHaveLength(20);
    expect(preferences.recentReferences.sheet_material_types?.slice(0, 2)).toEqual([3, 10]);
    expect(preferences.recentReferences).not.toHaveProperty('unknown');
  });

  it('drops unsupported or malformed page-size preferences', async () => {
    const database = new FakeDatabase([{
      rows: [{
        theme_mode: 'light',
        order_detail_columns: {},
        page_size_preferences: {
          orders: 50,
          audit: 200,
          broken: '100',
          ['x'.repeat(121)]: 20,
        },
      }],
    }]);

    await expect(new PgProfilePreferencesRepository(database).getUserPreferences(7))
      .resolves.toMatchObject({ pageSizePreferences: { orders: 50 } });
  });

  it('normalizes malformed, duplicate and oversized sidebar menu order data', async () => {
    const database = new FakeDatabase([{
      rows: [{
        sidebar_menu_order: {
          top: ['orders_view', 'orders_view', ' calendar ', 7, 'x'.repeat(81)],
          categories: ['Материалы', 'Материалы', ' Производство '],
          resources: {
            ' Материалы ': ['materials', 'materials', 'films'],
            ['x'.repeat(81)]: ['ignored'],
          },
        },
      }],
    }]);

    await expect(new PgProfilePreferencesRepository(database).getUserPreferences(7))
      .resolves.toMatchObject({
        sidebarMenuOrder: {
          top: ['orders_view', 'calendar'],
          categories: ['Материалы', 'Производство'],
          resources: { Материалы: ['materials', 'films'] },
        },
      });
  });

  it('caps oversized legacy page-size maps before returning them', async () => {
    const pageSizePreferences = Object.fromEntries(
      Array.from({ length: 140 }, (_, index) => [`list:${index}`, 20]),
    );
    const database = new FakeDatabase([{ rows: [{ page_size_preferences: pageSizePreferences }] }]);

    const preferences = await new PgProfilePreferencesRepository(database).getUserPreferences(7);
    expect(Object.keys(preferences.pageSizePreferences)).toHaveLength(128);
  });
});

class FakeDatabase {
  readonly queries: Array<{ text: string; params: readonly unknown[] }> = [];
  private readonly results: Array<QueryResult<QueryResultRow>>;

  constructor(results: Array<{ rows: QueryResultRow[] }>) {
    this.results = results.map((result) => ({
      rows: result.rows,
      rowCount: result.rows.length,
      command: 'SELECT',
      oid: 0,
      fields: [],
    }));
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    this.queries.push({ text, params });
    return (this.results.shift() ?? {
      rows: [],
      rowCount: 0,
      command: 'SELECT',
      oid: 0,
      fields: [],
    }) as QueryResult<T>;
  }
}
