import type { CurrentUser } from '../../permissions/current-user';

export type ThemeMode = 'light' | 'dark';

export interface UserPreferencesDto {
  themeMode: ThemeMode;
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
