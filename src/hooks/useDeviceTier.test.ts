import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  tierFromMatches,
  PHONE_LANDSCAPE_MEDIA_QUERY,
  PHONE_MEDIA_QUERY,
  TABLET_LANDSCAPE_MEDIA_QUERY,
  TABLET_MEDIA_QUERY,
  COARSE_POINTER_QUERY,
  LANDSCAPE_MEDIA_QUERY,
  readDeviceTier,
} from './useDeviceTier';

describe('tierFromMatches', () => {
  it('phone wins over tablet', () => {
    expect(tierFromMatches(true, false, false, false)).toBe('phone');
    expect(tierFromMatches(true, true, true, true)).toBe('phone');
  });
  it('forced tablet mode wins over physical phone and desktop matches', () => {
    expect(tierFromMatches(true, true, false, false, true, false)).toBe('tablet');
    expect(tierFromMatches(false, false, false, false, true, true)).toBe('tablet-landscape');
  });
  it('keeps wide short coarse devices in the phone tier', () => {
    expect(tierFromMatches(false, true, true, false)).toBe('phone');
  });
  it('prefers tablet landscape over compact tablet', () => {
    expect(tierFromMatches(false, false, true, true)).toBe('tablet-landscape');
  });
  it('uses tablet for compact coarse portrait', () => {
    expect(tierFromMatches(false, false, false, true)).toBe('tablet');
  });
  it('desktop otherwise', () => {
    expect(tierFromMatches(false, false, false, false)).toBe('desktop');
  });
});

describe('media query constants', () => {
  it('non-overlapping phone/tablet ranges', () => {
    expect(PHONE_MEDIA_QUERY).toBe('(max-width: 767px)');
    expect(PHONE_LANDSCAPE_MEDIA_QUERY).toContain('(pointer: coarse)');
    expect(PHONE_LANDSCAPE_MEDIA_QUERY).toContain('(any-pointer: coarse)');
    expect(TABLET_MEDIA_QUERY).toContain('(pointer: coarse)');
    expect(TABLET_MEDIA_QUERY).toContain('(any-pointer: coarse)');
    expect(TABLET_MEDIA_QUERY).toContain('(orientation: portrait)');
    expect(TABLET_LANDSCAPE_MEDIA_QUERY).toContain('(pointer: coarse)');
    expect(TABLET_LANDSCAPE_MEDIA_QUERY).toContain('(any-pointer: coarse)');
    expect(TABLET_LANDSCAPE_MEDIA_QUERY).toContain('(orientation: landscape)');
    expect(COARSE_POINTER_QUERY).toBe('(pointer: coarse), (any-pointer: coarse)');
    expect(LANDSCAPE_MEDIA_QUERY).toBe('(orientation: landscape)');
  });

  it('detects a hybrid tablet with a fine primary pointer and coarse touch input', () => {
    const matchMedia = ((query: string) => ({
      matches: query === TABLET_LANDSCAPE_MEDIA_QUERY,
    })) as typeof globalThis.matchMedia;
    expect(readDeviceTier(matchMedia)).toBe('tablet-landscape');
  });

  it('forces a desktop viewport into the orientation-matching tablet tier', () => {
    const matchMedia = ((query: string) => ({
      matches: query === LANDSCAPE_MEDIA_QUERY,
    })) as typeof globalThis.matchMedia;
    expect(readDeviceTier(matchMedia, true)).toBe('tablet-landscape');
  });
});

describe('source guards: layouts use the shared hook', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
  it('CustomLayout uses useIsMobile, not a media-query literal', () => {
    const src = read('components/CustomLayout.tsx');
    expect(src).toContain('useIsMobile');
    expect(src).not.toContain('max-width: 768px');
  });
  it('WorkspaceLayout uses useIsMobile, not a media-query literal', () => {
    const src = read('components/workspace/WorkspaceLayout.tsx');
    expect(src).toContain('useIsMobile');
    expect(src).not.toContain('max-width: 768px');
  });
});
