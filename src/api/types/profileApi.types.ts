import type { ThemeMode, UiSize } from '../../theme/themeTypes';
import type { UiVariant } from '../../ui-variant/uiVariant';

export const RECENT_REFERENCE_RESOURCES = [
  'clients',
  'materials',
  'sheet_material_types',
  'milling_types',
  'films',
  'edge_types',
  'vendors',
  'suppliers',
  'film_types',
  'material_types',
  'units',
  'order_statuses',
  'payment_statuses',
  'payment_types',
  'requisition_statuses',
  'movements_statuses',
  'material_transaction_types',
  'transaction_direction',
  'production_statuses',
  'resource_requirements_statuses',
  'workshops',
  'work_centers',
] as const;

export type RecentReferenceResource = (typeof RECENT_REFERENCE_RESOURCES)[number];
export type RecentReferences = Partial<Record<RecentReferenceResource, number[]>>;
export type PageSizePreferences = Record<string, number>;

export interface UserPreferencesDto {
  themeMode: ThemeMode;
  uiSize: UiSize;
  /** Optional only while frontend can meet an older backend during rollout. */
  uiVariant?: UiVariant;
  orderDetailColumns: Record<string, OrderDetailColumnPreference>;
  /** Optional during mixed frontend/backend rollout. */
  recentReferences?: RecentReferences;
  /** Optional during mixed frontend/backend rollout. */
  pageSizePreferences?: PageSizePreferences;
}

export interface ReferenceUsageRequest {
  resource: RecentReferenceResource;
  entityId: number;
}

export interface OrderDetailColumnPreference {
  order: string[];
  hidden: string[];
}

export interface UserPreferencesResponse {
  preferences: UserPreferencesDto;
}

export interface UpdateUserPreferencesRequest {
  themeMode?: ThemeMode;
  uiSize?: UiSize;
  uiVariant?: UiVariant;
  orderDetailColumns?: Record<string, OrderDetailColumnPreference>;
  pageSizePreferences?: PageSizePreferences;
}
