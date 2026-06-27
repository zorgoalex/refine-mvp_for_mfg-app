import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../database/database.types';
import type { ThemeMode, UserPreferencesDto, UserPreferencesRepositoryPort } from './profile-preferences.types';

interface PreferenceRow extends QueryResultRow {
  theme_mode: string | null;
}

export class PgProfilePreferencesRepository implements UserPreferencesRepositoryPort {
  constructor(private readonly database: DatabaseClient) {}

  async getUserPreferences(userId: number): Promise<UserPreferencesDto> {
    const result = await this.database.query<PreferenceRow>(
      `
      SELECT theme_mode
      FROM user_preferences
      WHERE user_id = $1
      `,
      [userId],
    );

    return mapPreferenceRow(result.rows[0]);
  }

  async updateUserPreferences(
    userId: number,
    preferences: Partial<UserPreferencesDto>,
  ): Promise<UserPreferencesDto> {
    if (!preferences.themeMode) {
      return this.getUserPreferences(userId);
    }

    const result = await this.database.query<PreferenceRow>(
      `
      INSERT INTO user_preferences (user_id, theme_mode)
      VALUES ($1, $2)
      ON CONFLICT (user_id)
      DO UPDATE SET
        theme_mode = EXCLUDED.theme_mode,
        updated_at = now()
      RETURNING theme_mode
      `,
      [userId, preferences.themeMode],
    );

    return mapPreferenceRow(result.rows[0]);
  }
}

function mapPreferenceRow(row: PreferenceRow | undefined): UserPreferencesDto {
  return {
    themeMode: normalizeThemeMode(row?.theme_mode),
  };
}

function normalizeThemeMode(value: unknown): ThemeMode {
  return value === 'dark' ? 'dark' : 'light';
}
