import type { ThemeMode } from '../../theme/themeTypes';

export interface UserPreferencesDto {
  themeMode: ThemeMode;
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
  orderDetailColumns?: Record<string, OrderDetailColumnPreference>;
}
