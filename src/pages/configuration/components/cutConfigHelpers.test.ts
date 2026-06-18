import { describe, expect, it } from 'vitest';
import {
  extractEligibilityCodes,
  findSetting,
  parseCodesCsv,
  parseJsonObject,
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

  it('parses a JSON object, rejecting non-objects and bad JSON', () => {
    expect(parseJsonObject('{"kerf_mm":2}')).toEqual({ ok: true, value: { kerf_mm: 2 } });
    expect(parseJsonObject('[]').ok).toBe(false);
    expect(parseJsonObject('not json').ok).toBe(false);
    expect(parseJsonObject('null').ok).toBe(false);
  });
});
