import { describe, expect, it } from 'vitest';
import {
  validateParamProfileInput,
  validateRenderPresetInput,
  validateSettingValue,
} from './cut-config-validation';

describe('cut-config validation', () => {
  it('accepts a well-formed eligibility.statuses value', () => {
    expect(validateSettingValue('eligibility.statuses', { codes: ['new', 'drawn'] })).toEqual({
      codes: ['new', 'drawn'],
    });
  });

  it('rejects eligibility.statuses without a non-empty codes array', () => {
    expect(() => validateSettingValue('eligibility.statuses', { codes: [] })).toThrow();
    expect(() => validateSettingValue('eligibility.statuses', {})).toThrow();
  });

  it('rejects blank eligibility codes (would silently disable the status filter)', () => {
    expect(() => validateSettingValue('eligibility.statuses', { codes: ['   '] })).toThrow();
    expect(() => validateSettingValue('eligibility.statuses', { codes: ['new', ''] })).toThrow();
    // valid codes are trimmed
    expect(validateSettingValue('eligibility.statuses', { codes: [' new ', 'drawn'] })).toEqual({ codes: ['new', 'drawn'] });
  });

  it('validates grain.rules via the freecut enum (no invalid rotation reaches freecut)', () => {
    const ok = validateSettingValue('grain.rules', {
      textured: { rotation: 'forbid', pattern_direction: 'along_height' },
      plain: { rotation: 'allow_90', pattern_direction: 'none' },
    });
    expect(ok).toBeTruthy();
    expect(() =>
      validateSettingValue('grain.rules', {
        textured: { rotation: 'spin', pattern_direction: 'none' },
        plain: { rotation: 'allow_90', pattern_direction: 'none' },
      }),
    ).toThrow();
  });

  it('rejects an unknown setting key', () => {
    expect(() => validateSettingValue('totally.unknown', {})).toThrow();
  });

  it('validates render preset target px is positive', () => {
    expect(validateRenderPresetInput({ name: 'screen', targetPx: 1400 }).targetPx).toBe(1400);
    expect(() => validateRenderPresetInput({ name: 'x', targetPx: 0 })).toThrow();
  });

  it('rejects a render preset name that the /cut render endpoint could not serve', () => {
    expect(validateRenderPresetInput({ name: 'big_screen-2', targetPx: 1400 }).name).toBe('big_screen-2');
    // spaces / non-ASCII would 422 at parsePreset, so reject them at write time
    expect(() => validateRenderPresetInput({ name: 'Большой экран', targetPx: 1400 })).toThrow();
    expect(() => validateRenderPresetInput({ name: 'with space', targetPx: 1400 })).toThrow();
  });

  it('validates known freecut param keys in a profile (no out-of-range value reaches freecut)', () => {
    expect(validateParamProfileInput({ name: 'ok', params: { kerf_mm: 2, layout_mode: 'guillotine', objective: 'min_waste' } }).name).toBe('ok');
    expect(() => validateParamProfileInput({ name: 'bad', params: { kerf_mm: -1 } })).toThrow();
    expect(() => validateParamProfileInput({ name: 'bad', params: { layout_mode: 'invalid' } })).toThrow();
    expect(() => validateParamProfileInput({ name: 'bad', params: { retry_strategy: 'turbo' } })).toThrow();
    expect(() => validateParamProfileInput({ name: '', params: {} })).toThrow();
    // Unknown extra keys are tolerated (freecut ignores them).
    expect(validateParamProfileInput({ name: 'ok', params: { future_key: 1 } }).name).toBe('ok');
  });

  it('requires all four trim_mm sides when trim_mm is present (no partial trim)', () => {
    expect(validateParamProfileInput({ name: 'ok', params: { trim_mm: { left: 5, right: 5, top: 5, bottom: 5 } } }).name).toBe('ok');
    expect(() => validateParamProfileInput({ name: 'bad', params: { trim_mm: { left: 5 } } })).toThrow();
  });

  it('rejects malformed defaults / auto_trigger setting values', () => {
    expect(validateSettingValue('defaults', { param_profile: 'default', render_preset: 'screen' })).toBeTruthy();
    expect(() => validateSettingValue('defaults', { param_profile: 5 })).toThrow();
    expect(validateSettingValue('auto_trigger', { enabled: false })).toBeTruthy();
    expect(() => validateSettingValue('auto_trigger', { enabled: 'yes' })).toThrow();
  });

  it('accepts valid quality (sla_profile/ga_profile) and group_shift params', () => {
    expect(
      validateParamProfileInput({
        name: 'ok',
        params: {
          sla_profile: 'quality',
          ga_profile: 'quality',
          group_shift: { enabled: true, min_shift_mm: 5, max_passes: 4, debug_artifacts: true },
        },
      }).name,
    ).toBe('ok');
  });

  it('rejects an out-of-enum quality profile', () => {
    expect(() => validateParamProfileInput({ name: 'bad', params: { sla_profile: 'turbo' } })).toThrow();
    expect(() => validateParamProfileInput({ name: 'bad', params: { ga_profile: 'ultra' } })).toThrow();
  });

  it('rejects a malformed group_shift (no bad value reaches freecut)', () => {
    expect(() => validateParamProfileInput({ name: 'bad', params: { group_shift: 'on' } })).toThrow();
    expect(() => validateParamProfileInput({ name: 'bad', params: { group_shift: { enabled: 'yes' } } })).toThrow();
    expect(() => validateParamProfileInput({ name: 'bad', params: { group_shift: { min_shift_mm: -1 } } })).toThrow();
    expect(() => validateParamProfileInput({ name: 'bad', params: { group_shift: { max_passes: 0 } } })).toThrow();
    expect(() => validateParamProfileInput({ name: 'bad', params: { group_shift: { max_passes: 99 } } })).toThrow();
    expect(() => validateParamProfileInput({ name: 'bad', params: { group_shift: { debug_artifacts: 'yes' } } })).toThrow();
  });

  it('accepts vacuum_table layout_mode with each valid direction and without vacuum', () => {
    // layout_mode: 'vacuum_table' alone
    expect(
      validateParamProfileInput({ name: 'ok', params: { layout_mode: 'vacuum_table' } }).name,
    ).toBe('ok');
    // with each valid direction
    for (const dir of ['optimal', 'width', 'height']) {
      expect(
        validateParamProfileInput({ name: 'ok', params: { layout_mode: 'vacuum_table', vacuum: { direction: dir } } }).name,
      ).toBe('ok');
    }
    // vacuum present but direction omitted
    expect(
      validateParamProfileInput({ name: 'ok', params: { layout_mode: 'vacuum_table', vacuum: {} } }).name,
    ).toBe('ok');
    // vacuum omitted entirely (existing modes unaffected)
    expect(
      validateParamProfileInput({ name: 'ok', params: { layout_mode: 'guillotine' } }).name,
    ).toBe('ok');
    expect(
      validateParamProfileInput({ name: 'ok', params: { layout_mode: 'nested' } }).name,
    ).toBe('ok');
    // no layout_mode at all still fine
    expect(
      validateParamProfileInput({ name: 'ok', params: {} }).name,
    ).toBe('ok');
  });

  it('rejects invalid vacuum values (no bad vacuum reaches freecut)', () => {
    // vacuum: null must be rejected
    expect(() => validateParamProfileInput({ name: 'bad', params: { vacuum: null } })).toThrow();
    // vacuum: [] must be rejected (array is not a plain object)
    expect(() => validateParamProfileInput({ name: 'bad', params: { vacuum: [] } })).toThrow();
    // vacuum.direction as a number must be rejected
    expect(() => validateParamProfileInput({ name: 'bad', params: { vacuum: { direction: 5 } } })).toThrow();
    // vacuum.direction as unknown string must be rejected
    expect(() => validateParamProfileInput({ name: 'bad', params: { vacuum: { direction: 'diagonal' } } })).toThrow();
  });
});
