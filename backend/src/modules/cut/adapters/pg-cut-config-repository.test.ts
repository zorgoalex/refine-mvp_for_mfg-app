import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import {
  CUT_RENDER_STYLE_DEFAULT,
  CUT_RENDER_STYLE_MDF_BOARD_PREVIEW,
  DEFAULT_CUT_RENDER_STYLES_SETTING,
} from '../../../shared/cut-render-style';
import {
  DEFAULT_FREECUT_PARAMS,
  DEFAULT_GRAIN_RULES,
  DEFAULT_READY_STATUS_CODES,
} from '../application/cut-config';
import { PgCutConfigRepository } from './pg-cut-config-repository';

function fakeDatabase(routes: Record<string, unknown[]>) {
  return {
    query: (text: string) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      for (const [needle, rows] of Object.entries(routes)) {
        if (sql.includes(needle)) return Promise.resolve({ rows, rowCount: rows.length });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as DatabaseService;
}

describe('PgCutConfigRepository', () => {
  it('reads ready-to-cut status codes from cut_settings', async () => {
    const repo = new PgCutConfigRepository(
      fakeDatabase({ "key = 'eligibility.statuses'": [{ value: { codes: ['drawn', 'cut'] } }] }),
    );
    expect(await repo.getReadyStatusCodes()).toEqual(['drawn', 'cut']);
  });

  it('falls back to the documented default codes when the settings row is absent', async () => {
    const repo = new PgCutConfigRepository(fakeDatabase({}));
    expect(await repo.getReadyStatusCodes()).toEqual([...DEFAULT_READY_STATUS_CODES]);
  });

  it('falls back to default codes when the stored codes array is empty', async () => {
    const repo = new PgCutConfigRepository(
      fakeDatabase({ "key = 'eligibility.statuses'": [{ value: { codes: [] } }] }),
    );
    expect(await repo.getReadyStatusCodes()).toEqual([...DEFAULT_READY_STATUS_CODES]);
  });

  it('reads the default param profile and merges it over the freecut defaults', async () => {
    const repo = new PgCutConfigRepository(
      fakeDatabase({ 'FROM cut_param_profiles': [{ params: { time_limit_ms: 3000, restarts: 9 } }] }),
    );
    const params = await repo.getDefaultParams();
    expect(params.time_limit_ms).toBe(3000);
    expect(params.restarts).toBe(9);
    // unspecified keys fall back to the calibrated defaults
    expect(params.kerf_mm).toBe(DEFAULT_FREECUT_PARAMS.kerf_mm);
    expect(params.objective).toBe(DEFAULT_FREECUT_PARAMS.objective);
  });

  it('prefers the profile named in cut_settings.defaults.param_profile', async () => {
    const repo = new PgCutConfigRepository(
      fakeDatabase({
        "key = 'defaults'": [{ value: { param_profile: 'fast' } }],
        'name = $1': [{ params: { time_limit_ms: 800 } }],
      }),
    );
    const params = await repo.getDefaultParams();
    expect(params.time_limit_ms).toBe(800);
    expect(params.kerf_mm).toBe(DEFAULT_FREECUT_PARAMS.kerf_mm);
  });

  it('falls back to default freecut params when no default profile exists', async () => {
    const repo = new PgCutConfigRepository(fakeDatabase({}));
    expect(await repo.getDefaultParams()).toEqual(DEFAULT_FREECUT_PARAMS);
  });

  it('reads grain rules from cut_settings', async () => {
    const repo = new PgCutConfigRepository(
      fakeDatabase({
        "key = 'grain.rules'": [
          {
            value: {
              textured: { rotation: 'forbid', pattern_direction: 'along_width' },
              plain: { rotation: 'allow_90', pattern_direction: 'none' },
            },
          },
        ],
      }),
    );
    const rules = await repo.getGrainRules();
    expect(rules.textured.pattern_direction).toBe('along_width');
  });

  it('falls back to default grain rules when absent', async () => {
    const repo = new PgCutConfigRepository(fakeDatabase({}));
    expect(await repo.getGrainRules()).toEqual(DEFAULT_GRAIN_RULES);
  });

  it('resolves render preset px from cut_render_presets, falling back to the built-in map', async () => {
    const repo = new PgCutConfigRepository(
      fakeDatabase({ 'FROM cut_render_presets': [{ target_px: 999 }] }),
    );
    expect(await repo.getRenderPresetPx('screen')).toBe(999);
    // Unknown preset with empty config falls back to the built-in 'screen' size.
    const empty = new PgCutConfigRepository(fakeDatabase({}));
    expect(await empty.getRenderPresetPx('totally-unknown')).toBe(1400);
    expect(await empty.getRenderPresetPx('thumb')).toBe(360);
  });

  it('reads render style rules from cut_settings', async () => {
    const repo = new PgCutConfigRepository(
      fakeDatabase({
        ['WHERE key = $1 LIMIT 1']: [{
          value: (() => {
            const profile = {
              ...DEFAULT_CUT_RENDER_STYLES_SETTING.profiles.mdf_board_preview,
              piece: {
                ...DEFAULT_CUT_RENDER_STYLES_SETTING.profiles.mdf_board_preview.piece,
                stroke: '#123456',
              },
              sourceSvg: {
                ...DEFAULT_CUT_RENDER_STYLES_SETTING.profiles.mdf_board_preview.sourceSvg,
                minStrokePx: 3,
                nonScalingStroke: true,
              },
            };
            return {
              ...DEFAULT_CUT_RENDER_STYLES_SETTING,
              profiles: {
                ...DEFAULT_CUT_RENDER_STYLES_SETTING.profiles,
                mdf_board_preview: profile,
              },
              templates: DEFAULT_CUT_RENDER_STYLES_SETTING.templates.map((template) =>
                template.id === 'mdf_board_preview' ? { ...template, profile } : template,
              ),
            };
          })(),
        }],
      }),
    );

    const style = await repo.getRenderStyleRule(CUT_RENDER_STYLE_MDF_BOARD_PREVIEW);

    expect(style.piece.stroke).toBe('#123456');
    expect(style.sourceSvg.minStrokePx).toBe(3);
  });

  it('reads the independent PDF render style from the default profile', async () => {
    const customDefault = {
      ...DEFAULT_CUT_RENDER_STYLES_SETTING.profiles.default,
      piece: {
        ...DEFAULT_CUT_RENDER_STYLES_SETTING.profiles.default.piece,
        stroke: '#ff0000',
        strokeWidthMm: 12,
      },
      sourceSvg: {
        ...DEFAULT_CUT_RENDER_STYLES_SETTING.profiles.default.sourceSvg,
        strokeColorMode: 'fixed' as const,
        fixedStroke: '#00ff00',
      },
    };
    const repo = new PgCutConfigRepository(
      fakeDatabase({
        ['WHERE key = $1 LIMIT 1']: [{
          value: {
            ...DEFAULT_CUT_RENDER_STYLES_SETTING,
            profiles: {
              ...DEFAULT_CUT_RENDER_STYLES_SETTING.profiles,
              default: customDefault,
            },
          },
        }],
      }),
    );

    const style = await repo.getRenderStyleRule(CUT_RENDER_STYLE_DEFAULT);

    expect(style.piece.stroke).toBe('#ff0000');
    expect(style.piece.strokeWidthMm).toBe(12);
    expect(style.sourceSvg.fixedStroke).toBe('#00ff00');
  });

  it('falls back to the built-in render style when render.styles is absent or invalid', async () => {
    const absent = new PgCutConfigRepository(fakeDatabase({}));
    expect((await absent.getRenderStyleRule(CUT_RENDER_STYLE_MDF_BOARD_PREVIEW)).sourceSvg.minStrokePx).toBe(1.6);

    const invalid = new PgCutConfigRepository(
      fakeDatabase({ ['WHERE key = $1 LIMIT 1']: [{ value: { version: 1, profiles: { mdf_board_preview: { piece: { stroke: 'red' } } } } }] }),
    );
    expect((await invalid.getRenderStyleRule(CUT_RENDER_STYLE_MDF_BOARD_PREVIEW)).piece.stroke).toBe('#1f2d3d');
  });

  it('rejects an invalid stored grain rule rather than passing it to freecut', async () => {
    const repo = new PgCutConfigRepository(
      fakeDatabase({
        "key = 'grain.rules'": [
          { value: { textured: { rotation: 'spin', pattern_direction: 'none' }, plain: { rotation: 'allow_90', pattern_direction: 'none' } } },
        ],
      }),
    );
    await expect(repo.getGrainRules()).rejects.toMatchObject({ code: 'CUT_INVALID_GRAIN_RULE' });
  });
});

function stubDb(rows: Array<Record<string, unknown>>) {
  return { query: async () => ({ rows }) } as never;
}

describe('getParamsByProfileId', () => {
  it('returns null for an unknown/inactive profile', async () => {
    const repo = new PgCutConfigRepository(stubDb([]));
    expect(await repo.getParamsByProfileId(999)).toBeNull();
  });

  it('deep-merges stored params over defaults (partial trim keeps other sides)', async () => {
    const repo = new PgCutConfigRepository(stubDb([{ params: { kerf_mm: 4, trim_mm: { left: 5 } } }]));
    const p = await repo.getParamsByProfileId(1);
    expect(p?.kerf_mm).toBe(4);
    expect(p?.trim_mm.left).toBe(5);
    expect(p?.trim_mm.right).toBeTypeOf('number'); // not dropped
  });
});

// ---------------------------------------------------------------------------
// Task 1b — read-side validation of stored cut-param profiles
// ---------------------------------------------------------------------------

describe('mergeParams read-side validation (via getParamsByProfileId)', () => {
  it('rejects vacuum.direction with an invalid enum value (e.g. diagonal)', async () => {
    const repo = new PgCutConfigRepository(
      stubDb([{ params: { layout_mode: 'vacuum_table', vacuum: { direction: 'diagonal' } } }]),
    );
    await expect(repo.getParamsByProfileId(1)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects stored vacuum when it is an array', async () => {
    const repo = new PgCutConfigRepository(stubDb([{ params: { vacuum: [] } }]));
    await expect(repo.getParamsByProfileId(1)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects stored vacuum when it is null', async () => {
    const repo = new PgCutConfigRepository(stubDb([{ params: { vacuum: null } }]));
    await expect(repo.getParamsByProfileId(1)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects top-level stored = false (non-object)', async () => {
    const repo = new PgCutConfigRepository(stubDb([{ params: false }]));
    await expect(repo.getParamsByProfileId(1)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects top-level stored = "x" (string)', async () => {
    const repo = new PgCutConfigRepository(stubDb([{ params: 'x' }]));
    await expect(repo.getParamsByProfileId(1)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects stored trim_mm when it is an array', async () => {
    const repo = new PgCutConfigRepository(stubDb([{ params: { trim_mm: [] } }]));
    await expect(repo.getParamsByProfileId(1)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('reads a valid vacuum profile cleanly', async () => {
    const repo = new PgCutConfigRepository(
      stubDb([{ params: { layout_mode: 'vacuum_table', vacuum: { direction: 'optimal' } } }]),
    );
    const p = await repo.getParamsByProfileId(1);
    expect(p?.layout_mode).toBe('vacuum_table');
    expect((p as unknown as Record<string, unknown>).vacuum).toEqual({ direction: 'optimal' });
  });

  it('null stored params still returns defaults cleanly', async () => {
    const repo = new PgCutConfigRepository(stubDb([{ params: null }]));
    const p = await repo.getParamsByProfileId(1);
    expect(p).toEqual(DEFAULT_FREECUT_PARAMS);
  });

  it('partial plain-object trim_mm overlay (left:5) still reads CLEAN (no regression)', async () => {
    const repo = new PgCutConfigRepository(stubDb([{ params: { kerf_mm: 4, trim_mm: { left: 5 } } }]));
    const p = await repo.getParamsByProfileId(1);
    expect(p?.trim_mm.left).toBe(5);
    expect(p?.trim_mm.right).toBeTypeOf('number');
  });
});

describe('mergeParams read-side validation (via getDefaultParams)', () => {
  it('rejects vacuum.direction diagonal via getDefaultParams path too', async () => {
    const repo = new PgCutConfigRepository(
      fakeDatabase({ 'FROM cut_param_profiles': [{ params: { vacuum: { direction: 'diagonal' } } }] }),
    );
    await expect(repo.getDefaultParams()).rejects.toMatchObject({ statusCode: 422 });
  });

  it('returns defaults when stored params is null via getDefaultParams', async () => {
    const repo = new PgCutConfigRepository(fakeDatabase({}));
    expect(await repo.getDefaultParams()).toEqual(DEFAULT_FREECUT_PARAMS);
  });
});

// ---------------------------------------------------------------------------
// Task 1b — named-profile fallback gating fix ([DATA-INTEGRITY-DEBT])
// ---------------------------------------------------------------------------

describe('getDefaultParams named-profile fallback gating', () => {
  // Helper: stub the three sequential queries for getDefaultParams.
  // - defaults row  → matched by "key = 'defaults'"
  // - by-name query → matched by "name = $1"
  // - by-default    → matched by "is_default = true"
  function makeRepo(
    namedProfileName: string,
    byNameRows: Array<Record<string, unknown>>,
    byDefaultRows: Array<Record<string, unknown>>,
  ) {
    return new PgCutConfigRepository(
      fakeDatabase({
        "key = 'defaults'": [{ value: { param_profile: namedProfileName } }],
        'name = $1': byNameRows,
        'is_default = true': byDefaultRows,
      }),
    );
  }

  it('named profile row present with params=false → rejects with 422 (no silent fallback)', async () => {
    const repo = makeRepo('named-profile', [{ params: false }], [{ params: { time_limit_ms: 9999 } }]);
    await expect(repo.getDefaultParams()).rejects.toMatchObject({ statusCode: 422 });
  });

  it('named profile row present with params=0 → rejects with 422 (no silent fallback)', async () => {
    const repo = makeRepo('named-profile', [{ params: 0 }], [{ params: { time_limit_ms: 9999 } }]);
    await expect(repo.getDefaultParams()).rejects.toMatchObject({ statusCode: 422 });
  });

  it('named profile row present with params="" → rejects with 422 (no silent fallback)', async () => {
    const repo = makeRepo('named-profile', [{ params: '' }], [{ params: { time_limit_ms: 9999 } }]);
    await expect(repo.getDefaultParams()).rejects.toMatchObject({ statusCode: 422 });
  });

  it('named profile row ABSENT → falls back to is_default profile (precedence preserved)', async () => {
    const repo = makeRepo('missing-profile', [], [{ params: { time_limit_ms: 7777 } }]);
    const params = await repo.getDefaultParams();
    expect(params.time_limit_ms).toBe(7777);
    expect(params.kerf_mm).toBe(DEFAULT_FREECUT_PARAMS.kerf_mm);
  });

  it('named profile row present with VALID params → used (no regression)', async () => {
    const repo = makeRepo('fast', [{ params: { time_limit_ms: 800 } }], [{ params: { time_limit_ms: 9999 } }]);
    const params = await repo.getDefaultParams();
    expect(params.time_limit_ms).toBe(800);
    expect(params.kerf_mm).toBe(DEFAULT_FREECUT_PARAMS.kerf_mm);
  });
});
