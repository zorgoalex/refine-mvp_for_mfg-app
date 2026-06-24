import type { DatabaseService } from '../../../database/database.service';
import {
  type CutConfigPort,
  type CutGrainRules,
  DEFAULT_FREECUT_PARAMS,
  DEFAULT_GRAIN_RULES,
  DEFAULT_READY_STATUS_CODES,
  DEFAULT_RENDER_PRESET,
} from '../application/cut-config';
import { type FreecutParams, validateGrainRule } from '../application/cut-freecut-mapping';
import { validateFreecutParams, validateStoredFreecutParamsRaw } from '../application/cut-config-validation';
import { RENDER_PRESETS } from '../render/sheet-png';

/**
 * Sources cut configuration from the `cut_config` tables (migration 023):
 * `cut_settings` (keyed rule sets) + `cut_param_profiles` (default profile).
 * Every read falls back to the in-code defaults when the row is missing or
 * empty, so a fresh DB (before any seed/edit) behaves exactly like Slice 1.
 */
export class PgCutConfigRepository implements CutConfigPort {
  constructor(private readonly database: DatabaseService) {}

  async getReadyStatusCodes(): Promise<readonly string[]> {
    const result = await this.database.query<{ value: { codes?: unknown } | null }>(
      `SELECT value FROM cut_settings WHERE key = 'eligibility.statuses' LIMIT 1`,
    );
    const codes = result.rows[0]?.value?.codes;
    if (Array.isArray(codes) && codes.length > 0) {
      return codes.map((code) => String(code));
    }
    return [...DEFAULT_READY_STATUS_CODES];
  }

  async getDefaultParams(): Promise<FreecutParams> {
    // Prefer the profile named in cut_settings.defaults.param_profile (config-as-
    // data); fall back to the is_default profile, then the in-code defaults.
    const defaultsRow = await this.database.query<{ value: { param_profile?: unknown } | null }>(
      `SELECT value FROM cut_settings WHERE key = 'defaults' LIMIT 1`,
    );
    const namedProfile = defaultsRow.rows[0]?.value?.param_profile;
    let stored: Record<string, unknown> | null | undefined;
    if (typeof namedProfile === 'string' && namedProfile.length > 0) {
      const byName = await this.database.query<{ params: Record<string, unknown> | null }>(
        `SELECT params FROM cut_param_profiles WHERE name = $1 AND is_active = true LIMIT 1`,
        [namedProfile],
      );
      stored = byName.rows[0]?.params;
    }
    if (!stored) {
      const byDefault = await this.database.query<{ params: Record<string, unknown> | null }>(
        `SELECT params FROM cut_param_profiles WHERE is_default = true AND is_active = true LIMIT 1`,
      );
      stored = byDefault.rows[0]?.params;
    }
    return this.mergeParams(stored);
  }

  private mergeParams(stored: unknown): FreecutParams {
    // Genuine absence → return defaults unchanged (no error).
    if (stored === null || stored === undefined) return { ...DEFAULT_FREECUT_PARAMS };

    // RAW stage: reject non-plain-object shapes that the merge would otherwise
    // silently launder into the defaults (false/"x"/[]/etc.). Also rejects
    // non-plain-object trim_mm and vacuum, plus invalid vacuum.direction enum.
    // Partial plain-object trim_mm overlays are still allowed here.
    validateStoredFreecutParamsRaw(stored);

    // stored is now guaranteed to be a plain object.
    const s = stored as Record<string, unknown>;
    const merged = { ...DEFAULT_FREECUT_PARAMS, ...s } as FreecutParams;

    // Deep-merge trim_mm: a partial stored overlay (e.g. {left:5}) fills the
    // other sides from the defaults. Arrays are already rejected by the RAW stage.
    const storedTrim = s.trim_mm as Record<string, unknown> | undefined;
    if (storedTrim !== undefined) {
      merged.trim_mm = { ...DEFAULT_FREECUT_PARAMS.trim_mm, ...storedTrim } as FreecutParams['trim_mm'];
    }

    // MERGED stage: full structural check on the deep-merged result so
    // layout_mode / objective / all-4-trim-sides / vacuum.direction / etc. are
    // well-formed before reaching freecut (mirrors getGrainRules pattern).
    validateFreecutParams(merged as unknown as Record<string, unknown>);

    return merged;
  }

  async getParamsByProfileId(id: number): Promise<FreecutParams | null> {
    const row = await this.database.query<{ params: Record<string, unknown> | null }>(
      `SELECT params FROM cut_param_profiles WHERE cut_param_profile_id = $1 AND is_active = true LIMIT 1`,
      [id],
    );
    if (row.rows.length === 0) return null;
    return this.mergeParams(row.rows[0].params);
  }

  async getRenderPresetPx(name: string): Promise<number> {
    const result = await this.database.query<{ target_px: number }>(
      `SELECT target_px FROM cut_render_presets WHERE name = $1 AND is_active = true LIMIT 1`,
      [name],
    );
    if (result.rows[0]) {
      return Number(result.rows[0].target_px);
    }
    // Fallback to the built-in preset map, then 'screen'.
    return RENDER_PRESETS[name as keyof typeof RENDER_PRESETS] ?? RENDER_PRESETS[DEFAULT_RENDER_PRESET as keyof typeof RENDER_PRESETS];
  }

  async getGrainRules(): Promise<CutGrainRules> {
    const result = await this.database.query<{
      value: { textured?: unknown; plain?: unknown } | null;
    }>(`SELECT value FROM cut_settings WHERE key = 'grain.rules' LIMIT 1`);
    const value = result.rows[0]?.value;
    if (!value?.textured || !value?.plain) {
      return DEFAULT_GRAIN_RULES;
    }
    // Validate stored rules so a corrupt config row can never reach freecut.
    return {
      textured: validateGrainRule(value.textured as { rotation: unknown; pattern_direction: unknown }),
      plain: validateGrainRule(value.plain as { rotation: unknown; pattern_direction: unknown }),
    };
  }
}
