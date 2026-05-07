import { describe, expect, it } from 'vitest';
import { getDowelingOrderShowPath } from './dowelingOrderPaths';

describe('getDowelingOrderShowPath', () => {
  it('builds the configured doweling order show route', () => {
    expect(getDowelingOrderShowPath(1368)).toBe('/doweling-orders/show/1368');
    expect(getDowelingOrderShowPath('1368')).toBe('/doweling-orders/show/1368');
  });

  it('does not build a route for missing or invalid ids', () => {
    expect(getDowelingOrderShowPath(undefined)).toBeNull();
    expect(getDowelingOrderShowPath(null)).toBeNull();
    expect(getDowelingOrderShowPath('')).toBeNull();
    expect(getDowelingOrderShowPath('abc')).toBeNull();
    expect(getDowelingOrderShowPath(0)).toBeNull();
  });
});
