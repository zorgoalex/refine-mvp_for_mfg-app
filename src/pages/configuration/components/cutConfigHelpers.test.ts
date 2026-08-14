import { describe, expect, it } from 'vitest';
import {
  CUT_RENDER_STYLE_MDF_BOARD_PREVIEW,
  DEFAULT_CUT_RENDER_STYLES_SETTING,
} from '@shared/cut-render-style';
import {
  DEFAULT_PARAM_FORM,
  buildProfileCopyName,
  detectEngineParamAnomalies,
  extractEligibilityCodes,
  findCutRenderStylesSetting,
  findSetting,
  readCutRenderStylesSetting,
  formToParams,
  paramsToForm,
  parseCodesCsv,
  resolveRuntimeDefaultProfile,
  sheetSpecOnboardingHint,
  summarizeParams,
} from './cutConfigHelpers';

const settings = [
  { key: 'eligibility.statuses', value: { codes: ['new', 'drawn'] }, version: 2 },
  { key: 'grain.rules', value: {}, version: 0 },
];

describe('cutConfigHelpers', () => {
  it('finds a setting row by key', () => {
    expect(findSetting(settings, 'grain.rules')?.version).toBe(0);
    expect(findSetting(settings, 'missing')).toBeNull();
  });

  it('extracts eligibility codes from the settings', () => {
    expect(extractEligibilityCodes(settings)).toEqual(['new', 'drawn']);
    expect(extractEligibilityCodes([])).toEqual([]);
  });

  it('reads render.styles for the render settings tab', () => {
    expect(findCutRenderStylesSetting(settings)).toBeNull();
    expect(readCutRenderStylesSetting([]).profiles[CUT_RENDER_STYLE_MDF_BOARD_PREVIEW].sourceSvg.minStrokePx)
      .toBe(DEFAULT_CUT_RENDER_STYLES_SETTING.profiles[CUT_RENDER_STYLE_MDF_BOARD_PREVIEW].sourceSvg.minStrokePx);
    expect(readCutRenderStylesSetting([{
      key: 'render.styles',
      value: {
        ...DEFAULT_CUT_RENDER_STYLES_SETTING,
        profiles: {
          ...DEFAULT_CUT_RENDER_STYLES_SETTING.profiles,
          mdf_board_preview: {
            ...DEFAULT_CUT_RENDER_STYLES_SETTING.profiles.mdf_board_preview,
            sourceSvg: {
              ...DEFAULT_CUT_RENDER_STYLES_SETTING.profiles.mdf_board_preview.sourceSvg,
              minStrokePx: 3,
              nonScalingStroke: true,
            },
          },
        },
      },
      version: 1,
    }]).profiles[CUT_RENDER_STYLE_MDF_BOARD_PREVIEW].sourceSvg.minStrokePx).toBe(3);
  });

  it('parses a CSV/space code list, dropping blanks', () => {
    expect(parseCodesCsv('new, drawn  film_purchase ,')).toEqual(['new', 'drawn', 'film_purchase']);
    expect(parseCodesCsv('   ')).toEqual([]);
  });

  it('returns a Day-0 onboarding hint only when no sheet specs exist', () => {
    expect(sheetSpecOnboardingHint(0)).toContain('no_sheet_spec');
    expect(sheetSpecOnboardingHint(3)).toBeNull();
  });

  it('formToParams builds the freecut params shape (nested trim_mm, all 4 sides)', () => {
    const params = formToParams({ ...DEFAULT_PARAM_FORM, kerf_mm: 3, trim_left: 5 });
    expect(params).toMatchObject({
      kerf_mm: 3,
      spacing_mm: 1,
      trim_mm: { left: 5, right: 10, top: 10, bottom: 10 },
      objective: 'min_waste',
      layout_mode: 'guillotine',
      retry_strategy: 'disabled',
    });
  });

  it('paramsToForm reads nested trim_mm + fills gaps with defaults; round-trips with formToParams', () => {
    const form = paramsToForm({ kerf_mm: 4, trim_mm: { left: 7, right: 8, top: 9, bottom: 6 } });
    expect(form.kerf_mm).toBe(4);
    expect(form.trim_left).toBe(7);
    expect(form.spacing_mm).toBe(DEFAULT_PARAM_FORM.spacing_mm); // gap filled
    expect(form.objective).toBe('min_waste');
    // round-trip
    expect(paramsToForm(formToParams(form))).toEqual(form);
  });

  it('paramsToForm coerces unknown enum/non-number values to defaults', () => {
    const form = paramsToForm({ objective: 'bogus', layout_mode: 'x', kerf_mm: 'NaN' as unknown as number });
    expect(form.objective).toBe(DEFAULT_PARAM_FORM.objective);
    expect(form.layout_mode).toBe(DEFAULT_PARAM_FORM.layout_mode);
    expect(form.kerf_mm).toBe(DEFAULT_PARAM_FORM.kerf_mm);
  });

  it('formToParams sets sla_profile + ga_profile from quality and omits group_shift when off', () => {
    const params = formToParams({ ...DEFAULT_PARAM_FORM, quality: 'quality', groupShift: false });
    expect(params).toMatchObject({ sla_profile: 'quality', ga_profile: 'quality' });
    expect(params.group_shift).toBeUndefined();
  });

  it('formToParams writes the group_shift object when groupShift is on', () => {
    const params = formToParams({ ...DEFAULT_PARAM_FORM, groupShift: true });
    expect(params.group_shift).toEqual({ enabled: true, min_shift_mm: 5, max_passes: 4 });
  });

  it('paramsToForm derives quality (both profiles equal) and groupShift', () => {
    const form = paramsToForm({
      sla_profile: 'quality',
      ga_profile: 'quality',
      group_shift: { enabled: true },
    });
    expect(form.quality).toBe('quality');
    expect(form.groupShift).toBe(true);
  });

  it('paramsToForm falls back to balanced when profiles disagree or are absent (back-compat)', () => {
    expect(paramsToForm({ sla_profile: 'fast', ga_profile: 'quality' }).quality).toBe('balanced');
    expect(paramsToForm({}).quality).toBe('balanced');
    expect(paramsToForm({ group_shift: { enabled: false } }).groupShift).toBe(false);
    expect(paramsToForm({}).groupShift).toBe(false);
  });

  it('round-trips quality + groupShift through formToParams/paramsToForm', () => {
    const form = { ...DEFAULT_PARAM_FORM, quality: 'fast' as const, groupShift: true };
    expect(paramsToForm(formToParams(form))).toEqual(form);
  });

  it('summarizeParams renders a readable one-liner (no raw JSON)', () => {
    const s = summarizeParams(formToParams(DEFAULT_PARAM_FORM));
    expect(s).toContain('kerf 2');
    expect(s).toContain('баланс');
    expect(s).not.toContain('{');
  });

  // --- vacuum_table ---

  it('LAYOUT_LABEL contains vacuum_table (via summarizeParams)', () => {
    const s = summarizeParams({ layout_mode: 'vacuum_table', sla_profile: 'balanced', ga_profile: 'balanced' });
    expect(s).toContain('Вакуумный стол');
  });

  it('paramsToForm reads vacuum.direction into form.vacuum', () => {
    const form = paramsToForm({ layout_mode: 'vacuum_table', vacuum: { direction: 'width' } });
    expect(form.layout_mode).toBe('vacuum_table');
    expect(form.vacuum?.direction).toBe('width');
  });

  it('paramsToForm leaves form.vacuum undefined when stored params have no vacuum object', () => {
    const form = paramsToForm({ layout_mode: 'guillotine' });
    expect(form.vacuum).toBeUndefined();
  });

  it('formToParams writes vacuum back round-trip when layout_mode is vacuum_table', () => {
    const form = { ...DEFAULT_PARAM_FORM, layout_mode: 'vacuum_table' as const, vacuum: { direction: 'height' as const } };
    const params = formToParams(form);
    expect(params.layout_mode).toBe('vacuum_table');
    expect((params.vacuum as { direction: string } | undefined)?.direction).toBe('height');
    // round-trip: paramsToForm should recover the same form
    const roundTripped = paramsToForm(params);
    expect(roundTripped.layout_mode).toBe('vacuum_table');
    expect(roundTripped.vacuum?.direction).toBe('height');
  });

  it('formToParams OMITS vacuum key when layout_mode is NOT vacuum_table', () => {
    const form = { ...DEFAULT_PARAM_FORM, layout_mode: 'guillotine' as const, vacuum: { direction: 'width' as const } };
    const params = formToParams(form);
    expect('vacuum' in params).toBe(false);
  });

  it('summarizeParams includes vacuum direction for a vacuum profile', () => {
    const params = formToParams({ ...DEFAULT_PARAM_FORM, layout_mode: 'vacuum_table' as const, vacuum: { direction: 'optimal' as const } });
    const s = summarizeParams(params);
    expect(s).toContain('Вакуумный стол');
    expect(s).toContain('авто'); // optimal -> авто
  });

  describe('engine tri-state + cut_quality round-trip', () => {
    it('defaults to auto/max when params have no engine', () => {
      const form = paramsToForm({});
      expect(form.engine).toBe('auto');
      expect(form.cutQuality).toBe('max');
    });

    it('round-trips engine=heuristic with an explicit non-max tier (no silent rewrite)', () => {
      const form = paramsToForm({ engine: 'heuristic', cut_quality: 'balanced' });
      expect(form.engine).toBe('heuristic');
      expect(form.cutQuality).toBe('balanced');
      expect(formToParams(form)).toMatchObject({ engine: 'heuristic', cut_quality: 'balanced' });
    });

    it('maps engine=heuristic without tier to cut_quality max on save', () => {
      const form = paramsToForm({ engine: 'heuristic' });
      expect(formToParams(form)).toMatchObject({ engine: 'heuristic', cut_quality: 'max' });
    });

    it('maps engine=ga to the form and back without cut_quality', () => {
      const form = paramsToForm({ engine: 'ga' });
      expect(form.engine).toBe('ga');
      const params = formToParams(form);
      expect(params.engine).toBe('ga');
      expect(params).not.toHaveProperty('cut_quality');
    });

    it('auto emits neither engine nor cut_quality', () => {
      const params = formToParams({ ...DEFAULT_PARAM_FORM, engine: 'auto' });
      expect(params).not.toHaveProperty('engine');
      expect(params).not.toHaveProperty('cut_quality');
    });

    it('vacuum_table never serializes engine/cut_quality even with stale form state (Critic R1 F1)', () => {
      const params = formToParams({
        ...DEFAULT_PARAM_FORM,
        layout_mode: 'vacuum_table',
        engine: 'heuristic',
        cutQuality: 'max',
      });
      expect(params).not.toHaveProperty('engine');
      expect(params).not.toHaveProperty('cut_quality');
    });

    it('summarizeParams labels a forced engine with its tier', () => {
      expect(summarizeParams({ engine: 'heuristic', cut_quality: 'balanced' })).toContain('движок: быстрый (balanced)');
      expect(summarizeParams({ engine: 'heuristic', cut_quality: 'max' })).toContain('движок: быстрый');
      expect(summarizeParams({ engine: 'ga' })).toContain('движок: GA');
      expect(summarizeParams({})).not.toContain('движок');
    });
  });

  describe('detectEngineParamAnomalies (Critic R2: unmask raw stored anomalies instead of silent rewrite)', () => {
    it('returns empty for consistent params', () => {
      expect(detectEngineParamAnomalies({})).toEqual([]);
      expect(detectEngineParamAnomalies({ engine: 'heuristic', cut_quality: 'balanced' })).toEqual([]);
      expect(detectEngineParamAnomalies({ engine: 'ga' })).toEqual([]);
      expect(detectEngineParamAnomalies({ layout_mode: 'vacuum_table' })).toEqual([]);
    });

    it('flags cut_quality without engine=heuristic', () => {
      expect(detectEngineParamAnomalies({ cut_quality: 'balanced' })).toHaveLength(1);
      expect(detectEngineParamAnomalies({ engine: 'ga', cut_quality: 'max' })).toHaveLength(1);
    });

    it('flags engine/cut_quality on a vacuum_table profile', () => {
      expect(detectEngineParamAnomalies({ layout_mode: 'vacuum_table', engine: 'heuristic' })).toHaveLength(1);
    });

    it('flags an unknown engine value', () => {
      expect(detectEngineParamAnomalies({ engine: 'quantum' })).toHaveLength(1);
    });

    it('flags an unknown cut_quality tier even with engine=heuristic (Crit R3 F1)', () => {
      expect(detectEngineParamAnomalies({ engine: 'heuristic', cut_quality: 'turbo' })).toHaveLength(1);
    });
  });

  describe('buildProfileCopyName', () => {
    it('appends «(копия)» to the source name', () => {
      expect(buildProfileCopyName('МДФ быстрый')).toBe('МДФ быстрый (копия)');
    });
    it('trims surrounding whitespace before appending', () => {
      expect(buildProfileCopyName('  Профиль  ')).toBe('Профиль (копия)');
    });
    it('falls back to a generic name when the source is blank', () => {
      expect(buildProfileCopyName('')).toBe('Новый профиль (копия)');
      expect(buildProfileCopyName('   ')).toBe('Новый профиль (копия)');
    });
  });

  describe('resolveRuntimeDefaultProfile', () => {
    const P = (name: string, isDefault: boolean, isActive = true) => ({ name, isDefault, isActive });
    it('prefers the active profile named by cut_settings.defaults.param_profile', () => {
      const profiles = [P('A', true), P('B', false)];
      const settings = [{ key: 'defaults', value: { param_profile: 'B' } }];
      expect(resolveRuntimeDefaultProfile(profiles, settings)?.name).toBe('B');
    });
    it('falls back to the active is_default profile when no pointer is set', () => {
      expect(resolveRuntimeDefaultProfile([P('A', true), P('B', false)], [])?.name).toBe('A');
    });
    it('falls back to is_default when the pointer names a missing or inactive profile', () => {
      const inactiveB = [P('A', true), P('B', false, false)];
      expect(resolveRuntimeDefaultProfile(inactiveB, [{ key: 'defaults', value: { param_profile: 'B' } }])?.name).toBe('A');
      expect(resolveRuntimeDefaultProfile([P('A', true)], [{ key: 'defaults', value: { param_profile: 'X' } }])?.name).toBe('A');
    });
    it('ignores an inactive is_default profile and returns null when nothing matches', () => {
      expect(resolveRuntimeDefaultProfile([P('A', true, false)], [])).toBeNull();
      expect(resolveRuntimeDefaultProfile([P('A', false)], [])).toBeNull();
    });
  });
});
