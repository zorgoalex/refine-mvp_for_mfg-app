import { describe, expect, it } from 'vitest';
import { resolveCalcParams } from './resolve-calc-params';

const def = { kerf_mm: 3, trim_mm: { left: 10, right: 10, top: 10, bottom: 10 } } as never;
const prof = { kerf_mm: 7, trim_mm: { left: 5, right: 5, top: 5, bottom: 5 } } as never;
const snap = { kerf_mm: 4, trim_mm: { left: 8, right: 8, top: 8, bottom: 8 } } as never;

describe('resolveCalcParams', () => {
  it('profile set (params provided by caller) -> profile params', () => {
    expect(resolveCalcParams({ profileId: 2, jobParams: snap, profileParams: prof, defaultParams: def })).toBe(prof);
  });
  it('THROWS if profileId is set but profileParams is null (no silent default)', () => {
    expect(() => resolveCalcParams({ profileId: 2, jobParams: snap, profileParams: null, defaultParams: def })).toThrow();
  });
  it('no profile + create-time snapshot present -> snapshot (legacy stale-safe)', () => {
    expect(resolveCalcParams({ profileId: null, jobParams: snap, profileParams: null, defaultParams: def })).toBe(snap);
  });
  it('no profile + empty snapshot -> runtime default', () => {
    expect(resolveCalcParams({ profileId: null, jobParams: {} as never, profileParams: null, defaultParams: def })).toBe(def);
    expect(resolveCalcParams({ profileId: null, jobParams: null, profileParams: null, defaultParams: def })).toBe(def);
  });
});
