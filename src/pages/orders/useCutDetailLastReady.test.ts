import { describe, expect, it } from 'vitest';
import { normalizeCutDetailIds } from './useCutDetailLastReady';

describe('normalizeCutDetailIds', () => {
  it('keeps unique positive persisted detail ids only', () => {
    expect(normalizeCutDetailIds(['2', 1, 2, 0, -1, null, 3.5, undefined])).toEqual([1, 2]);
  });
});
