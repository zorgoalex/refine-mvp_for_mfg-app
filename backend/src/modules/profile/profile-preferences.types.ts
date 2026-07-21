import type { CurrentUser } from '../../permissions/current-user';

export type ThemeMode = 'light' | 'dark';

/** Глобальный размер antd-компонентов: default = стандарт, small = компакт. */
export type UiSize = 'default' | 'small';

export interface OrderDetailColumnPreferenceDto {
  order: string[];
  hidden: string[];
}

export type OrderDetailColumnPreferencesDto = Record<string, OrderDetailColumnPreferenceDto>;

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
export type RecentReferenceEntitiesDto = Partial<Record<RecentReferenceResource, number[]>>;
export type PageSizePreferencesDto = Record<string, number>;

export interface UserPreferencesDto {
  themeMode: ThemeMode;
  uiSize: UiSize;
  orderDetailColumns: OrderDetailColumnPreferencesDto;
  recentReferences: RecentReferenceEntitiesDto;
  pageSizePreferences: PageSizePreferencesDto;
}

export interface UserPreferencesResponseDto {
  preferences: UserPreferencesDto;
}

export interface GetUserPreferencesCommand {
  currentUser: CurrentUser;
}

export interface UpdateUserPreferencesCommand {
  currentUser: CurrentUser;
  preferences: Partial<UserPreferencesDto>;
}

export interface PromoteReferenceUsageCommand {
  currentUser: CurrentUser;
  resource: RecentReferenceResource;
  entityId: number;
}

export interface UserPreferencesRepositoryPort {
  getUserPreferences(userId: number): Promise<UserPreferencesDto>;
  updateUserPreferences(userId: number, preferences: Partial<UserPreferencesDto>): Promise<UserPreferencesDto>;
  promoteReferenceUsage(
    userId: number,
    resource: RecentReferenceResource,
    entityId: number,
  ): Promise<UserPreferencesDto>;
}
