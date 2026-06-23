import type { FreecutParams, GrainRule } from './cut-freecut-mapping';
import { RENDER_PRESETS } from '../render/sheet-png';

/**
 * Cut configuration contract (plan §4a). Slice 2 sources the ready-to-cut status
 * set, the default freecut params and the grain rules from the editable
 * `cut_config` tables (migration 023) instead of hard-coded constants. The
 * defaults below are the SAME values Slice 1 shipped; they are the documented
 * fallback used when the config tables are empty/absent (fresh DB before the
 * operator seeds or edits anything), so behaviour is identical until config is
 * touched.
 */

/** Ready-to-cut production-status CODES (resolved to ids at query time). */
export const DEFAULT_READY_STATUS_CODES = ['new', 'drawn', 'film_purchase'] as const;

/**
 * Default freecut params — the freecut recommended production payload + the
 * calibrated budget (commit dcfa2db: 1200ms/5 restarts + retry_strategy=disabled
 * => reliable ~1.5s SLA).
 */
export const DEFAULT_FREECUT_PARAMS: FreecutParams = {
  kerf_mm: 2,
  spacing_mm: 1,
  trim_mm: { left: 10, right: 10, top: 10, bottom: 10 },
  objective: 'min_waste',
  time_limit_ms: 1200,
  restarts: 5,
  layout_mode: 'guillotine',
  retry_strategy: 'disabled',
};

export interface CutGrainRules {
  /** Applied when films.film_texture = true (grain pinned). */
  textured: GrainRule;
  /** Applied when no film / film_texture = false. */
  plain: GrainRule;
}

/** Default grain rules (plan §6); film_texture=true pins the grain. */
export const DEFAULT_GRAIN_RULES: CutGrainRules = {
  textured: { rotation: 'forbid', pattern_direction: 'along_height' },
  plain: { rotation: 'allow_90', pattern_direction: 'none' },
};

/**
 * Read-only config access used by the cut engine at calculate/eligibility time.
 * Implementations resolve from the `cut_config` tables with a fallback to the
 * defaults above. Reads are uncached (config rarely changes; jobs snapshot their
 * params at creation so a config edit never retro-mutates an existing job).
 */
/** Built-in fallback preset sizes (used when a preset row is absent in config). */
export const DEFAULT_RENDER_PRESET = 'screen';

export interface CutConfigPort {
  getReadyStatusCodes(): Promise<readonly string[]>;
  getDefaultParams(): Promise<FreecutParams>;
  getGrainRules(): Promise<CutGrainRules>;
  /** Longest-side px for a render preset name, sourced from cut_render_presets. */
  getRenderPresetPx(name: string): Promise<number>;
  /** Resolve params for a specific active profile id (deep-merged with in-code
   *  defaults exactly like getDefaultParams). Returns null when the profile does
   *  not exist or is inactive. */
  getParamsByProfileId(id: number): Promise<import('./cut-freecut-mapping').FreecutParams | null>;
}

/** Static config (defaults only) for tests and the unavailable-DB repository. */
export class StaticCutConfig implements CutConfigPort {
  getReadyStatusCodes(): Promise<readonly string[]> {
    return Promise.resolve([...DEFAULT_READY_STATUS_CODES]);
  }
  getDefaultParams(): Promise<FreecutParams> {
    return Promise.resolve({ ...DEFAULT_FREECUT_PARAMS });
  }
  getGrainRules(): Promise<CutGrainRules> {
    return Promise.resolve(DEFAULT_GRAIN_RULES);
  }
  getRenderPresetPx(name: string): Promise<number> {
    return Promise.resolve(RENDER_PRESETS[name as keyof typeof RENDER_PRESETS] ?? RENDER_PRESETS[DEFAULT_RENDER_PRESET]);
  }
  getParamsByProfileId(): Promise<FreecutParams | null> {
    return Promise.resolve(null); // no profile catalog in static config → unresolved
  }
}
