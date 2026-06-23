import { describe, it, expect } from 'vitest';
import { buildCutJobByDetailId, cutJobDeepLink } from './cutColumnHelpers';

describe('cutColumnHelpers', () => {
  it('buildCutJobByDetailId maps each detail to its ref', () => {
    const map = buildCutJobByDetailId([
      { orderDetailId: 1, cutJobId: 9, name: 'A' },
      { orderDetailId: 2, cutJobId: 9, name: 'A' },
    ]);
    expect(map.get(1)?.cutJobId).toBe(9);
    expect(map.get(2)?.name).toBe('A');
    expect(map.has(3)).toBe(false);
  });

  it('cutJobDeepLink builds the /cut?job= path', () => {
    expect(cutJobDeepLink(45)).toBe('/cut?job=45');
  });
});
