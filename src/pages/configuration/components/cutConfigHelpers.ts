import type { CutSettingRow } from '../../../api/cutConfigApi';
import {
  CUT_RENDER_STYLES_SETTING_KEY,
  DEFAULT_CUT_RENDER_STYLES_SETTING,
  parseCutRenderStylesSetting,
  type CutRenderStylesSetting,
} from '@shared/cut-render-style';

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

export function findCutRenderStylesSetting(settings: CutSettingRow[]): CutSettingRow | null {
  return findSetting(settings, CUT_RENDER_STYLES_SETTING_KEY);
}

export function readCutRenderStylesSetting(settings: CutSettingRow[]): CutRenderStylesSetting {
  const row = findCutRenderStylesSetting(settings);
  if (!row) return DEFAULT_CUT_RENDER_STYLES_SETTING;
  try {
    return parseCutRenderStylesSetting(row.value);
  } catch {
    return DEFAULT_CUT_RENDER_STYLES_SETTING;
  }
}

export function formatCutRenderStylesSettingJson(value: CutRenderStylesSetting): string {
  return JSON.stringify(value, null, 2);
}

/** Parse a comma/space separated code list into trimmed non-empty codes. */
export function parseCodesCsv(input: string): string[] {
  return input
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

// --- freecut param profile: structured form (no raw JSON in the UI) ---

export type FreecutObjective = 'min_waste' | 'min_sheets';
export type FreecutLayoutMode = 'guillotine' | 'nested' | 'vacuum_table';
export type FreecutRetryStrategy = 'disabled' | 'smart';
export type FreecutQuality = 'fast' | 'balanced' | 'quality';
export type FreecutEngineChoice = 'auto' | 'heuristic' | 'ga';
export type FreecutCutQuality = 'fast' | 'balanced' | 'max';
export const FREECUT_QUALITIES: FreecutQuality[] = ['fast', 'balanced', 'quality'];
export const FREECUT_ENGINE_CHOICES: FreecutEngineChoice[] = ['auto', 'heuristic', 'ga'];
export const FREECUT_CUT_QUALITIES: FreecutCutQuality[] = ['fast', 'balanced', 'max'];

export const FREECUT_OBJECTIVES: FreecutObjective[] = ['min_waste', 'min_sheets'];
export const FREECUT_LAYOUT_MODES: FreecutLayoutMode[] = ['guillotine', 'nested', 'vacuum_table'];
export const FREECUT_RETRY_STRATEGIES: FreecutRetryStrategy[] = ['disabled', 'smart'];

/** Flat form shape for the param-profile editor (one field per freecut param). */
export interface ParamProfileForm {
  kerf_mm: number;
  spacing_mm: number;
  trim_left: number;
  trim_right: number;
  trim_top: number;
  trim_bottom: number;
  objective: FreecutObjective;
  time_limit_ms: number;
  restarts: number;
  layout_mode: FreecutLayoutMode;
  retry_strategy: FreecutRetryStrategy;
  quality: FreecutQuality;
  engine: FreecutEngineChoice;
  cutQuality: FreecutCutQuality;
  groupShift: boolean;
  vacuum?: { direction?: 'optimal' | 'width' | 'height' };
}

/** Defaults = the seeded "default" profile (calibrated prod budget, commit dcfa2db). */
export const DEFAULT_PARAM_FORM: ParamProfileForm = {
  kerf_mm: 2,
  spacing_mm: 1,
  trim_left: 10,
  trim_right: 10,
  trim_top: 10,
  trim_bottom: 10,
  objective: 'min_waste',
  time_limit_ms: 1200,
  restarts: 5,
  layout_mode: 'guillotine',
  retry_strategy: 'disabled',
  quality: 'balanced',
  engine: 'auto',
  cutQuality: 'max',
  groupShift: false,
};

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deriveQuality(p: Record<string, unknown>): FreecutQuality {
  const sla = p.sla_profile;
  const ga = p.ga_profile;
  if (typeof sla === 'string' && sla === ga && (FREECUT_QUALITIES as string[]).includes(sla)) {
    return sla as FreecutQuality;
  }
  return 'balanced';
}

/** Stored freecut params JSONB -> flat form values, filling gaps with defaults. */
export function paramsToForm(params: Record<string, unknown> | null | undefined): ParamProfileForm {
  const p = params ?? {};
  const trim = (p.trim_mm ?? {}) as Record<string, unknown>;
  const d = DEFAULT_PARAM_FORM;
  return {
    kerf_mm: num(p.kerf_mm, d.kerf_mm),
    spacing_mm: num(p.spacing_mm, d.spacing_mm),
    trim_left: num(trim.left, d.trim_left),
    trim_right: num(trim.right, d.trim_right),
    trim_top: num(trim.top, d.trim_top),
    trim_bottom: num(trim.bottom, d.trim_bottom),
    objective: oneOf(p.objective, FREECUT_OBJECTIVES, d.objective),
    time_limit_ms: num(p.time_limit_ms, d.time_limit_ms),
    restarts: num(p.restarts, d.restarts),
    layout_mode: oneOf(p.layout_mode, FREECUT_LAYOUT_MODES, d.layout_mode),
    retry_strategy: oneOf(p.retry_strategy, FREECUT_RETRY_STRATEGIES, d.retry_strategy),
    quality: deriveQuality(p),
    engine: p.engine === 'heuristic' ? 'heuristic' : p.engine === 'ga' ? 'ga' : 'auto',
    cutQuality: oneOf(p.cut_quality, FREECUT_CUT_QUALITIES, 'max'),
    groupShift: isPlainObject(p.group_shift) && (p.group_shift as { enabled?: unknown }).enabled === true,
    ...(isPlainObject(p.vacuum)
      ? { vacuum: { direction: oneOf((p.vacuum as Record<string, unknown>).direction, ['optimal', 'width', 'height'] as const, 'optimal') } }
      : {}),
  };
}

/** Flat form values -> freecut params JSONB (the shape the backend validates). */
export function formToParams(form: ParamProfileForm): Record<string, unknown> {
  return {
    kerf_mm: form.kerf_mm,
    spacing_mm: form.spacing_mm,
    trim_mm: { left: form.trim_left, right: form.trim_right, top: form.trim_top, bottom: form.trim_bottom },
    objective: form.objective,
    time_limit_ms: form.time_limit_ms,
    restarts: form.restarts,
    layout_mode: form.layout_mode,
    retry_strategy: form.retry_strategy,
    sla_profile: form.quality,
    ga_profile: form.quality,
    ...(form.layout_mode !== 'vacuum_table' && form.engine === 'heuristic'
      ? { engine: 'heuristic', cut_quality: form.cutQuality }
      : {}),
    ...(form.layout_mode !== 'vacuum_table' && form.engine === 'ga' ? { engine: 'ga' } : {}),
    ...(form.groupShift ? { group_shift: { enabled: true, min_shift_mm: 5, max_passes: 4 } } : {}),
    ...(form.layout_mode === 'vacuum_table' ? { vacuum: { direction: form.vacuum?.direction ?? 'optimal' } } : {}),
  };
}

/**
 * Resolve which param profile the cut runtime actually treats as the default,
 * mirroring backend getDefaultParams precedence:
 *   cut_settings.defaults.param_profile (active, by name) > active is_default > none.
 * Editing any other row silently diverges saved settings from what cut jobs use.
 */
export function resolveRuntimeDefaultProfile<
  T extends { name: string; isDefault: boolean; isActive: boolean },
>(profiles: T[], settings: ReadonlyArray<{ key: string; value: unknown }>): T | null {
  const defaults = settings.find((s) => s.key === 'defaults');
  const named = (defaults?.value as { param_profile?: unknown } | null | undefined)?.param_profile;
  if (typeof named === 'string' && named.length > 0) {
    const byName = profiles.find((p) => p.name === named && p.isActive);
    if (byName) return byName;
  }
  return profiles.find((p) => p.isDefault && p.isActive) ?? null;
}

/** Suggested name for a "save as" copy of a param profile. */
export function buildProfileCopyName(sourceName: string): string {
  const base = sourceName.trim();
  return base ? `${base} (копия)` : 'Новый профиль (копия)';
}

/** Day-0 onboarding hint shown when no sheet material types are defined yet. */
export function sheetSpecOnboardingHint(count: number): string | null {
  if (count > 0) return null;
  return 'Нет раскройных спецификаций материалов. Создайте их и свяжите с материалами — иначе детали не будут отображаться как готовые к раскрою (no_sheet_spec).';
}

const OBJECTIVE_LABEL: Record<FreecutObjective, string> = {
  min_waste: 'меньше отхода',
  min_sheets: 'меньше листов',
};
const LAYOUT_LABEL: Record<FreecutLayoutMode, string> = {
  guillotine: 'гильотинная',
  nested: 'вложенная',
  vacuum_table: 'Вакуумный стол',
};

const VACUUM_DIRECTION_LABEL: Record<'optimal' | 'width' | 'height', string> = {
  optimal: 'авто',
  width: 'вдоль',
  height: 'поперёк',
};
const QUALITY_LABEL: Record<FreecutQuality, string> = {
  fast: 'быстро',
  balanced: 'баланс',
  quality: 'качество',
};

/** Human one-line summary of a stored freecut param set (advanced profiles table). */
export function summarizeParams(params: Record<string, unknown> | null | undefined): string {
  const f = paramsToForm(params);
  const parts = [
    `kerf ${f.kerf_mm}`,
    `зазор ${f.spacing_mm}`,
    OBJECTIVE_LABEL[f.objective],
    LAYOUT_LABEL[f.layout_mode],
    QUALITY_LABEL[f.quality],
    `${f.time_limit_ms}мс`,
  ];
  if (f.groupShift) parts.push('сжатие групп');
  if (f.engine === 'heuristic') {
    parts.push(f.cutQuality === 'max' ? 'движок: быстрый' : `движок: быстрый (${f.cutQuality})`);
  }
  if (f.engine === 'ga') parts.push('движок: GA');
  if (f.layout_mode === 'vacuum_table' && f.vacuum?.direction) {
    parts.push(VACUUM_DIRECTION_LABEL[f.vacuum.direction]);
  }
  return parts.join(' / ');
}

/** Human-readable inconsistencies in RAW stored engine params. The admin API
 * returns profile params as-is (no merge validation on the read path), so the
 * form surfaces these instead of silently laundering them on save. */
export function detectEngineParamAnomalies(params: Record<string, unknown> | null | undefined): string[] {
  const p = params ?? {};
  const anomalies: string[] = [];

  if (p.engine !== undefined && p.engine !== 'ga' && p.engine !== 'heuristic') {
    anomalies.push(`неизвестное значение engine: ${String(p.engine)}`);
  }
  if (p.cut_quality !== undefined && !(FREECUT_CUT_QUALITIES as string[]).includes(String(p.cut_quality))) {
    // Mirrors the write-time validator: unknown tiers must be shown as-is
    // instead of being normalized to "max" by the form fallback.
    anomalies.push(`неизвестное значение cut_quality: ${String(p.cut_quality)}`);
  }
  if (p.cut_quality !== undefined && p.engine !== 'heuristic') {
    anomalies.push('cut_quality задан без engine=heuristic');
  }
  if (p.layout_mode === 'vacuum_table' && (p.engine !== undefined || p.cut_quality !== undefined)) {
    anomalies.push('engine/cut_quality не применимы к vacuum_table');
  }

  return anomalies;
}
