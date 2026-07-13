import type { ThemeMode, UiSize } from '../../theme/themeTypes';

export interface UserPreferencesDto {
  themeMode: ThemeMode;
  uiSize: UiSize;
  orderDetailColumns: Record<string, OrderDetailColumnPreference>;
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
  orderDetailColumns?: Record<string, OrderDetailColumnPreference>;
}
