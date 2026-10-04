import {
  CLIENT_SCREEN_CODES,
  CLIENT_SCREEN_DEFAULT_VISIBLE_CODES,
  normalizeClientScreenCodes,
  type ClientScreenCode,
} from '../../clientScreen/clientScreenRegistry';
import type { ClientScreenSettings, ClientScreenSettingsUpdate } from '../../../api/clientScreenSettingsApi';

export interface ClientScreenFormState {
  enabled: boolean;
  /** Normalized (registry order, unique, known codes only). */
  codes: ClientScreenCode[];
}

export function formFromSettings(settings: Pick<ClientScreenSettings, 'enabled' | 'visibleCodes'>): ClientScreenFormState {
  return { enabled: settings.enabled, codes: normalizeClientScreenCodes(settings.visibleCodes) };
}

export function setEnabled(state: ClientScreenFormState, enabled: boolean): ClientScreenFormState {
  return { ...state, enabled };
}

/** Toggles one code (a field or a tab); a tab toggle never touches its fields. */
export function toggleCode(state: ClientScreenFormState, code: ClientScreenCode, checked?: boolean): ClientScreenFormState {
  const has = state.codes.includes(code);
  const next = checked ?? !has;
  if (next === has) return state;
  const codes = next ? [...state.codes, code] : state.codes.filter((item) => item !== code);
  return { ...state, codes: normalizeClientScreenCodes(codes) };
}

export const toggleTab = toggleCode;

export function setDefaults(state: ClientScreenFormState): ClientScreenFormState {
  return { ...state, codes: normalizeClientScreenCodes(CLIENT_SCREEN_DEFAULT_VISIBLE_CODES) };
}

export function showAll(state: ClientScreenFormState): ClientScreenFormState {
  return { ...state, codes: [...CLIENT_SCREEN_CODES] };
}

export function isDirty(
  state: ClientScreenFormState,
  settings: Pick<ClientScreenSettings, 'enabled' | 'visibleCodes'>,
): boolean {
  const saved = formFromSettings(settings);
  if (state.enabled !== saved.enabled) return true;
  const current = normalizeClientScreenCodes(state.codes);
  return current.length !== saved.codes.length || current.some((code, index) => code !== saved.codes[index]);
}

export function toPayload(state: ClientScreenFormState, expectedVersion: number): ClientScreenSettingsUpdate {
  return { enabled: state.enabled, visibleCodes: normalizeClientScreenCodes(state.codes), expectedVersion };
}

/** Pulls `details.settings` out of a 409 conflict, or null when it is malformed. */
export function extractConflictSettings(details: unknown): ClientScreenSettings | null {
  const raw = (details as { settings?: unknown } | null | undefined)?.settings as Partial<ClientScreenSettings> | undefined;
  if (!raw || typeof raw.enabled !== 'boolean' || !Array.isArray(raw.visibleCodes) || typeof raw.version !== 'number') {
    return null;
  }
  return {
    enabled: raw.enabled,
    visibleCodes: raw.visibleCodes.map(String),
    version: raw.version,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  };
}
