import { describe, expect, it } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import { PgProfilePreferencesRepository } from './pg-profile-preferences.repository';

describe('PgProfilePreferencesRepository', () => {
  it('returns light when user has no stored preferences', async () => {
    const database = new FakeDatabase([{ rows: [] }]);
    const repository = new PgProfilePreferencesRepository(database);

    await expect(repository.getUserPreferences(7)).resolves.toEqual({ themeMode: 'light', orderDetailColumns: {} });
    expect(database.queries[0].text).toContain('FROM user_preferences');
    expect(database.queries[0].params).toEqual([7]);
  });

  it('returns persisted dark theme', async () => {
    const database = new FakeDatabase([{ rows: [{ theme_mode: 'dark', order_detail_columns: { orderShow: { order: ['height'], hidden: ['note'] } } }] }]);
    const repository = new PgProfilePreferencesRepository(database);

    await expect(repository.getUserPreferences(7)).resolves.toEqual({
      themeMode: 'dark',
      orderDetailColumns: { orderShow: { order: ['height'], hidden: ['note'] } },
    });
  });

  it('upserts theme mode for one user and returns mapped preferences', async () => {
    const database = new FakeDatabase([{ rows: [{ theme_mode: 'dark', order_detail_columns: {} }] }]);
    const repository = new PgProfilePreferencesRepository(database);

    await expect(repository.updateUserPreferences(7, { themeMode: 'dark' })).resolves.toEqual({
      themeMode: 'dark',
      orderDetailColumns: {},
    });
    expect(database.queries[0].text).toContain('INSERT INTO user_preferences');
    expect(database.queries[0].text).toContain('ON CONFLICT (user_id)');
    expect(database.queries[0].params).toEqual([7, 'dark', null]);
  });

  it('upserts order detail column preferences without changing theme', async () => {
    const database = new FakeDatabase([{ rows: [{ theme_mode: 'light', order_detail_columns: { orderEdit: { order: ['width'], hidden: [] } } }] }]);
    const repository = new PgProfilePreferencesRepository(database);

    await expect(repository.updateUserPreferences(7, {
      orderDetailColumns: { orderEdit: { order: ['width'], hidden: [] } },
    })).resolves.toEqual({
      themeMode: 'light',
      orderDetailColumns: { orderEdit: { order: ['width'], hidden: [] } },
    });
    expect(database.queries[0].params).toEqual([
      7,
      null,
      JSON.stringify({ orderEdit: { order: ['width'], hidden: [] } }),
    ]);
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
