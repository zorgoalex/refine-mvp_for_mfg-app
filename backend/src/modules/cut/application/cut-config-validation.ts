import { ApiError } from '../../../common/errors/api-error';
import { validateGrainRule } from './cut-freecut-mapping';
import type {
  CutParamProfileInput,
  CutRenderPresetInput,
} from './cut-config-admin.types';

/** Editable cut_settings keys (bounded allowlist — rules-as-data, not arbitrary). */
export const CUT_SETTING_KEYS = ['eligibility.statuses', 'grain.rules', 'defaults', 'auto_trigger'] as const;
export type CutSettingKey = (typeof CUT_SETTING_KEYS)[number];

function invalid(field: string, message: string): never {
  throw new ApiError(422, 'CUT_CONFIG_VALIDATION_ERROR', message, { field });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Write-time validation for a cut_settings row, keyed by setting name. Grain
 * rules go through the freecut enum check so a misconfigured rule can never
 * produce a freecut 422 at calculate time (plan §6, MINOR-13).
 */
export function validateSettingValue(key: string, value: unknown): Record<string, unknown> {
  if (!(CUT_SETTING_KEYS as readonly string[]).includes(key)) {
    invalid('key', `Неизвестный ключ настройки раскроя: ${key}`);
  }
  if (!isObject(value)) {
    invalid('value', 'Значение настройки должно быть объектом');
  }
  const v = value as Record<string, unknown>;

  if (key === 'eligibility.statuses') {
    const codes = v.codes;
    if (!Array.isArray(codes) || codes.length === 0 || !codes.every((c) => typeof c === 'string')) {
      invalid('codes', 'eligibility.statuses.codes должен быть непустым массивом строк');
    }
    // Trim BEFORE the blank check so "   " can't survive as "" and silently
    // disable the status filter (leakage regression).
    const trimmed = (codes as string[]).map((c) => c.trim());
    if (trimmed.some((c) => c.length === 0)) {
      invalid('codes', 'eligibility.statuses.codes не должен содержать пустые коды');
    }
    return { codes: trimmed };
  }

  if (key === 'grain.rules') {
    if (!isObject(v.textured) || !isObject(v.plain)) {
      invalid('grain', 'grain.rules должен содержать textured и plain');
    }
    return {
      textured: validateGrainRule(v.textured as { rotation: unknown; pattern_direction: unknown }),
      plain: validateGrainRule(v.plain as { rotation: unknown; pattern_direction: unknown }),
    };
  }

  if (key === 'defaults') {
    if (v.param_profile !== undefined && typeof v.param_profile !== 'string') {
      invalid('param_profile', 'defaults.param_profile должен быть строкой');
    }
    if (v.render_preset !== undefined && typeof v.render_preset !== 'string') {
      invalid('render_preset', 'defaults.render_preset должен быть строкой');
    }
    return v;
  }

  if (key === 'auto_trigger') {
    if (v.enabled !== undefined && typeof v.enabled !== 'boolean') {
      invalid('enabled', 'auto_trigger.enabled должен быть boolean');
    }
    return v;
  }

  return v;
}

const LAYOUT_MODES = ['guillotine', 'nested'];
const OBJECTIVES = ['min_waste', 'min_sheets'];
const RETRY_STRATEGIES = ['disabled', 'smart'];
const QUALITY_PROFILES = ['fast', 'balanced', 'quality'];

/**
 * Structural validation of the known freecut param keys so a stored profile can
 * never push an out-of-range value (e.g. negative kerf, unknown layout_mode) to
 * freecut and 422 at calculate time. Unknown extra keys are tolerated (freecut
 * ignores them); known keys, when present, must be well-formed.
 */
function validateFreecutParams(params: Record<string, unknown>): void {
  for (const key of ['kerf_mm', 'spacing_mm', 'time_limit_ms', 'restarts']) {
    const value = params[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      invalid(`params.${key}`, `${key} должен быть неотрицательным числом`);
    }
  }
  if (params.layout_mode !== undefined && !LAYOUT_MODES.includes(params.layout_mode as string)) {
    invalid('params.layout_mode', `layout_mode должен быть одним из: ${LAYOUT_MODES.join(', ')}`);
  }
  if (params.objective !== undefined && !OBJECTIVES.includes(params.objective as string)) {
    invalid('params.objective', `objective должен быть одним из: ${OBJECTIVES.join(', ')}`);
  }
  if (params.retry_strategy !== undefined && !RETRY_STRATEGIES.includes(params.retry_strategy as string)) {
    invalid('params.retry_strategy', `retry_strategy должен быть одним из: ${RETRY_STRATEGIES.join(', ')}`);
  }
  for (const key of ['sla_profile', 'ga_profile']) {
    const value = params[key];
    if (value !== undefined && !QUALITY_PROFILES.includes(value as string)) {
      invalid(`params.${key}`, `${key} должен быть одним из: ${QUALITY_PROFILES.join(', ')}`);
    }
  }
  if (params.group_shift !== undefined) {
    const gs = params.group_shift;
    if (!isObject(gs)) invalid('params.group_shift', 'group_shift должен быть объектом');
    const g = gs as Record<string, unknown>;
    if (g.enabled !== undefined && typeof g.enabled !== 'boolean') {
      invalid('params.group_shift.enabled', 'group_shift.enabled должен быть boolean');
    }
    if (
      g.min_shift_mm !== undefined &&
      (typeof g.min_shift_mm !== 'number' || !Number.isFinite(g.min_shift_mm) || g.min_shift_mm < 0)
    ) {
      invalid('params.group_shift.min_shift_mm', 'group_shift.min_shift_mm должен быть неотрицательным числом');
    }
    if (
      g.max_passes !== undefined &&
      (!Number.isInteger(g.max_passes) || (g.max_passes as number) < 1 || (g.max_passes as number) > 16)
    ) {
      invalid('params.group_shift.max_passes', 'group_shift.max_passes должен быть целым числом 1..16');
    }
  }
  if (params.trim_mm !== undefined) {
    if (!isObject(params.trim_mm)) invalid('params.trim_mm', 'trim_mm должен быть объектом');
    // Require ALL four sides when trim_mm is present: the freecut payload type
    // needs a complete trim, and getDefaultParams only shallow-merges the top
    // level — a partial trim_mm would otherwise drop the other sides.
    for (const side of ['left', 'right', 'top', 'bottom']) {
      const value = (params.trim_mm as Record<string, unknown>)[side];
      if (typeof value !== 'number' || value < 0) {
        invalid(`params.trim_mm.${side}`, `trim_mm.${side} должен быть неотрицательным числом (укажите все 4 стороны)`);
      }
    }
  }
}

export function validateParamProfileInput(input: CutParamProfileInput): CutParamProfileInput {
  if (!input.name || input.name.trim().length === 0) invalid('name', 'Укажите название профиля');
  if (!isObject(input.params)) invalid('params', 'params должен быть объектом');
  validateFreecutParams(input.params);
  return { ...input, name: input.name.trim() };
}

/** Preset names must be URL/path-safe so the /cut render endpoint can serve them
 *  (the render route's parsePreset only accepts this token shape). Enforcing it at
 *  write time prevents creating a preset that cannot be rendered. */
export const RENDER_PRESET_NAME_RE = /^[A-Za-z0-9_-]+$/;

export function validateRenderPresetInput(input: CutRenderPresetInput): CutRenderPresetInput {
  const name = (input.name ?? '').trim();
  if (name.length === 0) invalid('name', 'Укажите название пресета');
  if (name.length > 64 || !RENDER_PRESET_NAME_RE.test(name)) {
    invalid('name', 'Имя пресета: латиница/цифры/дефис/подчёркивание, до 64 символов');
  }
  if (!Number.isInteger(input.targetPx) || input.targetPx <= 0) invalid('targetPx', 'targetPx должен быть > 0');
  return { ...input, name };
}
