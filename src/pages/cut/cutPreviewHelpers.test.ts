import { describe, expect, it } from 'vitest';
import {
  resolveJobProfileParams,
  isVacuumLayout,
  shouldRotateLandscape,
  formatSheetSide,
  displayedSheetExtents,
} from './cutPreviewHelpers';
import type { CutParamProfile } from '../../api/cutConfigApi';

const profile = (id: number, params: Record<string, unknown>, over: Partial<CutParamProfile> = {}): CutParamProfile => ({
  cutParamProfileId: id,
  name: `P${id}`,
  params,
  isDefault: false,
  isActive: true,
  version: 0,
  ...over,
});

describe('cutPreviewHelpers', () => {
  describe('resolveJobProfileParams', () => {
    const vac = profile(1, { layout_mode: 'vacuum_table' });
    const guil = profile(2, { layout_mode: 'guillotine' }, { isDefault: true });

    it('returns the chosen profile params when paramProfileId is set', () => {
      expect(resolveJobProfileParams(1, [vac, guil], [])).toEqual({ layout_mode: 'vacuum_table' });
    });

    it('falls back to the runtime default profile params when paramProfileId is null', () => {
      // guil is is_default → runtime default
      expect(resolveJobProfileParams(null, [vac, guil], [])).toEqual({ layout_mode: 'guillotine' });
    });

    it('falls back to the default when the chosen id is absent', () => {
      expect(resolveJobProfileParams(99, [vac, guil], [])).toEqual({ layout_mode: 'guillotine' });
    });

    it('returns null when nothing resolves', () => {
      expect(resolveJobProfileParams(null, [], [])).toBeNull();
    });
  });

  describe('isVacuumLayout', () => {
    it('true only for vacuum_table', () => {
      expect(isVacuumLayout({ layout_mode: 'vacuum_table' })).toBe(true);
      expect(isVacuumLayout({ layout_mode: 'guillotine' })).toBe(false);
      expect(isVacuumLayout({})).toBe(false);
      expect(isVacuumLayout(null)).toBe(false);
    });
  });

  describe('shouldRotateLandscape', () => {
    it('rotates a portrait vacuum sheet', () => {
      expect(shouldRotateLandscape(1050, 2080, true)).toBe(true);
    });
    it('does not rotate an already-landscape vacuum sheet', () => {
      expect(shouldRotateLandscape(2800, 2070, true)).toBe(false);
    });
    it('never rotates a non-vacuum sheet', () => {
      expect(shouldRotateLandscape(1050, 2080, false)).toBe(false);
    });
    it('does not rotate a square sheet', () => {
      expect(shouldRotateLandscape(2000, 2000, true)).toBe(false);
    });
  });

  describe('formatSheetSide', () => {
    it('rounds and suffixes мм', () => {
      expect(formatSheetSide(2799.6)).toBe('2800 мм');
      expect(formatSheetSide(1050)).toBe('1050 мм');
    });
  });

  describe('displayedSheetExtents', () => {
    it('keeps extents when not rotated', () => {
      expect(displayedSheetExtents(2800, 2070, false)).toEqual({ horizontalMm: 2800, verticalMm: 2070 });
    });
    it('swaps extents when rotated (height becomes horizontal)', () => {
      expect(displayedSheetExtents(1050, 2080, true)).toEqual({ horizontalMm: 2080, verticalMm: 1050 });
    });
  });
});
