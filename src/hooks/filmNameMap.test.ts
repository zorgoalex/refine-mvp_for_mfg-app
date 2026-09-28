import { describe, expect, it } from 'vitest';
import { missingFilmIds } from './filmNameMap';

describe('missingFilmIds', () => {
  it('returns unique sorted ids absent from the active-name map', () => {
    const names = new Map([[1, 'Белый Снег; Алимжан AIF'], [5, 'Крем брюле; FocusPrime']]);
    expect(missingFilmIds(names, [5, 9, null, 3, 9, undefined, 1, 0, -2])).toEqual([3, 9]);
  });

  it('caps the request size', () => {
    const ids = Array.from({ length: 700 }, (_v, index) => index + 1);
    expect(missingFilmIds(new Map(), ids)).toHaveLength(500);
  });
});
