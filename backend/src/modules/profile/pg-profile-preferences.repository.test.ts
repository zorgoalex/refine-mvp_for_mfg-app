import { describe, expect, it } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import { PgProfilePreferencesRepository } from './pg-profile-preferences.repository';

describe('PgProfilePreferencesRepository', () => {
  it('returns light when user has no stored preferences', async () => {
    const database = new FakeDatabase([{ rows: [] }]);
    const repository = new PgProfilePreferencesRepository(database);

    await expect(repository.getUserPreferences(7)).resolves.toEqual({ themeMode: 'light' });
    expect(database.queries[0].text).toContain('FROM user_preferences');
    expect(database.queries[0].params).toEqual([7]);
  });

  it('returns persisted dark theme', async () => {
    const database = new FakeDatabase([{ rows: [{ theme_mode: 'dark' }] }]);
    const repository = new PgProfilePreferencesRepository(database);

    await expect(repository.getUserPreferences(7)).resolves.toEqual({ themeMode: 'dark' });
  });

  it('upserts theme mode for one user and returns mapped preferences', async () => {
    const database = new FakeDatabase([{ rows: [{ theme_mode: 'dark' }] }]);
    const repository = new PgProfilePreferencesRepository(database);

    await expect(repository.updateUserPreferences(7, { themeMode: 'dark' })).resolves.toEqual({
      themeMode: 'dark',
    });
    expect(database.queries[0].text).toContain('INSERT INTO user_preferences');
    expect(database.queries[0].text).toContain('ON CONFLICT (user_id)');
    expect(database.queries[0].params).toEqual([7, 'dark']);
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
