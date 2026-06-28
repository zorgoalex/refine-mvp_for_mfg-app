import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../database/database.types';
import type {
  OrderDetailColumnPreferencesDto,
  ThemeMode,
  UserPreferencesDto,
  UserPreferencesRepositoryPort,
} from './profile-preferences.types';

interface PreferenceRow extends QueryResultRow {
  theme_mode: string | null;
  order_detail_columns: unknown;
}

export class PgProfilePreferencesRepository implements UserPreferencesRepositoryPort {
  constructor(private readonly database: DatabaseClient) {}

  async getUserPreferences(userId: number): Promise<UserPreferencesDto> {
    const result = await this.database.query<PreferenceRow>(
      `
      SELECT theme_mode, order_detail_columns
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
    if (preferences.themeMode === undefined && preferences.orderDetailColumns === undefined) {
      return this.getUserPreferences(userId);
    }

    const result = await this.database.query<PreferenceRow>(
      `
      INSERT INTO user_preferences (user_id, theme_mode, order_detail_columns)
      VALUES ($1, COALESCE($2, 'light'), COALESCE($3::jsonb, '{}'::jsonb))
      ON CONFLICT (user_id)
      DO UPDATE SET
        theme_mode = COALESCE($2, user_preferences.theme_mode),
        order_detail_columns = COALESCE($3::jsonb, user_preferences.order_detail_columns),
        updated_at = now()
      RETURNING theme_mode, order_detail_columns
      `,
      [
        userId,
        preferences.themeMode ?? null,
        preferences.orderDetailColumns === undefined ? null : JSON.stringify(preferences.orderDetailColumns),
      ],
    );

    return mapPreferenceRow(result.rows[0]);
  }
}

function mapPreferenceRow(row: PreferenceRow | undefined): UserPreferencesDto {
  return {
    themeMode: normalizeThemeMode(row?.theme_mode),
    orderDetailColumns: normalizeOrderDetailColumns(row?.order_detail_columns),
  };
}

function normalizeThemeMode(value: unknown): ThemeMode {
  return value === 'dark' ? 'dark' : 'light';
}

function normalizeOrderDetailColumns(value: unknown): OrderDetailColumnPreferencesDto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: OrderDetailColumnPreferencesDto = {};
  for (const [viewKey, rawSettings] of Object.entries(value as Record<string, unknown>)) {
    if (!viewKey || !rawSettings || typeof rawSettings !== 'object' || Array.isArray(rawSettings)) {
      continue;
    }

    const settings = rawSettings as Record<string, unknown>;
    result[viewKey] = {
      order: normalizeStringList(settings.order),
      hidden: normalizeStringList(settings.hidden),
    };
  }
  return result;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}
