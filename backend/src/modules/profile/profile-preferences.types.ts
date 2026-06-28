import type { CurrentUser } from '../../permissions/current-user';

export type ThemeMode = 'light' | 'dark';

export interface OrderDetailColumnPreferenceDto {
  order: string[];
  hidden: string[];
}

export type OrderDetailColumnPreferencesDto = Record<string, OrderDetailColumnPreferenceDto>;

export interface UserPreferencesDto {
  themeMode: ThemeMode;
  orderDetailColumns: OrderDetailColumnPreferencesDto;
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

export interface UserPreferencesRepositoryPort {
  getUserPreferences(userId: number): Promise<UserPreferencesDto>;
  updateUserPreferences(userId: number, preferences: Partial<UserPreferencesDto>): Promise<UserPreferencesDto>;
}
