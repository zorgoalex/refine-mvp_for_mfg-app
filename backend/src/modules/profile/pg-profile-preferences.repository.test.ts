import { describe, expect, it } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import { PgProfilePreferencesRepository } from './pg-profile-preferences.repository';

describe('PgProfilePreferencesRepository', () => {
  it('returns light when user has no stored preferences', async () => {
    const database = new FakeDatabase([{ rows: [] }]);
    const repository = new PgProfilePreferencesRepository(database);

    await expect(repository.getUserPreferences(7)).resolves.toEqual({ themeMode: 'light', uiSize: 'default', orderDetailColumns: {}, recentReferences: {} });
    expect(database.queries[0].text).toContain('FROM user_preferences');
    expect(database.queries[0].params).toEqual([7]);
  });

  it('returns persisted dark theme', async () => {
    const database = new FakeDatabase([{ rows: [{ theme_mode: 'dark', ui_size: 'small', order_detail_columns: { orderShow: { order: ['height'], hidden: ['note'] } } }] }]);
    const repository = new PgProfilePreferencesRepository(database);

    await expect(repository.getUserPreferences(7)).resolves.toEqual({
      themeMode: 'dark',
      uiSize: 'small',
      orderDetailColumns: { orderShow: { order: ['height'], hidden: ['note'] } },
      recentReferences: {},
    });
  });

  it('upserts theme mode for one user and returns mapped preferences', async () => {
    const database = new FakeDatabase([{ rows: [{ theme_mode: 'dark', order_detail_columns: {} }] }]);
    const repository = new PgProfilePreferencesRepository(database);

    await expect(repository.updateUserPreferences(7, { themeMode: 'dark' })).resolves.toEqual({
      themeMode: 'dark',
      uiSize: 'default',
      orderDetailColumns: {},
      recentReferences: {},
    });
    expect(database.queries[0].text).toContain('INSERT INTO user_preferences');
    expect(database.queries[0].text).toContain('ON CONFLICT (user_id)');
    expect(database.queries[0].params).toEqual([7, 'dark', null, null]);
  });

  it('upserts order detail column preferences without changing theme', async () => {
    const database = new FakeDatabase([{ rows: [{ theme_mode: 'light', order_detail_columns: { orderEdit: { order: ['width'], hidden: [] } } }] }]);
    const repository = new PgProfilePreferencesRepository(database);

    await expect(repository.updateUserPreferences(7, {
      orderDetailColumns: { orderEdit: { order: ['width'], hidden: [] } },
    })).resolves.toEqual({
      themeMode: 'light',
      uiSize: 'default',
      orderDetailColumns: { orderEdit: { order: ['width'], hidden: [] } },
      recentReferences: {},
    });
    expect(database.queries[0].params).toEqual([
      7,
      null,
      null,
      JSON.stringify({ orderEdit: { order: ['width'], hidden: [] } }),
    ]);
  });

  it('upserts ui size and normalizes garbage to default (uiSize)', async () => {
    const database = new FakeDatabase([{ rows: [{ theme_mode: 'light', ui_size: 'small', order_detail_columns: {} }] }]);
    const repository = new PgProfilePreferencesRepository(database);

    await expect(repository.updateUserPreferences(7, { uiSize: 'small' })).resolves.toEqual({
      themeMode: 'light',
      uiSize: 'small',
      orderDetailColumns: {},
      recentReferences: {},
    });
    expect(database.queries[0].params).toEqual([7, null, 'small', null]);

    const garbage = new FakeDatabase([{ rows: [{ theme_mode: 'light', ui_size: 'huge', order_detail_columns: {} }] }]);
    await expect(new PgProfilePreferencesRepository(garbage).getUserPreferences(7)).resolves.toMatchObject({
      uiSize: 'default',
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
