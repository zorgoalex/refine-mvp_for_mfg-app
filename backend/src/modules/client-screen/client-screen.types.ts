import type { CurrentUser } from '../../permissions/current-user';
import type { ClientScreenCode } from './client-screen.registry';

export interface ClientScreenSettingsDto {
  /** Organisation-wide switch: false stops every running presentation. */
  enabled: boolean;
  visibleCodes: ClientScreenCode[];
  /** Policy version carried by every message between the manager and the customer windows. */
  version: number;
  updatedAt: string;
}

export interface UpdateClientScreenSettingsCommand {
  currentUser: CurrentUser;
  requestId: string;
  enabled: boolean;
  visibleCodes: readonly ClientScreenCode[];
  expectedVersion: number;
}

export interface UpdateClientScreenSettingsResult {
  changed: boolean;
  settings: ClientScreenSettingsDto;
}
