import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tierFromMatches, PHONE_MEDIA_QUERY, TABLET_MEDIA_QUERY, COARSE_POINTER_QUERY } from './useDeviceTier';

describe('tierFromMatches', () => {
  it('phone wins over tablet', () => {
    expect(tierFromMatches(true, false)).toBe('phone');
    expect(tierFromMatches(true, true)).toBe('phone');
  });
  it('tablet when only tablet matches', () => {
    expect(tierFromMatches(false, true)).toBe('tablet');
  });
  it('desktop otherwise', () => {
    expect(tierFromMatches(false, false)).toBe('desktop');
  });
});

describe('media query constants', () => {
  it('non-overlapping phone/tablet ranges', () => {
    expect(PHONE_MEDIA_QUERY).toBe('(max-width: 767px)');
    expect(TABLET_MEDIA_QUERY).toBe('(min-width: 768px) and (max-width: 1199px)');
    expect(COARSE_POINTER_QUERY).toBe('(pointer: coarse)');
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
