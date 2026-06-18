import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PARAM_FORM,
  extractEligibilityCodes,
  findSetting,
  formToParams,
  paramsToForm,
  parseCodesCsv,
  sheetSpecOnboardingHint,
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
});
