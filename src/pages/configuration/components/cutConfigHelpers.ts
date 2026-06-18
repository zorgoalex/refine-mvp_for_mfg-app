import type { CutSettingRow } from '../../../api/cutConfigApi';

/** Find a cut_settings row by key (returns null when absent). */
export function findSetting(settings: CutSettingRow[], key: string): CutSettingRow | null {
  return settings.find((s) => s.key === key) ?? null;
}

/** Ready-to-cut status codes stored in the eligibility.statuses setting. */
export function extractEligibilityCodes(settings: CutSettingRow[]): string[] {
  const row = findSetting(settings, 'eligibility.statuses');
  const codes = (row?.value as { codes?: unknown } | undefined)?.codes;
  return Array.isArray(codes) ? codes.map((c) => String(c)) : [];
}

/** Parse a comma/space separated code list into trimmed non-empty codes. */
export function parseCodesCsv(input: string): string[] {
  return input
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export type JsonParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/** Parse a freecut-params JSON textarea into an object (UI-validated before save). */
export function parseJsonObject(text: string): JsonParseResult {
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'Ожидается JSON-объект' };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'Некорректный JSON' };
  }
}

/** Day-0 onboarding hint shown when no sheet material types are defined yet. */
export function sheetSpecOnboardingHint(count: number): string | null {
  if (count > 0) return null;
  return 'Нет раскройных спецификаций материалов. Создайте их и свяжите с материалами — иначе детали не будут отображаться как готовые к раскрою (no_sheet_spec).';
}
