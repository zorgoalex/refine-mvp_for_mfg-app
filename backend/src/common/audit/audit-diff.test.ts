import { describe, expect, it } from 'vitest';
import { computeDiff, computeListDiff } from './audit-diff';

describe('computeDiff', () => {
  it('returns only changed top-level fields as {from,to}', () => {
    expect(computeDiff({ a: 1, b: 'x' }, { a: 2, b: 'x' })).toEqual({ a: { from: 1, to: 2 } });
  });
  it('treats deep-equal values as unchanged', () => {
    expect(computeDiff({ a: { n: 1 } }, { a: { n: 1 } })).toEqual({});
  });
  it('captures added and removed keys with null on the missing side', () => {
    expect(computeDiff({ a: 1 }, { a: 1, b: 2 })).toEqual({ b: { from: null, to: 2 } });
    expect(computeDiff({ a: 1, c: 3 }, { a: 1 })).toEqual({ c: { from: 3, to: null } });
  });
  it('returns {} when nothing changed', () => {
    expect(computeDiff({ a: 1 }, { a: 1 })).toEqual({});
  });
  it('tolerates null/undefined inputs', () => {
    expect(computeDiff(null, { a: 1 })).toEqual({ a: { from: null, to: 1 } });
    expect(computeDiff({ a: 1 }, null)).toEqual({ a: { from: 1, to: null } });
    expect(computeDiff(null, null)).toEqual({});
  });
  it('treats an explicit undefined value the same as a missing/null key (no diff)', () => {
    expect(computeDiff({ a: undefined }, { a: null })).toEqual({});
    expect(computeDiff({ a: undefined }, {})).toEqual({});
  });
});

describe('computeListDiff', () => {
  it('diffs by key into added/removed', () => {
    const before = [{ id: 1 }, { id: 2 }];
    const after = [{ id: 2 }, { id: 3 }];
    expect(computeListDiff(before, after, (x) => String(x.id))).toEqual({
      added: [{ id: 3 }],
      removed: [{ id: 1 }],
    });
  });
});
