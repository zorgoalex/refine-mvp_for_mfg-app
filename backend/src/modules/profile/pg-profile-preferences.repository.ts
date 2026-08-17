import type { QueryResultRow } from 'pg';
import { ApiError } from '../../common/errors/api-error';
import type { DatabaseClient } from '../../database/database.types';
import { RECENT_REFERENCE_RESOURCES, UI_VARIANTS } from './profile-preferences.types';
import type {
  OrderDetailColumnPreferencesDto,
  PageSizePreferencesDto,
  RecentReferenceEntitiesDto,
  RecentReferenceResource,
  SidebarMenuOrderPreferenceDto,
  ThemeMode,
  UiSize,
  UiVariant,
  UserPreferencesDto,
  UserPreferencesRepositoryPort,
} from './profile-preferences.types';

const DEFAULT_UI_VARIANT: UiVariant = 'evolution';
const uiVariantSet = new Set<unknown>(UI_VARIANTS);

interface PreferenceRow extends QueryResultRow {
  theme_mode: string | null;
  ui_size: string | null;
  ui_variant: string | null;
  tablet_mode: boolean | null;
  sidebar_collapsed: boolean | null;
  order_detail_columns: unknown;
  recent_reference_entities: unknown;
  page_size_preferences: unknown;
  sidebar_menu_order: unknown;
}

export class PgProfilePreferencesRepository implements UserPreferencesRepositoryPort {
  constructor(private readonly database: DatabaseClient) {}

  async getUserPreferences(userId: number): Promise<UserPreferencesDto> {
    const result = await this.database.query<PreferenceRow>(
      `
      SELECT theme_mode, ui_size, ui_variant, tablet_mode, sidebar_collapsed, order_detail_columns, recent_reference_entities, page_size_preferences, sidebar_menu_order
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
    if (
      preferences.themeMode === undefined &&
      preferences.uiSize === undefined &&
      preferences.uiVariant === undefined &&
      preferences.tabletMode === undefined &&
      preferences.sidebarCollapsed === undefined &&
      preferences.orderDetailColumns === undefined &&
      preferences.pageSizePreferences === undefined &&
      preferences.sidebarMenuOrder === undefined
    ) {
      return this.getUserPreferences(userId);
    }

    const result = await this.database.query<PreferenceRow>(
      `
      INSERT INTO user_preferences (user_id, theme_mode, ui_size, ui_variant, order_detail_columns, page_size_preferences, sidebar_menu_order, tablet_mode, sidebar_collapsed)
      VALUES (
        $1,
        COALESCE($2, 'light'),
        $3,
        COALESCE($4, 'evolution'),
        COALESCE($5::jsonb, '{}'::jsonb),
        COALESCE($6::jsonb, '{}'::jsonb),
        COALESCE($7::jsonb, '{}'::jsonb),
        COALESCE($8, FALSE),
        $9::boolean
      )
      ON CONFLICT (user_id)
      DO UPDATE SET
        theme_mode = COALESCE($2, user_preferences.theme_mode),
        ui_size = COALESCE($3, user_preferences.ui_size),
        ui_variant = COALESCE($4, user_preferences.ui_variant),
        tablet_mode = COALESCE($8, user_preferences.tablet_mode),
        sidebar_collapsed = COALESCE($9::boolean, user_preferences.sidebar_collapsed),
        order_detail_columns = COALESCE($5::jsonb, user_preferences.order_detail_columns),
        sidebar_menu_order = COALESCE($7::jsonb, user_preferences.sidebar_menu_order),
        page_size_preferences = CASE
          WHEN $6::jsonb IS NULL THEN user_preferences.page_size_preferences
          ELSE user_preferences.page_size_preferences || $6::jsonb
        END,
        updated_at = now()
      WHERE $6::jsonb IS NULL
        OR jsonb_object_length(user_preferences.page_size_preferences || $6::jsonb) <= 128
      RETURNING theme_mode, ui_size, ui_variant, tablet_mode, sidebar_collapsed, order_detail_columns, recent_reference_entities, page_size_preferences, sidebar_menu_order
      `,
      [
        userId,
        preferences.themeMode ?? null,
        preferences.uiSize ?? null,
        preferences.uiVariant ?? null,
        preferences.orderDetailColumns === undefined ? null : JSON.stringify(preferences.orderDetailColumns),
        preferences.pageSizePreferences === undefined ? null : JSON.stringify(preferences.pageSizePreferences),
        preferences.sidebarMenuOrder === undefined ? null : JSON.stringify(preferences.sidebarMenuOrder),
        preferences.tabletMode ?? null,
        preferences.sidebarCollapsed ?? null,
      ],
    );

    if (!result.rows[0] && preferences.pageSizePreferences !== undefined) {
      throw new ApiError(
        422,
        'PAGE_SIZE_PREFERENCES_LIMIT',
        'Too many saved page-size preferences',
        { maxEntries: MAX_STORED_PAGE_SIZE_PREFERENCES },
      );
    }

    return mapPreferenceRow(result.rows[0]);
  }

  async promoteReferenceUsage(
    userId: number,
    resource: RecentReferenceResource,
    entityId: number,
  ): Promise<UserPreferencesDto> {
    const result = await this.database.query<PreferenceRow>(
      `
      INSERT INTO user_preferences (user_id, recent_reference_entities)
      VALUES ($1, jsonb_build_object($2::text, jsonb_build_array($3::bigint)))
      ON CONFLICT (user_id)
      DO UPDATE SET
        recent_reference_entities = jsonb_set(
          CASE
            WHEN jsonb_typeof(user_preferences.recent_reference_entities) = 'object'
              THEN user_preferences.recent_reference_entities
            ELSE '{}'::jsonb
          END,
          ARRAY[$2::text],
          (
            SELECT COALESCE(
              jsonb_agg(candidate.entity_id ORDER BY candidate.position),
              '[]'::jsonb
            )
            FROM (
              SELECT raw.entity_id, MIN(raw.position) AS position
              FROM (
                SELECT $3::bigint AS entity_id, 0::bigint AS position
                UNION ALL
                SELECT
                  CASE
                    WHEN item.value ~ '^[1-9][0-9]{0,18}$'
                      AND item.value::numeric <= 9223372036854775807
                    THEN item.value::bigint
                  END,
                  item.ordinality::bigint
                FROM jsonb_array_elements_text(
                  CASE
                    WHEN jsonb_typeof(user_preferences.recent_reference_entities -> $2::text) = 'array'
                      THEN user_preferences.recent_reference_entities -> $2::text
                    ELSE '[]'::jsonb
                  END
                ) WITH ORDINALITY AS item(value, ordinality)
              ) raw
              WHERE raw.entity_id IS NOT NULL
              GROUP BY raw.entity_id
              ORDER BY MIN(raw.position)
              LIMIT 20
            ) candidate
          ),
          true
        ),
        updated_at = now()
      RETURNING theme_mode, ui_size, ui_variant, tablet_mode, sidebar_collapsed, order_detail_columns, recent_reference_entities, page_size_preferences, sidebar_menu_order
      `,
      [userId, resource, entityId],
    );

    return mapPreferenceRow(result.rows[0]);
  }
}

function mapPreferenceRow(row: PreferenceRow | undefined): UserPreferencesDto {
  return {
    themeMode: normalizeThemeMode(row?.theme_mode),
    uiSize: normalizeUiSize(row?.ui_size),
    uiVariant: normalizeUiVariant(row?.ui_variant),
    tabletMode: row?.tablet_mode === true,
    sidebarCollapsed: typeof row?.sidebar_collapsed === 'boolean' ? row.sidebar_collapsed : null,
    orderDetailColumns: normalizeOrderDetailColumns(row?.order_detail_columns),
    recentReferences: normalizeRecentReferences(row?.recent_reference_entities),
    pageSizePreferences: normalizePageSizePreferences(row?.page_size_preferences),
    sidebarMenuOrder: normalizeSidebarMenuOrder(row?.sidebar_menu_order),
  };
}

const ALLOWED_PAGE_SIZES = new Set([10, 20, 25, 50, 100]);
const MAX_STORED_PAGE_SIZE_PREFERENCES = 128;

function normalizePageSizePreferences(value: unknown): PageSizePreferencesDto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const normalized: PageSizePreferencesDto = {};
  let storedEntries = 0;
  for (const [rawKey, rawSize] of Object.entries(value as Record<string, unknown>)) {
    if (storedEntries >= MAX_STORED_PAGE_SIZE_PREFERENCES) break;
    const key = rawKey.trim();
    if (!key || key.length > 120 || typeof rawSize !== 'number' || !ALLOWED_PAGE_SIZES.has(rawSize)) {
      continue;
    }
    normalized[key] = rawSize;
    storedEntries += 1;
  }
  return normalized;
}

function normalizeRecentReferences(value: unknown): RecentReferenceEntitiesDto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const allowed = new Set<string>(RECENT_REFERENCE_RESOURCES);
  const normalized: RecentReferenceEntitiesDto = {};
  for (const [resource, rawIds] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(resource) || !Array.isArray(rawIds)) continue;
    const ids = [...new Set(
      rawIds.filter((id): id is number => Number.isSafeInteger(id) && Number(id) > 0),
    )].slice(0, 20);
    normalized[resource as RecentReferenceResource] = ids;
  }
  return normalized;
}

function normalizeThemeMode(value: unknown): ThemeMode {
  return value === 'dark' ? 'dark' : 'light';
}

function normalizeUiSize(value: unknown): UiSize {
  return value === 'small' ? 'small' : 'default';
}

function normalizeUiVariant(value: unknown): UiVariant {
  return uiVariantSet.has(value) ? (value as UiVariant) : DEFAULT_UI_VARIANT;
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

function normalizeSidebarMenuOrder(value: unknown): SidebarMenuOrderPreferenceDto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { top: [], categories: [], resources: {} };
  }

  const raw = value as Record<string, unknown>;
  const resources: Record<string, string[]> = {};
  const rawResources = raw.resources;
  if (rawResources && typeof rawResources === 'object' && !Array.isArray(rawResources)) {
    let sectionCount = 0;
    for (const [rawSection, rawOrder] of Object.entries(rawResources as Record<string, unknown>)) {
      const section = rawSection.trim();
      if (!section || section.length > 80 || sectionCount >= 40) continue;
      resources[section] = normalizeLimitedStringList(rawOrder, 160, 80);
      sectionCount += 1;
    }
  }

  return {
    top: normalizeLimitedStringList(raw.top, 160, 80),
    categories: normalizeLimitedStringList(raw.categories, 40, 80),
    resources,
  };
}

function normalizeLimitedStringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (result.length >= maxItems || typeof item !== 'string') continue;
    const normalized = item.trim();
    if (!normalized || normalized.length > maxLength || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}
