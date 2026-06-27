import type { ThemeMode } from '../../theme/themeTypes';

export interface UserPreferencesDto {
  themeMode: ThemeMode;
}

export interface UserPreferencesResponse {
  preferences: UserPreferencesDto;
}

export interface UpdateUserPreferencesRequest {
  themeMode?: ThemeMode;
}
