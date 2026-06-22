import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PARAM_FORM,
  extractEligibilityCodes,
  findSetting,
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
