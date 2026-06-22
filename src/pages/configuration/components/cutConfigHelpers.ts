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

// --- freecut param profile: structured form (no raw JSON in the UI) ---

export type FreecutObjective = 'min_waste' | 'min_sheets';
export type FreecutLayoutMode = 'guillotine' | 'nested';
export type FreecutRetryStrategy = 'disabled' | 'smart';
export type FreecutQuality = 'fast' | 'balanced' | 'quality';
export const FREECUT_QUALITIES: FreecutQuality[] = ['fast', 'balanced', 'quality'];

export const FREECUT_OBJECTIVES: FreecutObjective[] = ['min_waste', 'min_sheets'];
export const FREECUT_LAYOUT_MODES: FreecutLayoutMode[] = ['guillotine', 'nested'];
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
  groupShift: boolean;
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
    groupShift: isPlainObject(p.group_shift) && (p.group_shift as { enabled?: unknown }).enabled === true,
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
    ...(form.groupShift ? { group_shift: { enabled: true, min_shift_mm: 5, max_passes: 4 } } : {}),
  };
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
  return parts.join(' / ');
}
