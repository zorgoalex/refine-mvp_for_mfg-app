import { describe, expect, it } from 'vitest';
import {
  formatSheetSide,
  displayedSheetExtents,
  sheetOrientationKey,
  parseStoredPortrait,
} from './cutPreviewHelpers';

describe('cutPreviewHelpers', () => {
  describe('formatSheetSide', () => {
    it('rounds and suffixes мм', () => {
      expect(formatSheetSide(2799.6)).toBe('2800 мм');
      expect(formatSheetSide(1050)).toBe('1050 мм');
    });
  });

  describe('displayedSheetExtents', () => {
    it('keeps extents in portrait', () => {
      expect(displayedSheetExtents(2800, 2070, false)).toEqual({ horizontalMm: 2800, verticalMm: 2070 });
    });
    it('swaps extents in landscape (height becomes horizontal)', () => {
      expect(displayedSheetExtents(1050, 2080, true)).toEqual({ horizontalMm: 2080, verticalMm: 1050 });
    });
  });

  describe('sheetOrientationKey', () => {
    it('is namespaced per user and job', () => {
      expect(sheetOrientationKey('78', 175)).toBe('cut:sheet-orientation:78:175');
    });
  });

  describe('parseStoredPortrait', () => {
    it('defaults to portrait for absent/unknown values', () => {
      expect(parseStoredPortrait(null)).toBe(true);
      expect(parseStoredPortrait('portrait')).toBe(true);
      expect(parseStoredPortrait('garbage')).toBe(true);
    });
    it('returns false only for the explicit landscape value', () => {
      expect(parseStoredPortrait('landscape')).toBe(false);
    });
  });
});
